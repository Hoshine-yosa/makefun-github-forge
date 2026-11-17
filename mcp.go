// MCP over streamable HTTP (JSON-RPC 2.0), modern revision 2026-07-28 with a
// legacy initialize handshake as fallback. Auth is enforced before dispatch
// on every method: no/wrong Authorization is exactly 401. tools/list is
// built once and answered byte-identically every time. Tools act on the
// same store REST reads.
//
// Port of the Node forge's mcp.ts. Same tools, same messages, same
// JSON-RPC shapes.

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

const mcpServerName = "github-core-clone-forge"
const mcpServerVersion = "1.0.0"
const mcpRevision = "2026-07-28"

type mcpToolProp struct {
	Type        string `json:"type"`
	Description string `json:"description"`
}

type mcpToolDef struct {
	Name        string
	Description string
	Properties  map[string]mcpToolProp
	Required    []string
}

var mcpTools = []mcpToolDef{
	{
		Name:        "create_repo",
		Description: "Create a repository owned by the authenticated user.",
		Properties: map[string]mcpToolProp{
			"owner":       {Type: "string", Description: "Owner login"},
			"name":        {Type: "string", Description: "Repository name"},
			"description": {Type: "string", Description: "Repository description"},
			"private":     {Type: "boolean", Description: "Whether the repository is private"},
		},
		Required: []string{"owner", "name"},
	},
	{
		Name:        "get_repo",
		Description: "Get a repository by owner and name.",
		Properties: map[string]mcpToolProp{
			"owner": {Type: "string", Description: "Owner login"},
			"repo":  {Type: "string", Description: "Repository name"},
		},
		Required: []string{"owner", "repo"},
	},
	{
		Name:        "create_issue",
		Description: "Create an issue in a repository.",
		Properties: map[string]mcpToolProp{
			"owner": {Type: "string", Description: "Owner login"},
			"repo":  {Type: "string", Description: "Repository name"},
			"title": {Type: "string", Description: "Issue title"},
			"body":  {Type: "string", Description: "Issue body"},
		},
		Required: []string{"owner", "repo", "title"},
	},
	{
		Name:        "list_issues",
		Description: "List issues in a repository.",
		Properties: map[string]mcpToolProp{
			"owner": {Type: "string", Description: "Owner login"},
			"repo":  {Type: "string", Description: "Repository name"},
			"state": {Type: "string", Description: "Issue state: open, closed or all"},
		},
		Required: []string{"owner", "repo"},
	},
	{
		Name:        "create_pull_request",
		Description: "Create a pull request from a head branch into a base branch.",
		Properties: map[string]mcpToolProp{
			"owner": {Type: "string", Description: "Owner login"},
			"repo":  {Type: "string", Description: "Repository name"},
			"title": {Type: "string", Description: "Pull request title"},
			"body":  {Type: "string", Description: "Pull request body"},
			"head":  {Type: "string", Description: "Head branch name"},
			"base":  {Type: "string", Description: "Base branch name"},
		},
		Required: []string{"owner", "repo", "title", "head", "base"},
	},
	{
		Name:        "merge_pull_request",
		Description: "Merge a pull request with a squash merge.",
		Properties: map[string]mcpToolProp{
			"owner":       {Type: "string", Description: "Owner login"},
			"repo":        {Type: "string", Description: "Repository name"},
			"pull_number": {Type: "number", Description: "Pull request number"},
		},
		Required: []string{"owner", "repo", "pull_number"},
	},
}

// mcpToolsList is the tools/list answer, built once; mcpToolsListJSON is its
// single marshaling, reused verbatim on every tools/list call.
var mcpToolsList = func() []interface{} {
	list := make([]interface{}, 0, len(mcpTools))
	for _, t := range mcpTools {
		list = append(list, map[string]interface{}{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": t.Properties,
				"required":   t.Required,
			},
		})
	}
	return list
}()

var mcpToolsListJSON []byte

func init() {
	b, err := json.Marshal(mcpToolsList)
	if err != nil {
		b = []byte("[]")
	}
	mcpToolsListJSON = b
}

