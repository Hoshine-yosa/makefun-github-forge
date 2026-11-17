// The forge's one in-memory store, shared by REST, GraphQL, MCP and git.
// Everything is deterministic: ids from counters, SHAs from content,
// timestamps from the trial's fixed now (MAKEFUN_TRIAL_NOW) — never the
// wall clock, never random — so a replay sees the same state.
//
// Port of the Node forge's store.ts. Same ids, same SHAs, same JSON shapes.
//
// Concurrency: Go serves each request in its own goroutine, so the store
// guards itself. Public methods take the lock (read lock for pure reads,
// write lock for mutations) and delegate to unlocked internal helpers.
// Callers never lock; they just call the public methods.

package main

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

type Comment struct {
	ID   int
	Body string
}

type Issue struct {
	Number   int
	ID       int
	Title    string
	Body     string
	State    string // "open" | "closed"
	Labels   []string
	Comments []Comment
	Seq      int
}

type PullFile struct {
	Filename  string
	Status    string
	Additions int
	Deletions int
	Changes   int
}

type Pull struct {
	Number   int
	ID       int
	Title    string
	Body     string
	HeadRef  string
	BaseRef  string
	HeadSha  string
	BaseSha  string
	State    string // "open" | "closed"
	Merged   bool
	MergedAt string // "" means null
	MergeSha string // "" means null
	Files    []PullFile
}

type Label struct {
	Name  string
	Color string
}

type Repo struct {
	ID            int
	Name          string
	Owner         string
	Private       bool
	Description   string
	DefaultBranch string
	Objects       Objects
	Refs          map[string]string
	Issues        []*Issue
	IssueSeq      int
	Pulls         []*Pull
	PullSeq       int
	Labels        map[string]*Label
	CommentSeq    int
}

type GlobalRef struct {
	Kind   string // "repo" | "issue" | "pull" | "comment"
	RepoID int
	Number int
	Extra  int
}

// repoMu guards direct Repo field/map access outside Store methods.
// Store methods lock s.mu internally; handlers that touch repo.Refs,
// repo.Objects, repo.Labels, repo.Issues or repo.Pulls directly must hold
// repoMu (RLock for reads, Lock for writes). Lock order is repoMu -> s.mu;
// no Store method ever takes repoMu, so the order cannot invert.
var repoMu sync.RWMutex

type Store struct {
	mu         sync.RWMutex
	Token      string
	Viewer     string
	NowIso     string
	NowEpoch   int64
	repos      map[string]*Repo
	repoSeq    int
	issueSeq   int
	requestSeq int64
	globalMu   sync.Mutex
	globalIds  map[string]GlobalRef
}

func parseTrialNow() (iso string, epoch int64) {
	raw := os.Getenv("MAKEFUN_TRIAL_NOW")
	if raw != "" {
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z07:00", "2006-01-02 15:04:05Z07:00"} {
			if t, err := time.Parse(layout, raw); err == nil {
				iso = t.UTC().Format("2006-01-02T15:04:05Z07:00")
				// Match the Node: strip a ".000Z" millisecond tail.
				if len(iso) > 5 && iso[len(iso)-5:] == ".000Z" {
					iso = iso[:len(iso)-5] + "Z"
				}
				return iso, t.Unix()
			}
		}
	}
	return "2025-01-01T00:00:00Z", 1735689600
}

// NewStore creates the store. Reads MAKEFUN_SHOP_TOKEN and MAKEFUN_TRIAL_NOW.
func NewStore() *Store {
	iso, epoch := parseTrialNow()
	return &Store{
		Token:     os.Getenv("MAKEFUN_SHOP_TOKEN"),
		Viewer:    viewerLogin(),
		NowIso:    iso,
		NowEpoch:  epoch,
		repos:     map[string]*Repo{},
		repoSeq:   1,
		issueSeq:  1,
		globalIds: map[string]GlobalRef{},
	}
}

