// GraphQL v4 executor for the exact documents gh and github-mcp-server send.
// A small recursive-descent parser plus a schema-aware resolver over the
// shared store. Unknown fields answer HTTP 200 with an errors array naming
// the field; an unknown repository is data.repository = null with no errors;
// a missing token is exactly 401; a JSON array body is answered in order.
//
// Port of the Node forge's graphql.ts. Same parser, same selections, same
// error strings, same JSON shapes.

package main

import (
	"encoding/base64"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ---------- parser ----------

type gqlValue struct {
	Kind   string // "var" | "string" | "int" | "bool" | "null" | "enum" | "list" | "object"
	Str    string
	Num    float64
	Bool   bool
	Items  []gqlValue
	Fields map[string]gqlValue
}

type gqlSelection struct {
	Alias      string // "" = none
	Name       string
	Args       map[string]gqlValue
	Children   []gqlSelection
	FragmentOn string // "" = none
}

type gqlOperation struct {
	Kind       string // "query" | "mutation"
	Name       string
	Vars       map[string]*gqlValue // parsed variable definitions (defaults unused, as in the Node code)
	Selections []gqlSelection
}

type gqlParser struct {
	pos int
	src string
}

func isGqlNameStart(c byte) bool {
	return c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

func isGqlNameChar(c byte) bool {
	return isGqlNameStart(c) || (c >= '0' && c <= '9')
}

func (p *gqlParser) skipWs() {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' {
			p.pos++
		} else if c == '#' {
			for p.pos < len(p.src) && p.src[p.pos] != '\n' {
				p.pos++
			}
		} else {
			break
		}
	}
}

func (p *gqlParser) peek() byte {
	p.skipWs()
	if p.pos >= len(p.src) {
		return 0
	}
	return p.src[p.pos]
}

func (p *gqlParser) eat(ch byte) bool {
	p.skipWs()
	if p.pos < len(p.src) && p.src[p.pos] == ch {
		p.pos++
		return true
	}
	return false
}

func (p *gqlParser) expect(ch byte) error {
	if !p.eat(ch) {
		return fmt.Errorf("expected %c at %d", ch, p.pos)
	}
	return nil
}

func (p *gqlParser) readName() (string, error) {
	p.skipWs()
	start := p.pos
	if p.pos < len(p.src) && isGqlNameStart(p.src[p.pos]) {
		p.pos++
		for p.pos < len(p.src) && isGqlNameChar(p.src[p.pos]) {
			p.pos++
		}
		return p.src[start:p.pos], nil
	}
	return "", fmt.Errorf("expected name at %d", p.pos)
}

func (p *gqlParser) readString() (string, error) {
	if err := p.expect('"'); err != nil {
		return "", err
	}
	var out strings.Builder
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '"' {
			p.pos++
			return out.String(), nil
		}
		if c == '\\' {
			p.pos++
			if p.pos >= len(p.src) {
				return "", fmt.Errorf("unterminated string")
			}
			e := p.src[p.pos]
			switch e {
			case 'n':
				out.WriteByte('\n')
			case 't':
				out.WriteByte('\t')
			case 'r':
				out.WriteByte('\r')
			default:
				out.WriteByte(e)
			}
			p.pos++
			continue
		}
		out.WriteByte(c)
		p.pos++
	}
	return "", fmt.Errorf("unterminated string")
}

func (p *gqlParser) readNumber() (float64, error) {
	p.skipWs()
	start := p.pos
	if p.pos < len(p.src) && p.src[p.pos] == '-' {
		p.pos++
	}
	digits := 0
	for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
		p.pos++
		digits++
	}
	if digits == 0 {
		return 0, fmt.Errorf("expected number at %d", start)
	}
	if p.pos < len(p.src) && p.src[p.pos] == '.' {
		if p.pos+1 < len(p.src) && p.src[p.pos+1] >= '0' && p.src[p.pos+1] <= '9' {
			p.pos++
			for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
				p.pos++
			}
		}
	}
	n, err := strconv.ParseFloat(p.src[start:p.pos], 64)
	if err != nil {
		return 0, fmt.Errorf("expected number at %d", start)
	}
	return n, nil
}

