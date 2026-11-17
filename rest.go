// REST v3 handlers (/api/v3). Port of the Node forge's rest.ts: same routes,
// statuses, shapes, pagination (Link rel="next"), auth (401), foreign owner
// (404, never 403), duplicate repo (422), contents 201/200/409, squash
// merge 200/404/405. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors carry {"message": ...}.
//
// Deterministic: no wall clock, no randomness. Map iteration that affects
// output order is sorted (repos by id, labels and directory children by
// name). The handler never panics: an unexpected error becomes a 500 JSON
// reply, and it never writes HTML.

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

const jsonContentType = "application/json; charset=utf-8"

const maxBodyBytes = 10 * 1024 * 1024

// sendJSON writes one JSON reply. Status 204 writes headers only, no body.
// Otherwise the body is marshalled with HTML escaping disabled (matching
// Node's JSON.stringify), a trailing newline is appended, and content-type
// and content-length are set along with the given headers.
func sendJSON(w http.ResponseWriter, status int, body interface{}, headers map[string]string) {
	if status != 204 {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(body); err != nil {
			// Unreachable for the shapes we build; keep a JSON reply anyway.
			text := "{\"message\":\"internal error\"}\n"
			for k, v := range headers {
				w.Header().Set(k, v)
			}
			w.Header().Set("Content-Type", jsonContentType)
			w.Header().Set("Content-Length", strconv.Itoa(len(text)))
			w.WriteHeader(500)
			_, _ = w.Write([]byte(text))
			return
		}
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", jsonContentType)
		w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
		w.WriteHeader(status)
		_, _ = w.Write(buf.Bytes())
		return
	}
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(status)
}

// readBody reads the whole request body, up to 10 MB; it returns an error
// when the body is larger or the read fails.
func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return []byte{}, nil
	}
	defer r.Body.Close()
	buf, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(buf) > maxBodyBytes {
		return nil, fmt.Errorf("body too large")
	}
	return buf, nil
}

// parseJSON parses a JSON body; an empty body parses as an empty object.
// It returns false on malformed JSON.
func parseJSON(buf []byte) (interface{}, bool) {
	if len(buf) == 0 {
		return map[string]interface{}{}, true
	}
	var v interface{}
	if err := json.Unmarshal(buf, &v); err != nil {
		return nil, false
	}
	return v, true
}

func asRecord(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return map[string]interface{}{}
}

func asString(v interface{}, fallback string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fallback
}

func asBool(v interface{}, fallback bool) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return fallback
}

func repoJson(store *Store, repo *Repo) map[string]interface{} {
	return map[string]interface{}{
		"id":        repo.ID,
		"node_id":   store.GlobalId("repo", repo.ID, 0, 0),
		"name":      repo.Name,
		"full_name": fmt.Sprintf("%s/%s", repo.Owner, repo.Name),
		"owner": map[string]interface{}{
			"login": repo.Owner,
			"id":    1000,
			"type":  "User",
		},
		"private":        repo.Private,
		"description":    repo.Description,
		"default_branch": repo.DefaultBranch,
		"html_url":       fmt.Sprintf("https://example.invalid/%s/%s", repo.Owner, repo.Name),
		"url":            fmt.Sprintf("/api/v3/repos/%s/%s", repo.Owner, repo.Name),
		"created_at":     store.NowIso,
		"updated_at":     store.NowIso,
		"pushed_at":      store.NowIso,
		"has_issues":     true,
		"has_projects":   true,
		"has_wiki":       true,
	}
}

