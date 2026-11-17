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
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func main() {
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