// NextRequestId returns a fresh non-empty request id (deterministic counter, never random).
func (s *Store) NextRequestId() string {
	n := atomic.AddInt64(&s.requestSeq, 1)
	return "req-" + strconv.FormatInt(n, 10)
}

func (s *Store) AuthorName() string { return s.Viewer }
func (s *Store) AuthorEmail() string {
	return s.Viewer + "@example.invalid"
}

// -- global (GraphQL) ids: opaque, stable, reversible through the map --
func (s *Store) GlobalId(kind string, repoID, number, extra int) string {
	var prefix string
	switch kind {
	case "repo":
		prefix = "R"
	case "issue":
		prefix = "I"
	case "pull":
		prefix = "P"
	default:
		prefix = "C"
	}
	h := sha1.New()
	h.Write([]byte(kind + ":" + strconv.Itoa(repoID) + ":" + strconv.Itoa(number) + ":" + strconv.Itoa(extra)))
	id := prefix + "_" + hex.EncodeToString(h.Sum(nil))[:20]
	s.globalMu.Lock()
	s.globalIds[id] = GlobalRef{Kind: kind, RepoID: repoID, Number: number, Extra: extra}
	s.globalMu.Unlock()
	return id
}

func (s *Store) ResolveGlobalId(id string) (GlobalRef, bool) {
	s.globalMu.Lock()
	defer s.globalMu.Unlock()
	r, ok := s.globalIds[id]
	return r, ok
}

func (s *Store) RepoById(id int) *Repo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.repos {
		if r.ID == id {
			return r
		}
	}
	return nil
}

// -- repositories --
func (s *Store) repoKey(owner, name string) string { return owner + "/" + name }

func (s *Store) CreateRepo(name string, isPrivate bool, description string) (*Repo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.repoKey(s.Viewer, name)
	if _, ok := s.repos[key]; ok {
		return nil, true
	}
	repo := &Repo{
		ID:            s.repoSeq,
		Name:          name,
		Owner:         s.Viewer,
		Private:       isPrivate,
		Description:   description,
		DefaultBranch: "main",
		Objects:       Objects{},
		Refs:          map[string]string{},
		Issues:        []*Issue{},
		IssueSeq:      1,
		Pulls:         []*Pull{},
		PullSeq:       1,
		Labels:        map[string]*Label{},
		CommentSeq:    1,
	}
	s.repoSeq++
	s.repos[key] = repo
	return repo, false
}

func (s *Store) GetRepo(owner, name string) *Repo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if owner != s.Viewer {
		return nil
	}
	return s.repos[s.repoKey(owner, name)]
}

func (s *Store) ListRepos() []*Repo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Repo, 0, len(s.repos))
	for _, r := range s.repos {
		out = append(out, r)
	}
	return out
}

func (s *Store) DeleteRepo(owner, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if owner != s.Viewer {
		return false
	}
	key := s.repoKey(owner, name)
	if _, ok := s.repos[key]; !ok {
		return false
	}
	delete(s.repos, key)
	return true
}

// -- refs / branches / commits --
func (s *Store) CreateRef(repo *Repo, ref, sha string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := repo.Refs[ref]; ok {
		return false
	}
	if _, ok := repo.Objects[sha]; !ok {
		return false
	}
	repo.Refs[ref] = sha
	return true
}

type Branch struct {
	Name string
	Sha  string
}