func issueJson(store *Store, repo *Repo, issue *Issue) map[string]interface{} {
	labels := make([]interface{}, 0, len(issue.Labels))
	for _, name := range issue.Labels {
		color := "ededed"
		if l, ok := repo.Labels[name]; ok && l != nil {
			color = l.Color
		}
		labels = append(labels, map[string]interface{}{"name": name, "color": color})
	}
	return map[string]interface{}{
		"id":      issue.ID,
		"node_id": store.GlobalId("issue", repo.ID, issue.Number, 0),
		"number":  issue.Number,
		"title":   issue.Title,
		"body":    issue.Body,
		"state":   issue.State,
		"labels":  labels,
		"user": map[string]interface{}{
			"login": store.Viewer,
			"id":    1000,
			"type":  "User",
		},
		"comments":   len(issue.Comments),
		"created_at": store.NowIso,
		"updated_at": store.NowIso,
		"html_url":   fmt.Sprintf("https://example.invalid/%s/%s/issues/%d", repo.Owner, repo.Name, issue.Number),
		"url":        fmt.Sprintf("/api/v3/repos/%s/%s/issues/%d", repo.Owner, repo.Name, issue.Number),
	}
}

func pullJson(store *Store, repo *Repo, pull *Pull) map[string]interface{} {
	var mergedAt interface{}
	if pull.MergedAt != "" {
		mergedAt = pull.MergedAt
	}
	var mergeSha interface{}
	if pull.MergeSha != "" {
		mergeSha = pull.MergeSha
	}
	return map[string]interface{}{
		"id":      pull.ID,
		"node_id": store.GlobalId("pull", repo.ID, pull.Number, 0),
		"number":  pull.Number,
		"title":   pull.Title,
		"body":    pull.Body,
		"state":   pull.State,
		"head": map[string]interface{}{
			"ref":   pull.HeadRef,
			"sha":   pull.HeadSha,
			"label": fmt.Sprintf("%s:%s", repo.Owner, pull.HeadRef),
		},
		"base": map[string]interface{}{
			"ref":   pull.BaseRef,
			"sha":   pull.BaseSha,
			"label": fmt.Sprintf("%s:%s", repo.Owner, pull.BaseRef),
		},
		"merged":           pull.Merged,
		"merged_at":        mergedAt,
		"merge_commit_sha": mergeSha,
		"mergeable":        !pull.Merged,
		"user": map[string]interface{}{
			"login": store.Viewer,
			"id":    1000,
			"type":  "User",
		},
		"created_at": store.NowIso,
		"updated_at": store.NowIso,
		"html_url":   fmt.Sprintf("https://example.invalid/%s/%s/pull/%d", repo.Owner, repo.Name, pull.Number),
		"url":        fmt.Sprintf("/api/v3/repos/%s/%s/pulls/%d", repo.Owner, repo.Name, pull.Number),
	}
}

// jsParseInt mimics JavaScript's parseInt(s, 10): leading whitespace and an
// optional sign, then a run of decimal digits; no digits means NaN (false).
// Values that overflow int64 saturate at +/-2^62, which is enough for the
// callers (per_page is clamped, page only slices, and the safe-integer check
// rejects the saturated values).
func jsParseInt(s string) (int64, bool) {
	i := 0
	for i < len(s) && unicode.IsSpace(rune(s[i])) {
		i++
	}
	neg := false
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		neg = s[i] == '-'
		i++
	}
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.ParseInt(s[start:i], 10, 64)
	if err != nil {
		if neg {
			return -(int64(1) << 62), true
		}
		return int64(1) << 62, true
	}
	if neg {
		n = -n
	}
	return n, true
}

// jsSafeInteger reports whether n is a JavaScript safe integer (|n| <= 2^53-1).
func jsSafeInteger(n int64) bool {
	const maxSafe = 9007199254740991
	return n >= -maxSafe && n <= maxSafe
}

// orderedQuery is the request query string kept in order, like
// URLSearchParams: get returns the first value, set replaces the first
// occurrence (dropping later duplicates) or appends.
type orderedQuery struct {
	pairs []queryPair
}

type queryPair struct {
	key, value string
}

