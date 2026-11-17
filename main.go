// The forge's Go server: one in-memory store, four surfaces.
// Routing: /healthz (boot probe, no auth), /api/v3 (REST), /api/graphql,
// /mcp, /<owner>/<repo>.git (git smart HTTP). Everything else: JSON 404.
// Every reply carries a non-empty X-GitHub-Request-Id and is JSON, never HTML.
//
// The listen port comes from FORGE_PORT (set by the Node lifecycle wrapper
// main.ts); it defaults to 18099 for local runs.

package main

import (
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"
)

// cgroupCPULimit returns the CPU count the container's cgroup quota allows
// (rounded up, at least 2), or 0 when there is no quota or it cannot be read.
// Go 1.24 sizes GOMAXPROCS from the host's CPUs, not the quota, so in a
// CPU-limited sandbox the runtime runs far more Ps and GC workers than the
// quota can feed and gets CFS-throttled.
func cgroupCPULimit() int {
	var quota, period float64
	if b, err := os.ReadFile("/sys/fs/cgroup/cpu.max"); err == nil {
		f := strings.Fields(string(b))
		if len(f) == 2 && f[0] != "max" {
			q, e1 := strconv.ParseFloat(f[0], 64)
			p, e2 := strconv.ParseFloat(f[1], 64)
			if e1 == nil && e2 == nil {
				quota, period = q, p
			}
		}
	} else if qb, qerr := os.ReadFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"); qerr == nil {
		if pb, perr := os.ReadFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us"); perr == nil {
			q, e1 := strconv.ParseFloat(strings.TrimSpace(string(qb)), 64)
			p, e2 := strconv.ParseFloat(strings.TrimSpace(string(pb)), 64)
			if e1 == nil && e2 == nil {
				quota, period = q, p
			}
		}
	}
	if quota <= 0 || period <= 0 {
		return 0
	}
	n := int(math.Ceil(quota / period))
	if n < 2 {
		n = 2
	}
	return n
}

// tuneRuntime applies process-level settings that change no output: it caps
// GOMAXPROCS at the cgroup CPU quota, and makes the GC run less often (the
// live heap is a few MB, so the default 100% target collects every ~4 MB of
// allocation). A soft memory limit keeps the larger GC target safe.
func tuneRuntime() {
	if os.Getenv("GOMAXPROCS") == "" {
		if n := cgroupCPULimit(); n > 0 && n < runtime.GOMAXPROCS(0) {
			runtime.GOMAXPROCS(n)
		}
	}
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(400)
	}
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(512 << 20)
	}
}

func main() {
	tuneRuntime()
	port := os.Getenv("FORGE_PORT")
	if port == "" {
		port = "18099"
	}
	store := NewStore()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					// Never crash a request and never answer HTML.
					w.Header().Set("content-type", jsonContentType)
					w.Header().Set("x-github-request-id", store.NextRequestId())
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte("{\"message\":\"Internal Server Error\"}\n"))
				}
			}()
			route(w, r, store)
		}()
	})
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("[forge] listening on port %s", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("[forge] server failed: %v", err)
	}
}

func route(w http.ResponseWriter, r *http.Request, store *Store) {
	path := r.URL.Path
	method := r.Method

	// The env's boot check calls this twice: 200 {"ok":true}. No auth.
	if method == http.MethodGet && path == "/healthz" {
		sendJSON(w, http.StatusOK, map[string]interface{}{"ok": true}, map[string]string{"x-github-request-id": store.NextRequestId()})
		return
	}

	if path == "/api/v3" || strings.HasPrefix(path, "/api/v3/") {
		handleRest(w, r, store)
		return
	}

	if path == "/api/graphql" {
		handleGraphql(w, r, store)
		return
	}

	if path == "/mcp" {
		handleMcp(w, r, store)
		return
	}

	if handleGit(w, r, store) {
		return
	}

	// Everything else, every method: GitHub's 404 body.
	sendJSON(w, http.StatusNotFound, map[string]interface{}{"message": "Not Found"}, map[string]string{"x-github-request-id": store.NextRequestId()})
}

// pathAndQuery splits a request URL into its path and query values.
func pathAndQuery(r *http.Request) (string, url.Values) {
	return r.URL.Path, r.URL.Query()
}