func (p *gqlParser) parseValue() (gqlValue, error) {
	c := p.peek()
	switch {
	case c == '$':
		p.pos++
		name, err := p.readName()
		if err != nil {
			return gqlValue{}, err
		}
		return gqlValue{Kind: "var", Str: name}, nil
	case c == '"':
		s, err := p.readString()
		if err != nil {
			return gqlValue{}, err
		}
		return gqlValue{Kind: "string", Str: s}, nil
	case c == '[':
		p.pos++
		items := []gqlValue{}
		for !p.eat(']') {
			v, err := p.parseValue()
			if err != nil {
				return gqlValue{}, err
			}
			items = append(items, v)
		}
		return gqlValue{Kind: "list", Items: items}, nil
	case c == '{':
		p.pos++
		fields := map[string]gqlValue{}
		for !p.eat('}') {
			k, err := p.readName()
			if err != nil {
				return gqlValue{}, err
			}
			if err := p.expect(':'); err != nil {
				return gqlValue{}, err
			}
			v, err := p.parseValue()
			if err != nil {
				return gqlValue{}, err
			}
			fields[k] = v
		}
		return gqlValue{Kind: "object", Fields: fields}, nil
	case c == '-' || (c >= '0' && c <= '9'):
		n, err := p.readNumber()
		if err != nil {
			return gqlValue{}, err
		}
		return gqlValue{Kind: "int", Num: n}, nil
	default:
		name, err := p.readName()
		if err != nil {
			return gqlValue{}, err
		}
		switch name {
		case "true":
			return gqlValue{Kind: "bool", Bool: true}, nil
		case "false":
			return gqlValue{Kind: "bool", Bool: false}, nil
		case "null":
			return gqlValue{Kind: "null"}, nil
		default:
			return gqlValue{Kind: "enum", Str: name}, nil
		}
	}
}

func (p *gqlParser) parseArgs() (map[string]gqlValue, error) {
	args := map[string]gqlValue{}
	if !p.eat('(') {
		return args, nil
	}
	for !p.eat(')') {
		k, err := p.readName()
		if err != nil {
			return nil, err
		}
		if err := p.expect(':'); err != nil {
			return nil, err
		}
		v, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		args[k] = v
	}
	return args, nil
}

func (p *gqlParser) parseSelections() ([]gqlSelection, error) {
	if err := p.expect('{'); err != nil {
		return nil, err
	}
	var out []gqlSelection
	for !p.eat('}') {
		if p.pos+3 <= len(p.src) && p.src[p.pos:p.pos+3] == "..." {
			p.pos += 3
			p.skipWs()
			fragmentOn := ""
			if p.pos+2 <= len(p.src) && p.src[p.pos:p.pos+2] == "on" &&
				(p.pos+2 >= len(p.src) || !isGqlNameChar(p.src[p.pos+2])) {
				p.pos += 2
				p.skipWs()
				name, err := p.readName()
				if err != nil {
					return nil, err
				}
				fragmentOn = name
			}
			children, err := p.parseSelections()
			if err != nil {
				return nil, err
			}
			for _, child := range children {
				child.FragmentOn = fragmentOn
				out = append(out, child)
			}
			continue
		}
		first, err := p.readName()
		if err != nil {
			return nil, err
		}
		alias := ""
		name := first
		if p.eat(':') {
			alias = first
			n, err := p.readName()
			if err != nil {
				return nil, err
			}
			name = n
		}
		args, err := p.parseArgs()
		if err != nil {
			return nil, err
		}
		var children []gqlSelection
		if p.peek() == '{' {
			children, err = p.parseSelections()
			if err != nil {
				return nil, err
			}
		}
		out = append(out, gqlSelection{Alias: alias, Name: name, Args: args, Children: children})
	}
	return out, nil
}