func parseOrderedQuery(raw string) orderedQuery {
	var q orderedQuery
	if raw == "" {
		return q
	}
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		key, value := part, ""
		if i := strings.IndexByte(part, '='); i >= 0 {
			key, value = part[:i], part[i+1:]
		}
		if k, err := url.QueryUnescape(key); err == nil {
			key = k
		}
		if v, err := url.QueryUnescape(value); err == nil {
			value = v
		}
		q.pairs = append(q.pairs, queryPair{key, value})
	}
	return q
}

func (q *orderedQuery) get(name string) (string, bool) {
	for _, p := range q.pairs {
		if p.key == name {
			return p.value, true
		}
	}
	return "", false
}

func (q *orderedQuery) set(name, value string) {
	kept := make([]queryPair, 0, len(q.pairs)+1)
	found := false
	for _, p := range q.pairs {
		if p.key == name {
			if !found {
				kept = append(kept, queryPair{name, value})
				found = true
			}
			continue
		}
		kept = append(kept, p)
	}
	if !found {
		kept = append(kept, queryPair{name, value})
	}
	q.pairs = kept
}

func (q *orderedQuery) encode() string {
	var b strings.Builder
	for i, p := range q.pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(p.key))
		b.WriteByte('=')
		b.WriteString(url.QueryEscape(p.value))
	}
	return b.String()
}

func pageOf(q *orderedQuery) (perPage, page int) {
	perPage = 30
	if raw, ok := q.get("per_page"); ok {
		if n, isNum := jsParseInt(raw); isNum && n > 0 {
			perPage = int(n)
			if perPage > 100 {
				perPage = 100
			}
		}
	}
	page = 1
	if raw, ok := q.get("page"); ok {
		if n, isNum := jsParseInt(raw); isNum && n > 0 {
			page = int(n)
		}
	}
	return perPage, page
}

func paginate[T any](items []T, perPage, page int) ([]T, int) {
	totalPages := 1
	if len(items) > 0 {
		totalPages = (len(items) + perPage - 1) / perPage
	}
	start := len(items)
	if page <= len(items)/perPage+1 {
		start = (page - 1) * perPage
	}
	end := start + perPage
	if end > len(items) {
		end = len(items)
	}
	return items[start:end], totalPages
}

func linkHeader(r *http.Request, path string, query *orderedQuery, perPage, page, totalPages int) string {
	host := r.Host
	if host == "" {
		host = "localhost"
	}
	build := func(p int) string {
		q := *query
		q.set("per_page", strconv.Itoa(perPage))
		q.set("page", strconv.Itoa(p))
		return "http://" + host + path + "?" + q.encode()
	}
	var parts []string
	if page < totalPages {
		parts = append(parts, "<"+build(page+1)+">; rel=\"next\"")
	}
	if totalPages > 1 {
		parts = append(parts, "<"+build(totalPages)+">; rel=\"last\"")
	}
	if page > 1 {
		parts = append(parts, "<"+build(1)+">; rel=\"first\"")
		parts = append(parts, "<"+build(page-1)+">; rel=\"prev\"")
	}
	return strings.Join(parts, ", ")
}

// authed checks the Bearer token: it must equal the store token, or be any
// non-empty token when no token is configured.
func authed(r *http.Request, store *Store) bool {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	token := auth[len("Bearer "):]
	if token == "" {
		return false
	}
	if store.Token == "" {
		return true
	}
	return token == store.Token
}

// decodeBase64Lenient decodes like Node's Buffer.from(s, 'base64'):
// characters outside the base64 alphabet are ignored and padding is
// optional, so malformed input yields bytes (possibly empty) rather than an
// error.
func decodeBase64Lenient(s string) []byte {
	filtered := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' {
			filtered = append(filtered, c)
		}
	}
	// A trailing quantum of a single character carries no bits; Node drops it.
	if len(filtered)%4 == 1 {
		filtered = filtered[:len(filtered)-1]
	}
	out, err := base64.RawStdEncoding.DecodeString(string(filtered))
	if err != nil {
		return []byte{}
	}
	return out
}

