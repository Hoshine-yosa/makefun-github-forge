// The forge's one in-memory store, shared by REST, GraphQL, MCP and git.
// Everything is deterministic: ids from counters, SHAs from content,
// timestamps from the trial's fixed now (MAKEFUN_TRIAL_NOW) — never the
// wall clock, never Math.random — so a replay sees the same state.

import { createHash } from 'node:crypto';
import {
  type GitObject, type ObjType, storeObject, makeBlob, buildTree, flattenTree,
  parseCommit, makeCommit, commitHistory, mergeBase, diffTrees, threeWayMerge,
  lineCounts,
} from './gitobj.ts';
import { viewerLogin } from './scenario.ts';

export interface Issue {
  number: number; id: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[];
  comments: { id: number; body: string }[];
  seq: number;
}
export interface PullFile {
  filename: string; status: string; additions: number; deletions: number; changes: number;
}
export interface Pull {
  number: number; id: number; title: string; body: string;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null; mergeSha: string | null;
  files: PullFile[];
}
export interface Repo {
  id: number; name: string; owner: string; private: boolean; description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[]; issueSeq: number;
  pulls: Pull[]; pullSeq: number;
  labels: Map<string, { name: string; color: string }>;
  commentSeq: number;
}

export interface GlobalRef { kind: 'repo' | 'issue' | 'pull' | 'comment'; repoId: number; number: number; extra?: number; }

const sha1hex = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex');