func (p *gqlParser) parseDocument() ([]gqlOperation, error) {
	var ops []gqlOperation
	for p.pos < len(p.src) {
		p.skipWs()
		if p.pos >= len(p.src) {
			break
		}
		kind := "query"
		word := p.peek()
		if word == 'q' || word == 'm' {
			name, err := p.readName()
			if err != nil {
				return nil, err
			}
			if name == "mutation" {
				kind = "mutation"
			} else if name != "query" {
				return nil, fmt.Errorf("unexpected %s", name)
			}
		}
		opName := ""
		if c := p.peek(); c != 0 && isGqlNameStart(c) {
			n, err := p.readName()
			if err != nil {
				return nil, err
			}
			opName = n
		}
		vars := map[string]*gqlValue{}
		if p.eat('(') {
			for !p.eat(')') {
				p.eat('$')
				vname, err := p.readName()
				if err != nil {
					return nil, err
				}
				if err := p.expect(':'); err != nil {
					return nil, err
				}
				// Skip the type (may be [X!]! etc.) until '=' or ')'.
				depth := 0
				for p.pos < len(p.src) {
					c := p.src[p.pos]
					if c == '[' || c == '(' {
						depth++
					}
					if c == ']' || c == ')' {
						if depth == 0 {
							break
						}
						depth--
					}
					if c == '=' && depth == 0 {
						break
					}
					p.pos++
				}
				var def *gqlValue
				if p.eat('=') {
					v, err := p.parseValue()
					if err != nil {
						return nil, err
					}
					def = &v
				}
				vars[vname] = def
			}
		}
		sels, err := p.parseSelections()
		if err != nil {
			return nil, err
		}
		ops = append(ops, gqlOperation{Kind: kind, Name: opName, Vars: vars, Selections: sels})
	}
	return ops, nil
}

func gqlResolveValue(v gqlValue, vars map[string]interface{}) interface{} {
	switch v.Kind {
	case "var":
		return vars[v.Str]
	case "string", "enum":
		return v.Str
	case "int":
		return v.Num
	case "bool":
		return v.Bool
	case "null":
		return nil
	case "list":
		out := make([]interface{}, 0, len(v.Items))
		for _, item := range v.Items {
			out = append(out, gqlResolveValue(item, vars))
		}
		return out
	case "object":
		out := make(map[string]interface{}, len(v.Fields))
		for k, val := range v.Fields {
			out[k] = gqlResolveValue(val, vars)
		}
		return out
	default:
		return nil
	}
}

func gqlArgOf(sel gqlSelection, name string, vars map[string]interface{}) interface{} {
	v, ok := sel.Args[name]
	if !ok {
		return nil
	}
	return gqlResolveValue(v, vars)
}

// ---------- schema ----------