func (s *Store) ListBranches(repo *Repo) []Branch {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Branch
	for ref, sha := range repo.Refs {
		if len(ref) > len("refs/heads/") && ref[:len("refs/heads/")] == "refs/heads/" {
			out = append(out, Branch{Name: ref[len("refs/heads/"):], Sha: sha})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// resolveRefLocked resolves a ref name or raw sha. Caller must hold at least a read lock.
func (s *Store) resolveRefLocked(repo *Repo, ref string) string {
	if _, ok := repo.Objects[ref]; ok {
		return ref
	}
	if v, ok := repo.Refs[ref]; ok {
		return v
	}
	if v, ok := repo.Refs["refs/heads/"+ref]; ok {
		return v
	}
	return ""
}

func (s *Store) ResolveRef(repo *Repo, ref string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.resolveRefLocked(repo, ref)
}

type CommitEntry struct {
	Sha     string
	Message string
}

func (s *Store) ListCommits(repo *Repo, ref string) []CommitEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var tip string
	if ref == "" {
		tip = repo.Refs["refs/heads/"+repo.DefaultBranch]
	} else {
		tip = s.resolveRefLocked(repo, ref)
	}
	if tip == "" {
		return nil
	}
	var out []CommitEntry
	for _, sha := range CommitHistory(repo.Objects, tip) {
		msg := ""
		if info := ParseCommit(repo.Objects, sha); info != nil {
			msg = info.Message
		}
		out = append(out, CommitEntry{Sha: sha, Message: msg})
	}
	return out
}

// treeAtLocked returns the flat tree at a ref (or the default branch when ref is "").
// Caller must hold at least a read lock. Returns nil when the ref/commit/tree is missing.
func (s *Store) treeAtLocked(repo *Repo, ref string) map[string]TreeEntry {
	var tip string
	if ref == "" {
		tip = repo.Refs["refs/heads/"+repo.DefaultBranch]
	} else {
		tip = s.resolveRefLocked(repo, ref)
	}
	if tip == "" {
		return nil
	}
	info := ParseCommit(repo.Objects, tip)
	if info == nil {
		return nil
	}
	return FlattenTree(repo.Objects, info.Tree)
}

func (s *Store) TreeAt(repo *Repo, ref string) map[string]TreeEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.treeAtLocked(repo, ref)
}

type CommitFileResult struct {
	Status    int // 201 | 200 | 409
	BlobSha   string
	CommitSha string
}

func (s *Store) CommitFile(repo *Repo, branch, path string, content []byte, message string, expectedSha string) CommitFileResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	refName := "refs/heads/" + branch
	tip, hasTip := repo.Refs[refName]
	var oldFiles map[string]TreeEntry
	if !hasTip {
		oldFiles = map[string]TreeEntry{}
	} else {
		oldFiles = s.treeAtLocked(repo, branch)
		if oldFiles == nil {
			oldFiles = map[string]TreeEntry{}
		}
	}
	if current, ok := oldFiles[path]; ok && expectedSha != "" && !equalFold(expectedSha, current.Sha) {
		return CommitFileResult{Status: 409}
	}
	blobSha := makeBlob(repo.Objects, content)
	files := map[string]string{}
	for p, e := range oldFiles {
		files[p] = e.Sha
	}
	files[path] = blobSha
	treeSha := BuildTree(repo.Objects, files)
	var parents []string
	if hasTip {
		parents = []string{tip}
	}
	commitSha := MakeCommit(repo.Objects, treeSha, parents, message, s.AuthorName(), s.AuthorEmail(), s.NowEpoch)
	repo.Refs[refName] = commitSha
	status := 201
	if _, ok := oldFiles[path]; ok {
		status = 200
	}
	return CommitFileResult{Status: status, BlobSha: blobSha, CommitSha: commitSha}
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'A' && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

type DeleteFileResult struct {
	Status    int // 200 | 404
	CommitSha string
}

func (s *Store) DeleteFile(repo *Repo, branch, path, message string) DeleteFileResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	refName := "refs/heads/" + branch
	tip, hasTip := repo.Refs[refName]
	if !hasTip {
		return DeleteFileResult{Status: 404}
	}
	oldFiles := s.treeAtLocked(repo, branch)
	if oldFiles == nil {
		return DeleteFileResult{Status: 404}
	}
	if _, ok := oldFiles[path]; !ok {
		return DeleteFileResult{Status: 404}
	}
	files := map[string]string{}
	for p, e := range oldFiles {
		if p != path {
			files[p] = e.Sha
		}
	}
	treeSha := BuildTree(repo.Objects, files)
	commitSha := MakeCommit(repo.Objects, treeSha, []string{tip}, message, s.AuthorName(), s.AuthorEmail(), s.NowEpoch)
	repo.Refs[refName] = commitSha
	return DeleteFileResult{Status: 200, CommitSha: commitSha}
}