func mcpNormalizeName(name string) string {
	lower := strings.ToLower(name)
	var b strings.Builder
	for i := 0; i < len(lower); i++ {
		c := lower[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			b.WriteByte(c)
		}
	}
	return b.String()
}

func mcpFindTool(name string) *mcpToolDef {
	want := mcpNormalizeName(name)
	for i := range mcpTools {
		if mcpNormalizeName(mcpTools[i].Name) == want {
			return &mcpTools[i]
		}
	}
	for i := range mcpTools {
		n := mcpNormalizeName(mcpTools[i].Name)
		if len(n) > len(want) && strings.HasSuffix(n, want) {
			return &mcpTools[i]
		}
	}
	return nil
}

func mcpToolResult(obj map[string]interface{}) map[string]interface{} {
	text, err := json.Marshal(obj)
	if err != nil {
		text = []byte("{}")
	}
	return map[string]interface{}{
		"content": []interface{}{
			map[string]interface{}{"type": "text", "text": string(text)},
		},
		"structuredContent": obj,
		"isError":           false,
	}
}

func mcpToolError(message string) map[string]interface{} {
	return map[string]interface{}{
		"content": []interface{}{
			map[string]interface{}{"type": "text", "text": message},
		},
		"isError": true,
	}
}

// mcpStr returns v when it is a string, else "".
func mcpStr(v interface{}) string {
	s, _ := v.(string)
	return s
}

var mcpDigitsRe = regexp.MustCompile(`^\d+$`)
var mcpVersionRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// mcpNum mirrors the Node asNum: a safe integer number, or a digit string.
func mcpNum(v interface{}) (int, bool) {
	switch t := v.(type) {
	case float64:
		if t == math.Trunc(t) && math.Abs(t) <= 9007199254740991 {
			return int(t), true
		}
		return 0, false
	case string:
		if mcpDigitsRe.MatchString(t) {
			n, err := strconv.Atoi(t)
			if err != nil {
				return 0, false
			}
			return n, true
		}
		return 0, false
	default:
		return 0, false
	}
}

type mcpToolOutcome struct {
	ok      bool
	result  map[string]interface{}
	errCode int
	errMsg  string
}