var gqlIssueFields = []string{"id", "number", "title", "state", "body", "url", "createdAt", "updatedAt", "author", "labels", "comments"}
var gqlPRFields = []string{"id", "number", "title", "state", "body", "headRefName", "baseRefName", "mergeable", "merged", "files", "url", "createdAt", "updatedAt", "author"}
var gqlRepoFields = []string{"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "url", "description", "isPrivate"}
var gqlSearchEnum = []string{"ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT"}

// ---------- executor ----------

type gqlError struct {
	Message string `json:"message"`
}

type gqlCtx struct {
	store  *Store
	errors []gqlError
}

func (c *gqlCtx) addError(msg string) {
	c.errors = append(c.errors, gqlError{Message: msg})
}

func (c *gqlCtx) fieldError(field, typ string) {
	c.addError(fmt.Sprintf("Cannot query field %q on type %q.", field, typ))
}

func gqlKey(sel gqlSelection) string {
	if sel.Alias != "" {
		return sel.Alias
	}
	return sel.Name
}

// gqlStr returns v when it is a string, else "".
func gqlStr(v interface{}) string {
	s, _ := v.(string)
	return s
}

// gqlNum returns v when it is a JSON number, else ok=false.
func gqlNum(v interface{}) (float64, bool) {
	n, ok := v.(float64)
	return n, ok
}

// gqlObj returns v when it is a JSON object, else nil.
func gqlObj(v interface{}) map[string]interface{} {
	m, _ := v.(map[string]interface{})
	return m
}

// gqlFormatNum formats a JSON number the way JavaScript's String() does for
// the whole/small values this executor stringifies.
func gqlFormatNum(n float64) string {
	if n == math.Trunc(n) && math.Abs(n) < 1e15 {
		return strconv.FormatInt(int64(n), 10)
	}
	return strconv.FormatFloat(n, 'g', -1, 64)
}

// gqlStringify converts a resolved argument value to a string the way
// JavaScript's String() does (nil -> "").
func gqlStringify(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return gqlFormatNum(t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

// gqlSliceLimit mirrors JavaScript's Array.slice(0, n) length clamping.
func gqlSliceLimit(first float64, ok bool, length int) int {
	if !ok {
		return length
	}
	n := int(first)
	if n < 0 {
		n = length + n
		if n < 0 {
			n = 0
		}
	}
	if n > length {
		n = length
	}
	return n
}

func gqlIssueState(state string) string {
	if state == "open" {
		return "OPEN"
	}
	return "CLOSED"
}

func gqlPRState(pull *Pull) string {
	if pull.Merged {
		return "MERGED"
	}
	if pull.State == "open" {
		return "OPEN"
	}
	return "CLOSED"
}

func gqlSelectIssue(ctx *gqlCtx, repo *Repo, issue *Issue, sels []gqlSelection, vars map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{})
	for _, s := range sels {
		key := gqlKey(s)
		switch s.Name {
		case "id":
			out[key] = ctx.store.GlobalId("issue", repo.ID, issue.Number, 0)
		case "number":
			out[key] = issue.Number
		case "title":
			out[key] = issue.Title
		case "state":
			out[key] = gqlIssueState(issue.State)
		case "body":
			out[key] = issue.Body
		default:
			ctx.fieldError(s.Name, "Issue")
		}
	}
	return out
}

func gqlSelectPull(ctx *gqlCtx, repo *Repo, pull *Pull, sels []gqlSelection, vars map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{})
	for _, s := range sels {
		key := gqlKey(s)
		switch s.Name {
		case "id":
			out[key] = ctx.store.GlobalId("pull", repo.ID, pull.Number, 0)
		case "number":
			out[key] = pull.Number
		case "title":
			out[key] = pull.Title
		case "state":
			out[key] = gqlPRState(pull)
		case "body":
			out[key] = pull.Body
		case "headRefName":
			out[key] = pull.HeadRef
		case "baseRefName":
			out[key] = pull.BaseRef
		case "mergeable":
			if pull.Merged {
				out[key] = "UNKNOWN"
			} else {
				out[key] = "MERGEABLE"
			}
		case "merged":
			out[key] = pull.Merged
		case "files":
			first, firstOK := gqlNum(gqlArgOf(s, "first", vars))
			limit := gqlSliceLimit(first, firstOK, len(pull.Files))
			nodes := []interface{}{}
			for _, c := range s.Children {
				if c.Name == "nodes" {
					for _, f := range pull.Files[:limit] {
						nodes = append(nodes, gqlSelectFile(f, c.Children, vars, ctx))
					}
				} else {
					ctx.fieldError(c.Name, "PullRequestChangedFileConnection")
				}
			}
			out[key] = map[string]interface{}{"nodes": nodes}
		default:
			ctx.fieldError(s.Name, "PullRequest")
		}
	}
	return out
}

func gqlSelectFile(f PullFile, sels []gqlSelection, vars map[string]interface{}, ctx *gqlCtx) map[string]interface{} {
	out := make(map[string]interface{})
	for _, s := range sels {
		key := gqlKey(s)
		if s.Name == "path" {
			out[key] = f.Filename
		} else {
			ctx.fieldError(s.Name, "PullRequestChangedFile")
		}
	}
	return out
}

func gqlCursorFor(n int) string {
	return base64.StdEncoding.EncodeToString([]byte("cursor:" + strconv.Itoa(n)))
}

var gqlCursorRe = regexp.MustCompile(`^cursor:(\d+)$`)

func gqlNumberAfter(after interface{}) int {
	s, ok := after.(string)
	if !ok || s == "" {
		return 0
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return 0
	}
	m := gqlCursorRe.FindStringSubmatch(string(raw))
	if m == nil {
		return 0
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0
	}
	return n
}

func gqlSelectRepo(ctx *gqlCtx, repo *Repo, sels []gqlSelection, vars map[string]interface{}) map[string]interface{} {
	store := ctx.store
	out := make(map[string]interface{})
	for _, s := range sels {
		key := gqlKey(s)
		switch s.Name {
		case "id":
			out[key] = store.GlobalId("repo", repo.ID, 0, 0)
		case "databaseId":
			out[key] = repo.ID
		case "name":
			out[key] = repo.Name
		case "nameWithOwner":
			out[key] = repo.Owner + "/" + repo.Name
		case "owner":
			ownerOut := make(map[string]interface{})
			for _, c := range s.Children {
				if c.Name == "login" {
					ownerOut[gqlKey(c)] = repo.Owner
				} else {
					ctx.fieldError(c.Name, "User")
				}
			}
			out[key] = ownerOut
		case "defaultBranchRef":
			refOut := make(map[string]interface{})
			for _, c := range s.Children {
				if c.Name == "name" {
					refOut[gqlKey(c)] = repo.DefaultBranch
				} else {
					ctx.fieldError(c.Name, "Ref")
				}
			}
			out[key] = refOut
		case "viewerPermission":
			out[key] = "ADMIN"
		case "hasIssuesEnabled":
			out[key] = true
		case "issue":
			num, ok := gqlNum(gqlArgOf(s, "number", vars))
			var issue *Issue
			if ok {
				issue = store.GetIssue(repo, int(num))
			}
			if issue != nil {
				out[key] = gqlSelectIssue(ctx, repo, issue, s.Children, vars)
			} else {
				out[key] = nil
			}
		case "issues":
			first, firstOK := gqlNum(gqlArgOf(s, "first", vars))
			statesArg := gqlArgOf(s, "states", vars)
			orderByArg := gqlArgOf(s, "orderBy", vars)
			after := gqlArgOf(s, "after", vars)
			list := append([]*Issue(nil), repo.Issues...)
			if statesList, ok := statesArg.([]interface{}); ok && len(statesList) > 0 {
				want := map[string]bool{}
				for _, x := range statesList {
					want[strings.ToLower(gqlStringify(x))] = true
				}
				var filtered []*Issue
				for _, iss := range list {
					if want[iss.State] {
						filtered = append(filtered, iss)
					}
				}
				list = filtered
			}
			if orderBy, ok := orderByArg.(map[string]interface{}); ok {
				if field, _ := orderBy["field"].(string); field == "CREATED_AT" {
					desc := false
					if d, _ := orderBy["direction"].(string); d == "DESC" {
						desc = true
					}
					sort.SliceStable(list, func(i, j int) bool {
						if desc {
							return list[i].Number > list[j].Number
						}
						return list[i].Number < list[j].Number
					})
				}
			}
			afterNum := gqlNumberAfter(after)
			if afterNum > 0 {
				var filtered []*Issue
				for _, iss := range list {
					if iss.Number > afterNum {
						filtered = append(filtered, iss)
					}
				}
				list = filtered
			}
			total := len(list)
			limit := gqlSliceLimit(first, firstOK, total)
			page := list[:limit]
			nodes := []interface{}{}
			pageInfo := map[string]interface{}{"hasNextPage": false, "endCursor": nil}
			for _, c := range s.Children {
				if c.Name == "nodes" {
					for _, iss := range page {
						nodes = append(nodes, gqlSelectIssue(ctx, repo, iss, c.Children, vars))
					}
				} else if c.Name == "pageInfo" {
					info := make(map[string]interface{})
					for _, p := range c.Children {
						if p.Name == "hasNextPage" {
							info[gqlKey(p)] = total > limit
						} else if p.Name == "endCursor" {
							if len(page) > 0 {
								info[gqlKey(p)] = gqlCursorFor(page[len(page)-1].Number)
							} else {
								info[gqlKey(p)] = nil
							}
						} else {
							ctx.fieldError(p.Name, "PageInfo")
						}
					}
					pageInfo = info
				} else {
					ctx.fieldError(c.Name, "IssueConnection")
				}
			}
			out[key] = map[string]interface{}{"nodes": nodes, "pageInfo": pageInfo}
		case "pullRequests":
			first, firstOK := gqlNum(gqlArgOf(s, "first", vars))
			list := append([]*Pull(nil), repo.Pulls...)
			limit := gqlSliceLimit(first, firstOK, len(list))
			nodes := []interface{}{}
			for _, c := range s.Children {
				if c.Name == "nodes" {
					for _, pull := range list[:limit] {
						nodes = append(nodes, gqlSelectPull(ctx, repo, pull, c.Children, vars))
					}
				} else {
					ctx.fieldError(c.Name, "PullRequestConnection")
				}
			}
			out[key] = map[string]interface{}{"nodes": nodes}
		case "pullRequest":
			num, ok := gqlNum(gqlArgOf(s, "number", vars))
			var pull *Pull
			if ok {
				pull = store.GetPull(repo, int(num))
			}
			if pull != nil {
				out[key] = gqlSelectPull(ctx, repo, pull, s.Children, vars)
			} else {
				out[key] = nil
			}
		default:
			ctx.fieldError(s.Name, "Repository")
		}
	}
	return out
}

func gqlSelectType(ctx *gqlCtx, name string, sels []gqlSelection) map[string]interface{} {
	out := make(map[string]interface{})
	var fields []string
	switch name {
	case "Issue":
		fields = gqlIssueFields
	case "PullRequest":
		fields = gqlPRFields
	case "Repository":
		fields = gqlRepoFields
	default:
		fields = []string{}
	}
	var enums []string
	if name == "SearchType" {
		enums = gqlSearchEnum
	} else {
		enums = []string{}
	}
	for _, s := range sels {
		key := gqlKey(s)
		switch s.Name {
		case "fields":
			list := []interface{}{}
			for _, f := range fields {
				fo := make(map[string]interface{})
				for _, c := range s.Children {
					if c.Name == "name" {
						fo[gqlKey(c)] = f
					}
				}
				list = append(list, fo)
			}
			out[key] = list
		case "enumValues":
			list := []interface{}{}
			for _, e := range enums {
				eo := make(map[string]interface{})
				for _, c := range s.Children {
					if c.Name == "name" {
						eo[gqlKey(c)] = e
					}
				}
				list = append(list, eo)
			}
			out[key] = list
		case "name":
			out[key] = name
		default:
			ctx.fieldError(s.Name, "__Type")
		}
	}
	return out
}

func gqlExecuteOperation(ctx *gqlCtx, op gqlOperation, vars map[string]interface{}) map[string]interface{} {
	store := ctx.store
	data := make(map[string]interface{})
	if op.Kind == "mutation" {
		for _, s := range op.Selections {
			key := gqlKey(s)
			input := gqlObj(gqlArgOf(s, "input", vars))
			switch s.Name {
			case "createIssue":
				var repo *Repo
				if idStr, ok := input["repositoryId"].(string); ok {
					if ref, ok := store.ResolveGlobalId(idStr); ok && ref.Kind == "repo" {
						repo = store.RepoById(ref.RepoID)
					}
				}
				if repo == nil {
					ctx.addError("Could not resolve to a Repository with the global id.")
					data[key] = nil
					continue
				}
				issue := store.CreateIssue(repo, gqlStringify(input["title"]), gqlStringify(input["body"]), []string{})
				if issue == nil {
					data[key] = nil
				} else {
					data[key] = map[string]interface{}{
						"issue": map[string]interface{}{
							"number": issue.Number,
							"id":     store.GlobalId("issue", repo.ID, issue.Number, 0),
						},
					}
				}
			case "closeIssue":
				var ref GlobalRef
				var refOK bool
				if idStr, ok := input["issueId"].(string); ok {
					ref, refOK = store.ResolveGlobalId(idStr)
				}
				var repo *Repo
				if refOK {
					repo = store.RepoById(ref.RepoID)
				}
				var issue *Issue
				if repo != nil && refOK && ref.Kind == "issue" {
					issue = store.GetIssue(repo, ref.Number)
				}
				if issue == nil {
					ctx.addError("Could not resolve to an Issue with the global id.")
					data[key] = nil
					continue
				}
				issue.State = "closed"
				out := make(map[string]interface{})
				for _, c := range s.Children {
					if c.Name == "issue" {
						io := make(map[string]interface{})
						for _, f := range c.Children {
							switch f.Name {
							case "number":
								io[gqlKey(f)] = issue.Number
							case "id":
								io[gqlKey(f)] = store.GlobalId("issue", repo.ID, issue.Number, 0)
							case "state":
								io[gqlKey(f)] = "CLOSED"
							}
						}
						out[gqlKey(c)] = io
					}
				}
				data[key] = out
			case "createPullRequest":
				var repo *Repo
				if idStr, ok := input["repositoryId"].(string); ok {
					if ref, ok := store.ResolveGlobalId(idStr); ok && ref.Kind == "repo" {
						repo = store.RepoById(ref.RepoID)
					}
				}
				var pull *Pull
				if repo != nil {
					pull = store.CreatePull(repo, gqlStringify(input["title"]), gqlStringify(input["body"]), gqlStringify(input["headRefName"]), gqlStringify(input["baseRefName"]))
				}
				if pull == nil || repo == nil {
					ctx.addError("Could not resolve to a Repository with the global id.")
					data[key] = nil
					continue
				}
				out := make(map[string]interface{})
				for _, c := range s.Children {
					if c.Name == "pullRequest" {
						po := make(map[string]interface{})
						for _, f := range c.Children {
							switch f.Name {
							case "number":
								po[gqlKey(f)] = pull.Number
							case "id":
								po[gqlKey(f)] = store.GlobalId("pull", repo.ID, pull.Number, 0)
							case "state":
								po[gqlKey(f)] = "OPEN"
							case "headRefName":
								po[gqlKey(f)] = pull.HeadRef
							case "baseRefName":
								po[gqlKey(f)] = pull.BaseRef
							}
						}
						out[gqlKey(c)] = po
					}
				}
				data[key] = out
			case "mergePullRequest":
				var ref GlobalRef
				var refOK bool
				if idStr, ok := input["pullRequestId"].(string); ok {
					ref, refOK = store.ResolveGlobalId(idStr)
				}
				var repo *Repo
				if refOK {
					repo = store.RepoById(ref.RepoID)
				}
				result := PullMergeResult{Status: 404}
				if repo != nil && refOK && ref.Kind == "pull" {
					result = store.MergePull(repo, ref.Number)
				}
				var pull *Pull
				if repo != nil && refOK {
					pull = store.GetPull(repo, ref.Number)
				}
				if result.Status != 200 || pull == nil || repo == nil {
					ctx.addError("Could not merge the pull request.")
					data[key] = nil
					continue
				}
				out := make(map[string]interface{})
				for _, c := range s.Children {
					if c.Name == "pullRequest" {
						po := make(map[string]interface{})
						for _, f := range c.Children {
							switch f.Name {
							case "number":
								po[gqlKey(f)] = pull.Number
							case "merged":
								po[gqlKey(f)] = true
							case "state":
								po[gqlKey(f)] = "MERGED"
							case "id":
								po[gqlKey(f)] = store.GlobalId("pull", repo.ID, pull.Number, 0)
							}
						}
						out[gqlKey(c)] = po
					}
				}
				data[key] = out
			case "addComment":
				var ref GlobalRef
				var refOK bool
				if idStr, ok := input["subjectId"].(string); ok {
					ref, refOK = store.ResolveGlobalId(idStr)
				}
				var repo *Repo
				if refOK {
					repo = store.RepoById(ref.RepoID)
				}
				var comment *Comment
				if repo != nil && refOK && ref.Kind == "issue" {
					comment = store.CreateComment(repo, ref.Number, gqlStringify(input["body"]))
				}
				if comment == nil || repo == nil || !refOK {
					ctx.addError("Could not resolve to an Issue with the global id.")
					data[key] = nil
					continue
				}
				out := make(map[string]interface{})
				for _, c := range s.Children {
					if c.Name == "commentEdge" {
						eo := make(map[string]interface{})
						for _, n := range c.Children {
							if n.Name == "node" {
								no := make(map[string]interface{})
								for _, f := range n.Children {
									switch f.Name {
									case "id":
										no[gqlKey(f)] = store.GlobalId("comment", repo.ID, ref.Number, comment.ID)
									case "body":
										no[gqlKey(f)] = comment.Body
									}
								}
								eo[gqlKey(n)] = no
							}
						}
						out[gqlKey(c)] = eo
					}
				}
				data[key] = out
			default:
				ctx.fieldError(s.Name, "Mutation")
			}
		}
		return data
	}

	// query
	for _, s := range op.Selections {
		key := gqlKey(s)
		switch s.Name {
		case "viewer":
			vOut := make(map[string]interface{})
			for _, c := range s.Children {
				if c.Name == "login" {
					vOut[gqlKey(c)] = store.Viewer
				} else {
					ctx.fieldError(c.Name, "User")
				}
			}
			data[key] = vOut
		case "repository":
			var repo *Repo
			if ownerStr, ok := gqlArgOf(s, "owner", vars).(string); ok {
				if nameStr, ok := gqlArgOf(s, "name", vars).(string); ok {
					repo = store.GetRepo(ownerStr, nameStr)
				}
			}
			if repo != nil {
				data[key] = gqlSelectRepo(ctx, repo, s.Children, vars)
			} else {
				data[key] = nil
			}
		case "node":
			idVal := gqlArgOf(s, "id", vars)
			idStr, isStr := idVal.(string)
			var ref GlobalRef
			var refOK bool
			if isStr {
				ref, refOK = store.ResolveGlobalId(idStr)
			}
			if !refOK || ref.Kind != "repo" {
				data[key] = nil
				continue
			}
			repo := store.RepoById(ref.RepoID)
			if repo == nil {
				data[key] = nil
				continue
			}
			nOut := make(map[string]interface{})
			for _, c := range s.Children {
				if c.Name == "id" {
					nOut[gqlKey(c)] = idStr
				} else if c.FragmentOn == "Repository" {
					switch c.Name {
					case "name":
						nOut[gqlKey(c)] = repo.Name
					case "nameWithOwner":
						nOut[gqlKey(c)] = repo.Owner + "/" + repo.Name
					default:
						ctx.fieldError(c.Name, "Repository")
					}
				} else if c.Name == "__typename" {
					nOut[gqlKey(c)] = "Repository"
				} else {
					ctx.fieldError(c.Name, "Node")
				}
			}
			data[key] = nOut
		case "__type":
			name, ok := gqlArgOf(s, "name", vars).(string)
			if ok {
				data[key] = gqlSelectType(ctx, name, s.Children)
			} else {
				data[key] = nil
			}
		default:
			ctx.fieldError(s.Name, "Query")
		}
	}
	return data
}

func gqlRunOne(store *Store, body interface{}) map[string]interface{} {
	b, _ := body.(map[string]interface{})
	if b == nil {
		b = make(map[string]interface{})
	}
	query, _ := b["query"].(string)
	vars, _ := b["variables"].(map[string]interface{})
	if vars == nil {
		vars = make(map[string]interface{})
	}
	ctx := &gqlCtx{store: store}
	ops, err := (&gqlParser{src: query}).parseDocument()
	if err != nil {
		return map[string]interface{}{
			"data":   nil,
			"errors": []gqlError{{Message: err.Error()}},
		}
	}
	if len(ops) == 0 {
		return map[string]interface{}{
			"data":   nil,
			"errors": []gqlError{{Message: "No operations in the document."}},
		}
	}
	data := gqlExecuteOperation(ctx, ops[0], vars)
	if len(ctx.errors) > 0 {
		return map[string]interface{}{"data": data, "errors": ctx.errors}
	}
	return map[string]interface{}{"data": data}
}

// handleGraphql handles one POST /api/graphql request. Always sends a response.
func handleGraphql(w http.ResponseWriter, r *http.Request, store *Store) {
	// GraphQL is never concurrent in the trials; take the write lock for the
	// whole handler (mutations exist) to cover direct repo.Issues/Pulls reads.
	repoMu.Lock()
	defer repoMu.Unlock()

	reqID := store.NextRequestId()
	headers := map[string]string{"x-github-request-id": reqID}
	if !authed(r, store) {
		sendJSON(w, 401, map[string]interface{}{"message": "Bad credentials"}, headers)
		return
	}
	buf, err := readBody(r)
	if err != nil {
		sendJSON(w, 400, map[string]interface{}{"message": "Problems parsing JSON"}, headers)
		return
	}
	parsed, ok := parseJSON(buf)
	if !ok {
		sendJSON(w, 400, map[string]interface{}{"message": "Problems parsing JSON"}, headers)
		return
	}
	if arr, isArr := parsed.([]interface{}); isArr {
		out := make([]interface{}, 0, len(arr))
		for _, entry := range arr {
			out = append(out, gqlRunOne(store, entry))
		}
		sendJSON(w, 200, out, headers)
		return
	}
	sendJSON(w, 200, gqlRunOne(store, parsed), headers)
}