// -- labels --
func (s *Store) CreateLabel(repo *Repo, name, color string) *Label {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := repo.Labels[name]; ok {
		return existing
	}
	label := &Label{Name: name, Color: color}
	repo.Labels[name] = label
	return label
}

func (s *Store) HasLabel(repo *Repo, name string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := repo.Labels[name]
	return ok
}

// -- issues --
func (s *Store) CreateIssue(repo *Repo, title, body string, labels []string) *Issue {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range labels {
		if _, ok := repo.Labels[l]; !ok {
			return nil
		}
	}
	issue := &Issue{
		Number: repo.IssueSeq,
		ID:     s.issueSeq,
		Title:  title,
		Body:   body,
		State:  "open",
		Labels: append([]string{}, labels...),
		Seq:    len(repo.Issues),
	}
	s.issueSeq++
	repo.IssueSeq++
	repo.Issues = append(repo.Issues, issue)
	return issue
}

func (s *Store) GetIssue(repo *Repo, number int) *Issue {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, i := range repo.Issues {
		if i.Number == number {
			return i
		}
	}
	return nil
}

func (s *Store) ListIssues(repo *Repo, state, sortBy, direction string) []*Issue {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var list []*Issue
	for _, i := range repo.Issues {
		if state != "" && state != "all" && i.State != state {
			continue
		}
		list = append(list, i)
	}
	if sortBy == "created" {
		sort.SliceStable(list, func(a, b int) bool {
			if direction == "desc" {
				return list[a].Seq > list[b].Seq
			}
			return list[a].Seq < list[b].Seq
		})
	}
	return list
}

func (s *Store) PatchIssue(repo *Repo, number int, state string) *Issue {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, i := range repo.Issues {
		if i.Number == number {
			if state != "" {
				i.State = state
			}
			return i
		}
	}
	return nil
}

func (s *Store) CreateComment(repo *Repo, issueNumber int, body string) *Comment {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, i := range repo.Issues {
		if i.Number == issueNumber {
			c := Comment{ID: repo.CommentSeq, Body: body}
			repo.CommentSeq++
			i.Comments = append(i.Comments, c)
			return &i.Comments[len(i.Comments)-1]
		}
	}
	return nil
}

func (s *Store) ListComments(repo *Repo, issueNumber int) []Comment {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, i := range repo.Issues {
		if i.Number == issueNumber {
			out := make([]Comment, len(i.Comments))
			copy(out, i.Comments)
			return out
		}
	}
	return nil
}

// -- pull requests --
func (s *Store) pullFilesLocked(repo *Repo, baseSha, headSha string) []PullFile {
	baseInfo := ParseCommit(repo.Objects, baseSha)
	headInfo := ParseCommit(repo.Objects, headSha)
	if baseInfo == nil || headInfo == nil {
		return nil
	}
	baseTree := FlattenTree(repo.Objects, baseInfo.Tree)
	if baseTree == nil {
		baseTree = map[string]TreeEntry{}
	}
	headTree := FlattenTree(repo.Objects, headInfo.Tree)
	if headTree == nil {
		headTree = map[string]TreeEntry{}
	}
	var out []PullFile
	for _, d := range DiffTrees(baseTree, headTree) {
		var oldContent, newContent []byte
		if d.HasOld {
			if o := repo.Objects[d.OldSha]; o != nil {
				oldContent = o.Data
			}
		}
		if d.HasNew {
			if o := repo.Objects[d.NewSha]; o != nil {
				newContent = o.Data
			}
		}
		add, del := LineCounts(oldContent, newContent)
		status := "removed"
		if d.Status == "added" {
			status = "added"
		} else if d.Status == "modified" {
			status = "modified"
		}
		out = append(out, PullFile{Filename: d.Path, Status: status, Additions: add, Deletions: del, Changes: add + del})
	}
	return out
}