export class Store {
  token: string;
  viewer: string;
  nowIso: string;
  nowEpoch: number;
  repos = new Map<string, Repo>();
  repoSeq = 1;
  issueIdSeq = 1;
  requestSeq = 0;
  globalIds = new Map<string, GlobalRef>();

  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    this.viewer = viewerLogin();
    const nowRaw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(nowRaw);
    this.nowEpoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1735689600;
    this.nowIso = Number.isFinite(parsed) ? new Date(parsed).toISOString().replace('.000Z', 'Z') : '2025-01-01T00:00:00Z';
  }

  /** A fresh non-empty request id (deterministic counter, never random). */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  authorName(): string { return this.viewer; }
  authorEmail(): string { return `${this.viewer}@example.invalid`; }

  // -- global (GraphQL) ids: opaque, stable, reversible through the map --
  globalId(kind: GlobalRef['kind'], repoId: number, number: number, extra = 0): string {
    const prefix = kind === 'repo' ? 'R' : kind === 'issue' ? 'I' : kind === 'pull' ? 'P' : 'C';
    const id = `${prefix}_${sha1hex(`${kind}:${repoId}:${number}:${extra}`).slice(0, 20)}`;
    this.globalIds.set(id, { kind, repoId, number, extra });
    return id;
  }
  resolveGlobalId(id: string): GlobalRef | null {
    return this.globalIds.get(id) ?? null;
  }
  repoById(id: number): Repo | null {
    for (const r of this.repos.values()) if (r.id === id) return r;
    return null;
  }

  // -- repositories --
  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
  createRepo(name: string, isPrivate: boolean, description: string): { repo: Repo | null; duplicate: boolean } {
    const key = this.repoKey(this.viewer, name);
    if (this.repos.has(key)) return { repo: null, duplicate: true };
    const repo: Repo = {
      id: this.repoSeq, name, owner: this.viewer, private: isPrivate, description,
      defaultBranch: 'main', objects: new Map(), refs: new Map(),
      issues: [], issueSeq: 1, pulls: [], pullSeq: 1,
      labels: new Map(), commentSeq: 1,
    };
    this.repoSeq += 1;
    this.repos.set(key, repo);
    return { repo, duplicate: false };
  }
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== this.viewer) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }
  listRepos(): Repo[] { return [...this.repos.values()]; }
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -- refs / branches / commits --
  createRef(repo: Repo, ref: string, sha: string): boolean {
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    return true;
  }
  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.objects.has(ref)) return ref; // a raw sha
    const direct = repo.refs.get(ref);
    if (direct) return direct;
    const headed = repo.refs.get(`refs/heads/${ref}`);
    if (headed) return headed;
    return null;
  }
  listCommits(repo: Repo, ref: string | null): { sha: string; message: string }[] {
    const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null : this.resolveRef(repo, ref);
    if (!tip) return [];
    return commitHistory(repo.objects, tip).map((sha) => {
      const info = parseCommit(repo.objects, sha);
      return { sha, message: info?.message ?? '' };
    });
  }

  // -- contents (files live in git trees) --
  treeAt(repo: Repo, ref: string | null): Map<string, { sha: string; mode: string }> | null {
    const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null : this.resolveRef(repo, ref);
    if (!tip) return null;
    const info = parseCommit(repo.objects, tip);
    if (!info) return null;
    return flattenTree(repo.objects, info.tree);
  }
  commitFile(
    repo: Repo, branch: string, path: string, content: Buffer, message: string, expectedSha: string | null,
  ): { status: 201 | 200 | 409; blobSha: string | null; commitSha: string | null } {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    const oldFiles = tip === null ? new Map<string, { sha: string; mode: string }>() : (this.treeAt(repo, branch) ?? new Map());
    const current = oldFiles.get(path);
    if (current && expectedSha !== null && expectedSha.toLowerCase() !== current.sha.toLowerCase()) {
      return { status: 409, blobSha: null, commitSha: null };
    }
    const blobSha = makeBlob(repo.objects, content);
    const files = new Map<string, string>();
    for (const [p, e] of oldFiles) files.set(p, e.sha);
    files.set(path, blobSha);
    const treeSha = buildTree(repo.objects, files);
    const parents = tip === null ? [] : [tip];
    const commitSha = makeCommit(repo.objects, treeSha, parents, message, this.authorName(), this.authorEmail(), this.nowEpoch);
    repo.refs.set(refName, commitSha);
    return { status: current ? 200 : 201, blobSha, commitSha };
  }
  deleteFile(
    repo: Repo, branch: string, path: string, message: string,
  ): { status: 200 | 404; commitSha: string | null } {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    if (tip === null) return { status: 404, commitSha: null };
    const oldFiles = this.treeAt(repo, branch);
    if (!oldFiles || !oldFiles.has(path)) return { status: 404, commitSha: null };
    const files = new Map<string, string>();
    for (const [p, e] of oldFiles) if (p !== path) files.set(p, e.sha);
    const treeSha = buildTree(repo.objects, files);
    const commitSha = makeCommit(repo.objects, treeSha, [tip], message, this.authorName(), this.authorEmail(), this.nowEpoch);
    repo.refs.set(refName, commitSha);
    return { status: 200, commitSha };
  }

  // -- labels --
  createLabel(repo: Repo, name: string, color: string): { name: string; color: string } {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }
  hasLabel(repo: Repo, name: string): boolean { return repo.labels.has(name); }

  // -- issues --
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | null {
    for (const l of labels) if (!repo.labels.has(l)) return null;
    const issue: Issue = {
      number: repo.issueSeq, id: this.issueIdSeq, title, body, state: 'open',
      labels: [...labels], comments: [], seq: repo.issues.length,
    };
    this.issueIdSeq += 1;
    repo.issueSeq += 1;
    repo.issues.push(issue);
    return issue;
  }
  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((i) => i.number === number) ?? null;
  }
  listIssues(repo: Repo, state: string | null, sort: string, direction: string): Issue[] {
    let list = repo.issues.slice();
    if (state !== null && state !== 'all') list = list.filter((i) => i.state === state);
    if (sort === 'created') {
      list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
    }
    return list;
  }
  patchIssue(repo: Repo, number: number, state: 'open' | 'closed' | null): Issue | null {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    if (state !== null) issue.state = state;
    return issue;
  }
  createComment(repo: Repo, issueNumber: number, body: string): { id: number; body: string } | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const comment = { id: repo.commentSeq, body };
    repo.commentSeq += 1;
    issue.comments.push(comment);
    return comment;
  }
  listComments(repo: Repo, issueNumber: number): { id: number; body: string }[] | null {
    const issue = this.getIssue(repo, issueNumber);
    return issue ? issue.comments.slice() : null;
  }

  // -- pull requests --
  pullFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
    const baseInfo = parseCommit(repo.objects, baseSha);
    const headInfo = parseCommit(repo.objects, headSha);
    if (!baseInfo || !headInfo) return [];
    const baseTree = flattenTree(repo.objects, baseInfo.tree) ?? new Map();
    const headTree = flattenTree(repo.objects, headInfo.tree) ?? new Map();
    const out: PullFile[] = [];
    for (const d of diffTrees(baseTree, headTree)) {
      const oldContent = d.oldSha !== null ? repo.objects.get(d.oldSha)?.data ?? null : null;
      const newContent = d.newSha !== null ? repo.objects.get(d.newSha)?.data ?? null : null;
      const { additions, deletions } = lineCounts(oldContent, newContent);
      const status = d.status === 'added' ? 'added' : d.status === 'modified' ? 'modified' : 'removed';
      out.push({ filename: d.path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }
  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (!headSha || !baseSha) return null;
    const pull: Pull = {
      number: repo.pullSeq, id: this.issueIdSeq, title, body,
      headRef, baseRef, headSha, baseSha,
      state: 'open', merged: false, mergedAt: null, mergeSha: null,
      files: this.pullFiles(repo, baseSha, headSha),
    };
    this.issueIdSeq += 1;
    repo.pullSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }
  getPull(repo: Repo, number: number): Pull | null {
    return repo.pulls.find((p) => p.number === number) ?? null;
  }
  listPulls(repo: Repo, state: string | null): Pull[] {
    let list = repo.pulls.slice();
    if (state !== null && state !== 'all') list = list.filter((p) => p.state === state);
    return list;
  }
  mergePull(repo: Repo, number: number): { status: 200 | 404 | 405; sha: string | null } {
    const pull = this.getPull(repo, number);
    if (!pull) return { status: 404, sha: null };
    if (pull.merged || pull.state === 'closed') return { status: 405, sha: null };
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const headTip = this.resolveRef(repo, pull.headRef);
    if (!baseTip || !headTip) return { status: 405, sha: null };
    const base = mergeBase(repo.objects, baseTip, headTip);
    const baseInfo = base ? parseCommit(repo.objects, base) : null;
    const oursInfo = parseCommit(repo.objects, baseTip);
    const theirsInfo = parseCommit(repo.objects, headTip);
    if (!baseInfo || !oursInfo || !theirsInfo) return { status: 405, sha: null };
    const baseTree = flattenTree(repo.objects, baseInfo.tree) ?? new Map();
    const oursTree = flattenTree(repo.objects, oursInfo.tree) ?? new Map();
    const theirsTree = flattenTree(repo.objects, theirsInfo.tree) ?? new Map();
    const { files, conflict } = threeWayMerge(baseTree, oursTree, theirsTree);
    if (conflict) return { status: 405, sha: null };
    const treeSha = buildTree(repo.objects, files);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeSha = makeCommit(repo.objects, treeSha, [baseTip], message, this.authorName(), this.authorEmail(), this.nowEpoch);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso;
    pull.mergeSha = mergeSha;
    return { status: 200, sha: mergeSha };
  }
}