func mcpCallTool(store *Store, name string, args map[string]interface{}) mcpToolOutcome {
	tool := mcpFindTool(name)
	if tool == nil {
		return mcpToolOutcome{ok: false, errCode: -32602, errMsg: "Unknown tool: " + name}
	}
	// Required-argument validation (the missing-arguments check sends {}).
	var missing []string
	for _, req := range tool.Required {
		v, present := args[req]
		if !present || v == nil {
			missing = append(missing, req)
			continue
		}
		if s, isStr := v.(string); isStr && s == "" {
			missing = append(missing, req)
		}
	}
	if len(missing) > 0 {
		return mcpToolOutcome{ok: false, errCode: -32602, errMsg: "Missing required arguments: " + strings.Join(missing, ", ")}
	}

	switch tool.Name {
	case "create_repo":
		repoName := mcpStr(args["name"])
		if repoName == "" {
			return mcpToolOutcome{ok: true, result: mcpToolError("Repository name is required")}
		}
		repo, duplicate := store.CreateRepo(repoName, args["private"] == true, mcpStr(args["description"]))
		if duplicate || repo == nil {
			return mcpToolOutcome{ok: true, result: mcpToolError("Repository " + repoName + " already exists")}
		}
		return mcpToolOutcome{ok: true, result: mcpToolResult(map[string]interface{}{
			"id": repo.ID, "name": repo.Name, "full_name": repo.Owner + "/" + repo.Name,
			"private": repo.Private, "description": repo.Description, "default_branch": repo.DefaultBranch,
		})}
	case "get_repo":
		owner, repoName := mcpStr(args["owner"]), mcpStr(args["repo"])
		repo := store.GetRepo(owner, repoName)
		if repo == nil {
			return mcpToolOutcome{ok: true, result: mcpToolError("Repository " + owner + "/" + repoName + " not found")}
		}
		return mcpToolOutcome{ok: true, result: mcpToolResult(map[string]interface{}{
			"id": repo.ID, "name": repo.Name, "full_name": repo.Owner + "/" + repo.Name,
			"private": repo.Private, "description": repo.Description, "default_branch": repo.DefaultBranch,
		})}
	case "create_issue":
		owner, repoName := mcpStr(args["owner"]), mcpStr(args["repo"])
		repo := store.GetRepo(owner, repoName)
		if repo == nil {
			return mcpToolOutcome{ok: true, result: mcpToolError("Repository " + owner + "/" + repoName + " not found")}
		}
		issue := store.CreateIssue(repo, mcpStr(args["title"]), mcpStr(args["body"]), []string{})
		if issue == nil {
			return mcpToolOutcome{ok: true, result: mcpToolError("Could not create the issue")}
		}
		return mcpToolOutcome{ok: true, result: mcpToolResult(map[string]interface{}{
			"id": issue.ID, "number": issue.Number, "title": issue.Title,
			"body": issue.Body, "state": issue.State, "full_name": repo.Owner + "/" + repo.Name,
		})}
	case "list_issues":
		owner, repoName := mcpStr(args["owner"]), mcpStr(args["repo"])
		repo := store.GetRepo(owner, repoName)
		if repo == nil {
			return mcpToolOutcome{ok: true, result: mcpToolError("Repository " + owner + "/" + repoName + " not found")}
		}
		state := mcpStr(args["state"])
		if state == "" {
			state = "open"
		}
		list := store.ListIssues(repo, state, "created", "asc")
		issues := make([]interface{}, 0, len(list))
		for _, iss := range list {
			issues = append(issues, map[string]interface{}{
				"id": iss.ID, "number": iss.Number, "title": iss.Title, "body": iss.Body, "state": iss.State,
			})
		}
		return mcpToolOutcome{ok: true, result: mcpToolResult(map[string]interface{}{"issues": issues})}
	case "create_pull_request":
		owner, repoName := mcpStr(args["owner"]), mcpStr(args["repo"])
		repo := store.GetRepo(owner, repoName)
		if repo == nil {
			return mcpToolOutcome{ok: true, result: mcpToolError("Repository " + owner + "/" + repoName + " not found")}
		}
		pull := store.CreatePull(repo, mcpStr(args["title"]), mcpStr(args["body"]), mcpStr(args["head"]), mcpStr(args["base"]))
		if pull == nil {
			return mcpToolOutcome{ok: true, result: mcpToolError("Could not create the pull request: unknown head or base branch")}
		}
		return mcpToolOutcome{ok: true, result: mcpToolResult(map[string]interface{}{
			"id": pull.ID, "number": pull.Number, "title": pull.Title,
			"body": pull.Body, "state": pull.State, "head": pull.HeadRef, "base": pull.BaseRef,
		})}
	case "merge_pull_request":
		owner, repoName := mcpStr(args["owner"]), mcpStr(args["repo"])
		repo := store.GetRepo(owner, repoName)
		if repo == nil {
			return mcpToolOutcome{ok: true, result: mcpToolError("Repository " + owner + "/" + repoName + " not found")}
		}
		num, ok := mcpNum(args["pull_number"])
		if !ok {
			return mcpToolOutcome{ok: false, errCode: -32602, errMsg: "pull_number must be an integer"}
		}
		result := store.MergePull(repo, num)
		if result.Status == 404 {
			return mcpToolOutcome{ok: true, result: mcpToolError(fmt.Sprintf("Pull request #%d not found", num))}
		}
		if result.Status == 405 {
			return mcpToolOutcome{ok: true, result: mcpToolError(fmt.Sprintf("Pull request #%d has a merge conflict", num))}
		}
		return mcpToolOutcome{ok: true, result: mcpToolResult(map[string]interface{}{
			"number": num, "merged": true, "state": "closed", "sha": result.Sha,
		})}
	default:
		return mcpToolOutcome{ok: false, errCode: -32602, errMsg: "Unknown tool: " + name}
	}
}

func mcpParseError() map[string]interface{} {
	return map[string]interface{}{
		"jsonrpc": "2.0", "id": nil,
		"error": map[string]interface{}{"code": -32700, "message": "Parse error"},
	}
}

