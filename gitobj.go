// Git object layer: SHA-1 object ids, blob/tree/commit creation and parsing,
// tree flattening, ancestry, merge-base, three-way merge and tree diff.
// All pure and deterministic — no clock, no randomness. Commit timestamps
// come from the caller (the trial's fixed now).
//
// Port of the Node forge's gitobj.ts. Same object ids, same tree bytes,
// same merge semantics.

package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

type ObjType string

const (
	ObjBlob   ObjType = "blob"
	ObjTree   ObjType = "tree"
	ObjCommit ObjType = "commit"
	ObjTag    ObjType = "tag"
)

type GitObject struct {
	Type ObjType
	Data []byte
}

// Objects is the per-repo object map. Keys are hex SHAs.
type Objects map[string]*GitObject

func gitSha(typ ObjType, data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s %d\x00", string(typ), len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// GitSha returns the git object id for type+data.
func GitSha(typ ObjType, data []byte) string { return gitSha(typ, data) }

func storeObject(objects Objects, typ ObjType, data []byte) string {
	sha := gitSha(typ, data)
	if _, ok := objects[sha]; !ok {
		objects[sha] = &GitObject{Type: typ, Data: data}
	}
	return sha
}

// StoreObject stores an object if absent and returns its sha.
func StoreObject(objects Objects, typ ObjType, data []byte) string {
	return storeObject(objects, typ, data)
}

func makeBlob(objects Objects, content []byte) string {
	return storeObject(objects, ObjBlob, content)
}

// MakeBlob stores a blob and returns its sha.
func MakeBlob(objects Objects, content []byte) string { return makeBlob(objects, content) }

type treeNode struct {
	files map[string]string // name -> blob sha
	dirs  map[string]*treeNode
}

// BuildTree builds nested trees from a flat path->blob map; returns the root tree sha.
func BuildTree(objects Objects, files map[string]string) string {
	root := &treeNode{files: map[string]string{}, dirs: map[string]*treeNode{}}
	for path, blobSha := range files {
		parts := strings.Split(path, "/")
		node := root
		for i := 0; i < len(parts)-1; i++ {
			next, ok := node.dirs[parts[i]]
			if !ok {
				next = &treeNode{files: map[string]string{}, dirs: map[string]*treeNode{}}
				node.dirs[parts[i]] = next
			}
			node = next
		}
		node.files[parts[len(parts)-1]] = blobSha
	}
	var writeNode func(node *treeNode) string
	writeNode = func(node *treeNode) string {
		type entry struct {
			sortKey string
			line    []byte
			sha     []byte
		}
		var entries []entry
		for name, blobSha := range node.files {
			sha, _ := hex.DecodeString(blobSha)
			entries = append(entries, entry{
				sortKey: name,
				line:    []byte("100644 " + name + "\x00"),
				sha:     sha,
			})
		}
		for name, child := range node.dirs {
			childSha := writeNode(child)
			sha, _ := hex.DecodeString(childSha)
			entries = append(entries, entry{
				sortKey: name + "/",
				line:    []byte("40000 " + name + "\x00"),
				sha:     sha,
			})
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].sortKey < entries[j].sortKey })
		var buf bytes.Buffer
		for _, e := range entries {
			buf.Write(e.line)
			buf.Write(e.sha)
		}
		return storeObject(objects, ObjTree, buf.Bytes())
	}
	return writeNode(root)
}

type TreeEntry struct {
	Mode string
	Name string
	Sha  string
}

// ParseTree parses a raw tree object into its entries.
func ParseTree(data []byte) []TreeEntry {
	var entries []TreeEntry
	off := 0
	for off < len(data) {
		sp := bytes.IndexByte(data[off:], ' ')
		if sp < 0 {
			break
		}
		sp += off
		nul := bytes.IndexByte(data[sp:], 0)
		if nul < 0 {
			break
		}
		nul += sp
		mode := string(data[off:sp])
		name := string(data[sp+1 : nul])
		sha := hex.EncodeToString(data[nul+1 : nul+21])
		entries = append(entries, TreeEntry{Mode: mode, Name: name, Sha: sha})
		off = nul + 21
	}
	return entries
}