func (s *Store) CreatePull(repo *Repo, title, body, headRef, baseRef string) *Pull {
	s.mu.Lock()
	defer s.mu.Unlock()
	headSha := s.resolveRefLocked(repo, headRef)
	baseSha := s.resolveRefLocked(repo, baseRef)
	if headSha == "" || baseSha == "" {
		return nil
	}
	pull := &Pull{
		Number:  repo.PullSeq,
		ID:      s.issueSeq,
		Title:   title,
		Body:    body,
		HeadRef: headRef,
		BaseRef: baseRef,
		HeadSha: headSha,
		BaseSha: baseSha,
		State:   "open",
		Files:   s.pullFilesLocked(repo, baseSha, headSha),
	}
	s.issueSeq++
	repo.PullSeq++
	repo.Pulls = append(repo.Pulls, pull)
	return pull
}

func (s *Store) GetPull(repo *Repo, number int) *Pull {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range repo.Pulls {
		if p.Number == number {
			return p
		}
	}
	return nil
}

func (s *Store) ListPulls(repo *Repo, state string) []*Pull {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var list []*Pull
	for _, p := range repo.Pulls {
		if state != "" && state != "all" && p.State != state {
			continue
		}
		list = append(list, p)
	}
	return list
}

type PullMergeResult struct {
	Status int // 200 | 404 | 405
	Sha    string
}

func (s *Store) MergePull(repo *Repo, number int) PullMergeResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	var pull *Pull
	for _, p := range repo.Pulls {
		if p.Number == number {
			pull = p
			break
		}
	}
	if pull == nil {
		return PullMergeResult{Status: 404}
	}
	if pull.Merged || pull.State == "closed" {
		return PullMergeResult{Status: 405}
	}
	baseTip := s.resolveRefLocked(repo, pull.BaseRef)
	headTip := s.resolveRefLocked(repo, pull.HeadRef)
	if baseTip == "" || headTip == "" {
		return PullMergeResult{Status: 405}
	}
	base := MergeBase(repo.Objects, baseTip, headTip)
	baseInfo := (*CommitInfo)(nil)
	if base != "" {
		baseInfo = ParseCommit(repo.Objects, base)
	}
	oursInfo := ParseCommit(repo.Objects, baseTip)
	theirsInfo := ParseCommit(repo.Objects, headTip)
	if baseInfo == nil || oursInfo == nil || theirsInfo == nil {
		return PullMergeResult{Status: 405}
	}
	baseTree := FlattenTree(repo.Objects, baseInfo.Tree)
	if baseTree == nil {
		baseTree = map[string]TreeEntry{}
	}
	oursTree := FlattenTree(repo.Objects, oursInfo.Tree)
	if oursTree == nil {
		oursTree = map[string]TreeEntry{}
	}
	theirsTree := FlattenTree(repo.Objects, theirsInfo.Tree)
	if theirsTree == nil {
		theirsTree = map[string]TreeEntry{}
	}
	mr := ThreeWayMerge(baseTree, oursTree, theirsTree)
	if mr.Conflict {
		return PullMergeResult{Status: 405}
	}
	treeSha := BuildTree(repo.Objects, mr.Files)
	message := "Merge pull request #" + strconv.Itoa(pull.Number) + " from " + pull.HeadRef
	mergeSha := MakeCommit(repo.Objects, treeSha, []string{baseTip}, message, s.AuthorName(), s.AuthorEmail(), s.NowEpoch)
	repo.Refs["refs/heads/"+pull.BaseRef] = mergeSha
	pull.State = "closed"
	pull.Merged = true
	pull.MergedAt = s.NowIso
	pull.MergeSha = mergeSha
	return PullMergeResult{Status: 200, Sha: mergeSha}
}