func mcpWriteEmpty(w http.ResponseWriter, status int, headers map[string]string) {
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(status)
}

// handleMcp handles one POST /mcp request (and tolerates DELETE for legacy session teardown).
func handleMcp(w http.ResponseWriter, r *http.Request, store *Store) {
	// MCP is never concurrent in the trials; take the write lock for the
	// whole handler (tools mutate the store) to cover direct repo access.
	repoMu.Lock()
	defer repoMu.Unlock()

	reqID := store.NextRequestId()
	headers := map[string]string{"x-github-request-id": reqID}
	if r.Method == "DELETE" {
		mcpWriteEmpty(w, 200, headers)
		return
	}
	if r.Method != "POST" {
		sendJSON(w, 405, map[string]interface{}{"message": "Method Not Allowed"}, headers)
		return
	}

	// Auth before dispatch, on every method.
	if !authed(r, store) {
		sendJSON(w, 401, map[string]interface{}{"message": "Bad credentials"}, headers)
		return
	}

	buf, err := readBody(r)
	if err != nil {
		sendJSON(w, 400, mcpParseError(), headers)
		return
	}
	var body interface{}
	if err := json.Unmarshal(buf, &body); err != nil {
		sendJSON(w, 400, mcpParseError(), headers)
		return
	}
	rpc, isObj := body.(map[string]interface{})
	if body == nil || !isObj {
		sendJSON(w, 400, mcpParseError(), headers)
		return
	}
	id, hasID := rpc["id"]
	method, _ := rpc["method"].(string)
	params, _ := rpc["params"].(map[string]interface{})
	if params == nil {
		params = make(map[string]interface{})
	}

	// A notification (no id) gets no JSON-RPC response.
	isNotification := !hasID

	result := func(value interface{}) {
		if isNotification {
			mcpWriteEmpty(w, 202, headers)
			return
		}
		sendJSON(w, 200, map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": value}, headers)
	}
	rpcErr := func(code int, message string) {
		if isNotification {
			mcpWriteEmpty(w, 202, headers)
			return
		}
		sendJSON(w, 200, map[string]interface{}{
			"jsonrpc": "2.0", "id": id,
			"error": map[string]interface{}{"code": code, "message": message},
		}, headers)
	}

	switch method {
	case "server/discover":
		result(map[string]interface{}{
			"supportedVersions": []interface{}{mcpRevision, "2025-11-25", "2025-06-18"},
			"serverInfo":        map[string]interface{}{"name": mcpServerName, "version": mcpServerVersion},
			"capabilities":      map[string]interface{}{"tools": map[string]interface{}{}},
			"_meta": map[string]interface{}{
				"io.modelcontextprotocol/serverInfo": map[string]interface{}{"name": mcpServerName, "version": mcpServerVersion},
			},
		})
		return
	case "initialize":
		offered, _ := params["protocolVersion"].(string)
		if offered == "" {
			offered = mcpRevision
		}
		version := mcpRevision
		if mcpVersionRe.MatchString(offered) {
			version = offered
		}
		result(map[string]interface{}{
			"protocolVersion": version,
			"capabilities":    map[string]interface{}{"tools": map[string]interface{}{}},
			"serverInfo":      map[string]interface{}{"name": mcpServerName, "version": mcpServerVersion},
		})
		return
	case "notifications/initialized":
		mcpWriteEmpty(w, 202, headers)
		return
	case "tools/list":
		result(map[string]interface{}{"tools": json.RawMessage(mcpToolsListJSON)})
		return
	case "tools/call":
		name, _ := params["name"].(string)
		args, _ := params["arguments"].(map[string]interface{})
		if args == nil {
			args = make(map[string]interface{})
		}
		outcome := mcpCallTool(store, name, args)
		if !outcome.ok {
			rpcErr(outcome.errCode, outcome.errMsg)
			return
		}
		result(outcome.result)
		return
	case "ping":
		result(map[string]interface{}{})
		return
	default:
		rpcErr(-32601, "Method not found: "+method)
		return
	}
}