// FlattenTree flattens a tree into path -> {sha, mode}. Returns nil when the tree is missing.
func FlattenTree(objects Objects, treeSha string) map[string]TreeEntry {
	obj, ok := objects[treeSha]
	if !ok || obj.Type != ObjTree {
		return nil
	}
	out := map[string]TreeEntry{}
	var walk func(sha, pre string)
	walk = func(sha, pre string) {
		o, ok := objects[sha]
		if !ok || o.Type != ObjTree {
			return
		}
		for _, e := range ParseTree(o.Data) {
			if e.Mode == "40000" {
				walk(e.Sha, pre+e.Name+"/")
			} else {
				out[pre+e.Name] = e
			}
		}
	}
	walk(treeSha, "")
	return out
}

type CommitInfo struct {
	Tree       string
	Parents    []string
	Message    string
	AuthorLine string
}

// ParseCommit parses a raw commit object. Returns nil when missing/not a commit.
func ParseCommit(objects Objects, sha string) *CommitInfo {
	obj, ok := objects[sha]
	if !ok || obj.Type != ObjCommit {
		return nil
	}
	text := string(obj.Data)
	headEnd := strings.Index(text, "\n\n")
	head := text
	message := ""
	if headEnd >= 0 {
		head = text[:headEnd]
		message = strings.TrimSuffix(text[headEnd+2:], "\n")
	}
	info := &CommitInfo{}
	for _, line := range strings.Split(head, "\n") {
		switch {
		case strings.HasPrefix(line, "tree "):
			info.Tree = strings.TrimSpace(line[5:])
		case strings.HasPrefix(line, "parent "):
			info.Parents = append(info.Parents, strings.TrimSpace(line[7:]))
		case strings.HasPrefix(line, "author "):
			info.AuthorLine = line[7:]
		}
	}
	info.Message = message
	return info
}

// MakeCommit creates a commit object; returns its sha.
func MakeCommit(objects Objects, treeSha string, parents []string, message, authorName, authorEmail string, epochSec int64) string {
	var lines []string
	lines = append(lines, "tree "+treeSha)
	for _, p := range parents {
		lines = append(lines, "parent "+p)
	}
	stamp := fmt.Sprintf("%d +0000", epochSec)
	lines = append(lines, "author "+authorName+" <"+authorEmail+"> "+stamp)
	lines = append(lines, "committer "+authorName+" <"+authorEmail+"> "+stamp)
	data := []byte(strings.Join(lines, "\n") + "\n\n" + message + "\n")
	return storeObject(objects, ObjCommit, data)
}

// Ancestors returns all ancestors of a commit (including itself), via parent links.
func Ancestors(objects Objects, sha string) map[string]bool {
	seen := map[string]bool{}
	stack := []string{sha}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if info := ParseCommit(objects, cur); info != nil {
			stack = append(stack, info.Parents...)
		}
	}
	return seen
}

// IsAncestor reports whether a is an ancestor of (or equal to) b.
func IsAncestor(objects Objects, a, b string) bool {
	return Ancestors(objects, b)[a]
}

// MergeBase returns a merge base of two commits: the first common ancestor found walking b's history.
func MergeBase(objects Objects, a, b string) string {
	aAnc := Ancestors(objects, a)
	seen := map[string]bool{}
	queue := []string{b}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if aAnc[cur] {
			return cur
		}
		if info := ParseCommit(objects, cur); info != nil {
			queue = append(queue, info.Parents...)
		}
	}
	return ""
}