// dirTreeSha is the tree sha of a subdirectory, rebuilt from the flat tree
// map (deterministic).
func dirTreeSha(repo *Repo, tree map[string]TreeEntry, dirPath string) string {
	sub := map[string]string{}
	prefix := dirPath + "/"
	for p, e := range tree {
		if strings.HasPrefix(p, prefix) {
			sub[p[len(prefix):]] = e.Sha
		}
	}
	return BuildTree(repo.Objects, sub)
}

// handleRest handles one /api/v3 request. It always sends a response.
func handleRest(w http.ResponseWriter, r *http.Request, store *Store) {
	reqID := store.NextRequestId()
	baseHeaders := map[string]string{
		"x-github-request-id": reqID,
		"x-oauth-scopes":      "repo, read:org",
	}
	wrote := false
	defer func() {
		if rec := recover(); rec != nil && !wrote {
			sendJSON(w, 500, map[string]interface{}{"message": fmt.Sprintf("%v", rec)}, baseHeaders)
		}
	}()

	// Serialize direct repo-map access (repo.Labels / repo.Refs / repo.Objects
	// reads bypass the Store mutex): reads take RLock, writes take Lock.
	// REST traffic is sequential in the trials, so this costs nothing.
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		repoMu.RLock()
		defer repoMu.RUnlock()
	} else {
		repoMu.Lock()
		defer repoMu.Unlock()
	}

	errReply := func(status int, message string) {
		sendJSON(w, status, map[string]interface{}{"message": message}, baseHeaders)
		wrote = true
	}
	ok := func(status int, body interface{}, extra map[string]string) {
		headers := make(map[string]string, len(baseHeaders)+len(extra))
		for k, v := range baseHeaders {
			headers[k] = v
		}
		for k, v := range extra {
			headers[k] = v
		}
		sendJSON(w, status, body, headers)
		wrote = true
	}

	// Auth first: every /api/v3 call needs the token.
	if !authed(r, store) {
		errReply(401, "Bad credentials")
		return
	}

	method := r.Method

	// Read + parse a JSON body for methods that carry one.
	var body interface{} = map[string]interface{}{}
	if method == "POST" || method == "PUT" || method == "PATCH" || method == "DELETE" {
		buf, readErr := readBody(r)
		if readErr != nil {
			errReply(500, readErr.Error())
			return
		}
		parsed, parsedOK := parseJSON(buf)
		if !parsedOK {
			errReply(400, "Problems parsing JSON")
			return
		}
		body = parsed
	}
	b := asRecord(body)

	// Path segments after /api/v3, split on the raw (still-encoded) path and
	// decoded one segment at a time, like Node's split + decodeURIComponent.
	rawPath := r.URL.EscapedPath()
	var parts []string
	for _, p := range strings.Split(rawPath, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) > 2 {
		parts = parts[2:]
	} else {
		parts = parts[:0]
	}
	seg := func(i int) string {
		if i < 0 || i >= len(parts) {
			return ""
		}
		if d, err := url.PathUnescape(parts[i]); err == nil {
			return d
		}
		return parts[i]
	}
	query := parseOrderedQuery(r.URL.RawQuery)
	pathname := rawPath

	// GET /api/v3/ (root) and /api/v3 (no slash)
	if len(parts) == 0 {
		if method == "GET" {
			ok(200, map[string]interface{}{
				"current_user_url": "/api/v3/user",
				"rate_limit_url":   "/api/v3/rate_limit",
			}, nil)
			return
		}
		errReply(404, "Not Found")
		return
	}
	// GET /api/v3/meta
	if len(parts) == 1 && parts[0] == "meta" {
		if method == "GET" {
			ok(200, map[string]interface{}{"installed_version": "1.0.0"}, nil)
			return
		}
		errReply(404, "Not Found")
		return
	}
	// GET /api/v3/user
	if len(parts) == 1 && parts[0] == "user" && method == "GET" {
		ok(200, map[string]interface{}{
			"login": store.Viewer,
			"id":    1000,
			"type":  "User",
			"name":  store.Viewer,
			"email": store.Viewer + "@example.invalid",
		}, nil)
		return
	}
	// GET/POST /api/v3/user/repos
	if len(parts) == 2 && parts[0] == "user" && parts[1] == "repos" {
		if method == "GET" {
			perPage, page := pageOf(&query)
			repos := store.ListRepos()
			sort.Slice(repos, func(i, j int) bool { return repos[i].ID < repos[j].ID })
			pageItems, totalPages := paginate(repos, perPage, page)
			items := make([]interface{}, 0, len(pageItems))
			for _, repo := range pageItems {
				items = append(items, repoJson(store, repo))
			}
			extra := map[string]string{}
			if link := linkHeader(r, pathname, &query, perPage, page, totalPages); link != "" {
				extra["link"] = link
			}
			ok(200, items, extra)
			return
		}
		if method == "POST" {
			name := asString(b["name"], "")
			if name == "" {
				errReply(422, "Repository name is required")
				return
			}
			repo, duplicate := store.CreateRepo(name, asBool(b["private"], false), asString(b["description"], ""))
			if duplicate {
				errReply(422, "Repository already exists")
				return
			}
			ok(201, repoJson(store, repo), nil)
			return
		}
		errReply(404, "Not Found")
		return
	}

	// /api/v3/repos/{owner}/{repo}[...]
	if len(parts) >= 3 && parts[0] == "repos" {
		owner := seg(1)
		name := seg(2)
		repo := store.GetRepo(owner, name)
		if repo == nil {
			errReply(404, "Not Found")
			return
		}
		rest := parts[3:]
		decodeSegs := func(segs []string) []string {
			out := make([]string, 0, len(segs))
			for _, s := range segs {
				if d, err := url.PathUnescape(s); err == nil {
					out = append(out, d)
				} else {
					out = append(out, s)
				}
			}
			return out
		}

		// /repos/{o}/{r}
		if len(rest) == 0 {
			if method == "GET" {
				ok(200, repoJson(store, repo), nil)
				return
			}
			if method == "PATCH" {
				if desc, isStr := b["description"].(string); isStr {
					repo.Description = desc
				}
				ok(200, repoJson(store, repo), nil)
				return
			}
			if method == "DELETE" {
				store.DeleteRepo(owner, name)
				ok(204, nil, nil)
				return
			}
			errReply(404, "Not Found")
			return
		}

		// /repos/{o}/{r}/branches
		if rest[0] == "branches" {
			if len(rest) == 1 && method == "GET" {
				branches := store.ListBranches(repo)
				items := make([]interface{}, 0, len(branches))
				for _, br := range branches {
					items = append(items, map[string]interface{}{
						"name":   br.Name,
						"commit": map[string]interface{}{"sha": br.Sha},
					})
				}
				ok(200, items, nil)
				return
			}
			if len(rest) == 2 && method == "GET" {
				for _, br := range store.ListBranches(repo) {
					if br.Name == seg(4) {
						ok(200, map[string]interface{}{
							"name":   br.Name,
							"commit": map[string]interface{}{"sha": br.Sha},
						}, nil)
						return
					}
				}
				errReply(404, "Not Found")
				return
			}
			errReply(404, "Not Found")
			return
		}

		// /repos/{o}/{r}/commits
		if rest[0] == "commits" && len(rest) == 1 && method == "GET" {
			shaParam, _ := query.get("sha")
			commits := store.ListCommits(repo, shaParam)
			items := make([]interface{}, 0, len(commits))
			for _, c := range commits {
				items = append(items, map[string]interface{}{
					"sha":    c.Sha,
					"commit": map[string]interface{}{"message": c.Message},
				})
			}
			ok(200, items, nil)
			return
		}

		// /repos/{o}/{r}/git/refs
		if len(rest) >= 2 && rest[0] == "git" && rest[1] == "refs" {
			if method == "POST" && len(rest) == 2 {
				ref := asString(b["ref"], "")
				sha := asString(b["sha"], "")
				if ref == "" || sha == "" || !store.CreateRef(repo, ref, sha) {
					errReply(422, "Invalid ref or sha")
					return
				}
				ok(201, map[string]interface{}{
					"ref":    ref,
					"object": map[string]interface{}{"sha": sha},
				}, nil)
				return
			}
			if method == "GET" && len(rest) >= 3 {
				// /git/refs/heads/{branch} (branch may contain slashes)
				refPath := strings.Join(decodeSegs(rest[2:]), "/")
				sha, found := repo.Refs[refPath]
				if !found {
					sha, found = repo.Refs["refs/"+refPath]
				}
				if !found {
					errReply(404, "Not Found")
					return
				}
				fullRef := refPath
				if !strings.HasPrefix(refPath, "refs/") {
					fullRef = "refs/" + refPath
				}
				ok(200, map[string]interface{}{
					"ref":    fullRef,
					"object": map[string]interface{}{"sha": sha},
				}, nil)
				return
			}
			errReply(404, "Not Found")
			return
		}

		// /repos/{o}/{r}/contents/{path...}
		if rest[0] == "contents" {
			filePath := strings.Join(decodeSegs(rest[1:]), "/")
			refParam, _ := query.get("ref")
			if method == "PUT" {
				message := asString(b["message"], "Update file")
				contentB64 := asString(b["content"], "")
				branch := asString(b["branch"], repo.DefaultBranch)
				expectedSha := ""
				if s, isStr := b["sha"].(string); isStr {
					expectedSha = s
				}
				content := decodeBase64Lenient(contentB64)
				result := store.CommitFile(repo, branch, filePath, content, message, expectedSha)
				if result.Status == 409 {
					errReply(409, "Conflict: stale sha")
					return
				}
				ok(result.Status, map[string]interface{}{
					"content": map[string]interface{}{"sha": result.BlobSha, "encoding": "base64"},
					"commit":  map[string]interface{}{"sha": result.CommitSha},
				}, nil)
				return
			}
			if method == "GET" {
				tree := store.TreeAt(repo, refParam)
				if tree == nil {
					errReply(404, "Not Found")
					return
				}
				if file, isFile := tree[filePath]; isFile {
					var data []byte
					if obj := repo.Objects[file.Sha]; obj != nil {
						data = obj.Data
					}
					if data == nil {
						data = []byte{}
					}
					fileName := filePath
					if i := strings.LastIndex(filePath, "/"); i >= 0 {
						fileName = filePath[i+1:]
					}
					ok(200, map[string]interface{}{
						"type":     "file",
						"encoding": "base64",
						"content":  base64.StdEncoding.EncodeToString(data),
						"sha":      file.Sha,
						"size":     len(data),
						"name":     fileName,
						"path":     filePath,
					}, nil)
					return
				}
				// Directory listing: immediate children of the prefix.
				prefix := ""
				if filePath != "" {
					prefix = filePath + "/"
				}
				type dirChild struct {
					entryType string
					name      string
					path      string
					sha       string
				}
				children := map[string]dirChild{}
				for p, e := range tree {
					if !strings.HasPrefix(p, prefix) {
						continue
					}
					restPath := p[len(prefix):]
					if restPath == "" {
						continue
					}
					if slash := strings.Index(restPath, "/"); slash == -1 {
						children[restPath] = dirChild{"file", restPath, p, e.Sha}
					} else {
						dirName := restPath[:slash]
						if _, exists := children[dirName]; !exists {
							dirSha := dirTreeSha(repo, tree, prefix+dirName)
							children[dirName] = dirChild{"dir", dirName, prefix + dirName, dirSha}
						}
					}
				}
				if len(children) == 0 {
					errReply(404, "Not Found")
					return
				}
				names := make([]string, 0, len(children))
				for n := range children {
					names = append(names, n)
				}
				sort.Strings(names)
				items := make([]interface{}, 0, len(names))
				for _, n := range names {
					c := children[n]
					items = append(items, map[string]interface{}{
						"type": c.entryType,
						"name": c.name,
						"path": c.path,
						"sha":  c.sha,
					})
				}
				ok(200, items, nil)
				return
			}
			if method == "DELETE" {
				message := asString(b["message"], "Delete file")
				branch := asString(b["branch"], repo.DefaultBranch)
				result := store.DeleteFile(repo, branch, filePath, message)
				if result.Status == 404 {
					errReply(404, "Not Found")
					return
				}
				ok(200, map[string]interface{}{
					"commit": map[string]interface{}{"sha": result.CommitSha},
				}, nil)
				return
			}
			errReply(404, "Not Found")
			return
		}

		// /repos/{o}/{r}/labels
		if rest[0] == "labels" {
			if method == "POST" && len(rest) == 1 {
				name := asString(b["name"], "")
				if name == "" {
					errReply(422, "Label name is required")
					return
				}
				label := store.CreateLabel(repo, name, asString(b["color"], "ededed"))
				ok(201, map[string]interface{}{"name": label.Name, "color": label.Color}, nil)
				return
			}
			if method == "GET" && len(rest) == 1 {
				names := make([]string, 0, len(repo.Labels))
				for n := range repo.Labels {
					names = append(names, n)
				}
				sort.Strings(names)
				items := make([]interface{}, 0, len(names))
				for _, n := range names {
					l := repo.Labels[n]
					items = append(items, map[string]interface{}{"name": l.Name, "color": l.Color})
				}
				ok(200, items, nil)
				return
			}
			errReply(404, "Not Found")
			return
		}

		// /repos/{o}/{r}/issues...
		if rest[0] == "issues" {
			if len(rest) == 1 {
				if method == "POST" {
					title := asString(b["title"], "")
					bodyText := asString(b["body"], "")
					var labels []string
					if arr, isArr := b["labels"].([]interface{}); isArr {
						for _, x := range arr {
							if s, isStr := x.(string); isStr {
								labels = append(labels, s)
							}
						}
					}
					issue := store.CreateIssue(repo, title, bodyText, labels)
					if issue == nil {
						errReply(422, "Unknown label")
						return
					}
					ok(201, issueJson(store, repo, issue), nil)
					return
				}
				if method == "GET" {
					perPage, page := pageOf(&query)
					state, _ := query.get("state")
					sortBy, hasSort := query.get("sort")
					if !hasSort {
						sortBy = "created"
					}
					direction, hasDirection := query.get("direction")
					if !hasDirection {
						direction = "desc"
					}
					list := store.ListIssues(repo, state, sortBy, direction)
					pageItems, totalPages := paginate(list, perPage, page)
					items := make([]interface{}, 0, len(pageItems))
					for _, issue := range pageItems {
						items = append(items, issueJson(store, repo, issue))
					}
					extra := map[string]string{}
					if link := linkHeader(r, pathname, &query, perPage, page, totalPages); link != "" {
						extra["link"] = link
					}
					ok(200, items, extra)
					return
				}
				errReply(404, "Not Found")
				return
			}
			num, numOK := jsParseInt(rest[1])
			if !numOK || !jsSafeInteger(num) {
				errReply(404, "Not Found")
				return
			}
			issueNum := int(num)
			if len(rest) == 2 {
				if method == "GET" {
					issue := store.GetIssue(repo, issueNum)
					if issue == nil {
						errReply(404, "Not Found")
						return
					}
					ok(200, issueJson(store, repo, issue), nil)
					return
				}
				if method == "PATCH" {
					state := ""
					if s, isStr := b["state"].(string); isStr {
						if s == "closed" {
							state = "closed"
						} else if s == "open" {
							state = "open"
						}
					}
					issue := store.PatchIssue(repo, issueNum, state)
					if issue == nil {
						errReply(404, "Not Found")
						return
					}
					ok(200, issueJson(store, repo, issue), nil)
					return
				}
				errReply(404, "Not Found")
				return
			}
			if len(rest) == 3 && rest[2] == "comments" {
				if method == "POST" {
					comment := store.CreateComment(repo, issueNum, asString(b["body"], ""))
					if comment == nil {
						errReply(404, "Not Found")
						return
					}
					ok(201, map[string]interface{}{"id": comment.ID, "body": comment.Body}, nil)
					return
				}
				if method == "GET" {
					comments := store.ListComments(repo, issueNum)
					if comments == nil {
						errReply(404, "Not Found")
						return
					}
					items := make([]interface{}, 0, len(comments))
					for _, c := range comments {
						items = append(items, map[string]interface{}{"id": c.ID, "body": c.Body})
					}
					ok(200, items, nil)
					return
				}
				errReply(404, "Not Found")
				return
			}
			errReply(404, "Not Found")
			return
		}

		// /repos/{o}/{r}/pulls...
		if rest[0] == "pulls" {
			if len(rest) == 1 {
				if method == "POST" {
					pull := store.CreatePull(repo, asString(b["title"], ""), asString(b["body"], ""), asString(b["head"], ""), asString(b["base"], ""))
					if pull == nil {
						errReply(422, "Invalid head or base branch")
						return
					}
					ok(201, pullJson(store, repo, pull), nil)
					return
				}
				if method == "GET" {
					perPage, page := pageOf(&query)
					state, hasState := query.get("state")
					if !hasState {
						state = "open"
					}
					list := store.ListPulls(repo, state)
					pageItems, totalPages := paginate(list, perPage, page)
					items := make([]interface{}, 0, len(pageItems))
					for _, pull := range pageItems {
						items = append(items, pullJson(store, repo, pull))
					}
					extra := map[string]string{}
					if link := linkHeader(r, pathname, &query, perPage, page, totalPages); link != "" {
						extra["link"] = link
					}
					ok(200, items, extra)
					return
				}
				errReply(404, "Not Found")
				return
			}
			num, numOK := jsParseInt(rest[1])
			if !numOK || !jsSafeInteger(num) {
				errReply(404, "Not Found")
				return
			}
			pullNum := int(num)
			if len(rest) == 2 && method == "GET" {
				pull := store.GetPull(repo, pullNum)
				if pull == nil {
					errReply(404, "Not Found")
					return
				}
				ok(200, pullJson(store, repo, pull), nil)
				return
			}
			if len(rest) == 3 && rest[2] == "files" && method == "GET" {
				pull := store.GetPull(repo, pullNum)
				if pull == nil {
					errReply(404, "Not Found")
					return
				}
				items := make([]interface{}, 0, len(pull.Files))
				for _, f := range pull.Files {
					items = append(items, map[string]interface{}{
						"filename":  f.Filename,
						"status":    f.Status,
						"additions": f.Additions,
						"deletions": f.Deletions,
						"changes":   f.Changes,
					})
				}
				ok(200, items, nil)
				return
			}
			if len(rest) == 3 && rest[2] == "merge" && method == "PUT" {
				result := store.MergePull(repo, pullNum)
				if result.Status == 404 {
					errReply(404, "Not Found")
					return
				}
				if result.Status == 405 {
					errReply(405, "Merge conflict")
					return
				}
				ok(200, map[string]interface{}{
					"sha":     result.Sha,
					"merged":  true,
					"message": fmt.Sprintf("Pull request #%d successfully merged", pullNum),
				}, nil)
				return
			}
			errReply(404, "Not Found")
			return
		}
		errReply(404, "Not Found")
		return
	}

	errReply(404, "Not Found")
}