// CommitHistory returns the history of a ref, newest first (first-parent walk with a visited set).
func CommitHistory(objects Objects, tip string) []string {
	var out []string
	seen := map[string]bool{}
	stack := []string{tip}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		info := ParseCommit(objects, cur)
		if info == nil {
			continue
		}
		out = append(out, cur)
		// Push parents in reverse so the first parent is visited first.
		for i := len(info.Parents) - 1; i >= 0; i-- {
			stack = append(stack, info.Parents[i])
		}
	}
	return out
}

type DiffEntry struct {
	Path   string
	Status string // "added" | "modified" | "deleted"
	OldSha string
	NewSha string
	HasOld bool
	HasNew bool
}

// DiffTrees diffs two trees (flat maps) into added/modified/deleted entries, sorted by path.
func DiffTrees(base, head map[string]TreeEntry) []DiffEntry {
	paths := map[string]bool{}
	for p := range base {
		paths[p] = true
	}
	for p := range head {
		paths[p] = true
	}
	var sorted []string
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	var out []DiffEntry
	for _, path := range sorted {
		b, hasB := base[path]
		h, hasH := head[path]
		switch {
		case hasB && !hasH:
			out = append(out, DiffEntry{Path: path, Status: "deleted", OldSha: b.Sha, HasOld: true})
		case !hasB && hasH:
			out = append(out, DiffEntry{Path: path, Status: "added", NewSha: h.Sha, HasNew: true})
		case hasB && hasH && b.Sha != h.Sha:
			out = append(out, DiffEntry{Path: path, Status: "modified", OldSha: b.Sha, NewSha: h.Sha, HasOld: true, HasNew: true})
		}
	}
	return out
}

type MergeResult struct {
	Files    map[string]string
	Conflict bool
}

// ThreeWayMerge merges file maps (path -> blob sha): base is the merge base,
// ours is the branch being merged into, theirs is the branch being merged.
// A path changed on both sides to different blobs is a conflict.
func ThreeWayMerge(base, ours, theirs map[string]TreeEntry) MergeResult {
	files := map[string]string{}
	conflict := false
	paths := map[string]bool{}
	for p := range base {
		paths[p] = true
	}
	for p := range ours {
		paths[p] = true
	}
	for p := range theirs {
		paths[p] = true
	}
	shaOf := func(m map[string]TreeEntry, p string) (string, bool) {
		e, ok := m[p]
		if !ok {
			return "", false
		}
		return e.Sha, true
	}
	for path := range paths {
		b, hasB := shaOf(base, path)
		o, hasO := shaOf(ours, path)
		t, hasT := shaOf(theirs, path)
		// Normalize to "null" when absent, matching the TS (undefined -> null).
		bv := ""
		if hasB {
			bv = b
		}
		ov := ""
		if hasO {
			ov = o
		}
		tv := ""
		if hasT {
			tv = t
		}
		switch {
		case ov == tv:
			if hasO {
				files[path] = ov
			}
		case bv == ov:
			if hasT {
				files[path] = tv
			}
		case bv == tv:
			if hasO {
				files[path] = ov
			}
		default:
			conflict = true
		}
	}
	return MergeResult{Files: files, Conflict: conflict}
}

// LineCounts counts line additions/deletions between two contents (multiset line diff).
func LineCounts(oldContent, newContent []byte) (additions, deletions int) {
	linesOf := func(b []byte) map[string]int {
		m := map[string]int{}
		if b == nil {
			return m
		}
		text := string(b)
		parts := strings.Split(text, "\n")
		if len(parts) > 0 && parts[len(parts)-1] == "" {
			parts = parts[:len(parts)-1]
		}
		for _, line := range parts {
			m[line]++
		}
		return m
	}
	oldLines := linesOf(oldContent)
	newLines := linesOf(newContent)
	for line, n := range newLines {
		if d := n - oldLines[line]; d > 0 {
			additions += d
		}
	}
	for line, n := range oldLines {
		if d := n - newLines[line]; d > 0 {
			deletions += d
		}
	}
	return additions, deletions
}
