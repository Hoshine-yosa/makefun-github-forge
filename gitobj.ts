// Git object layer: SHA-1 object ids, blob/tree/commit creation and parsing,
// tree flattening, ancestry, merge-base, three-way merge and tree diff.
// All pure and deterministic — no clock, no randomness. Commit timestamps
// come from the caller (the trial's fixed now).

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { type: ObjType; data: Buffer; }

export function gitSha(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const sha = gitSha(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

export function makeBlob(objects: Map<string, GitObject>, content: Buffer | string): string {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return storeObject(objects, 'blob', data);
}

interface TreeNode {
  files: Map<string, string>; // name -> blob sha
  dirs: Map<string, TreeNode>;
}

/** Build nested trees from a flat path->blob map; returns the root tree sha. */
export function buildTree(objects: Map<string, GitObject>, files: Map<string, string>): string {
  const root: TreeNode = { files: new Map(), dirs: new Map() };
  for (const [path, blobSha] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(parts[i], next); }
      node = next;
    }
    node.files.set(parts[parts.length - 1], blobSha);
  }
  const writeNode = (node: TreeNode): string => {
    const entries: { sortKey: string; line: Buffer; sha: Buffer }[] = [];
    for (const [name, blobSha] of node.files) {
      entries.push({ sortKey: name, line: Buffer.from(`100644 ${name}\0`, 'utf8'), sha: Buffer.from(blobSha, 'hex') });
    }
    for (const [name, child] of node.dirs) {
      const childSha = writeNode(child);
      entries.push({ sortKey: `${name}/`, line: Buffer.from(`40000 ${name}\0`, 'utf8'), sha: Buffer.from(childSha, 'hex') });
    }
    entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const data = Buffer.concat(entries.map((e) => Buffer.concat([e.line, e.sha])));
    return storeObject(objects, 'tree', data);
  };
  return writeNode(root);
}

export interface TreeEntry { mode: string; name: string; sha: string; }

/** Parse a raw tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

/** Flatten a tree into path -> {sha, mode}. Returns null when the tree is missing. */
export function flattenTree(objects: Map<string, GitObject>, treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> | null {
  const obj = objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return null;
  const out = new Map<string, { sha: string; mode: string }>();
  const walk = (sha: string, pre: string): void => {
    const o = objects.get(sha);
    if (!o || o.type !== 'tree') return;
    for (const e of parseTree(o.data)) {
      if (e.mode === '40000') walk(e.sha, `${pre}${e.name}/`);
      else out.set(`${pre}${e.name}`, { sha: e.sha, mode: e.mode });
    }
  };
  walk(treeSha, prefix);
  return out;
}

export interface CommitInfo { tree: string; parents: string[]; message: string; authorLine: string; }

/** Parse a raw commit object. Returns null when missing/not a commit. */
export function parseCommit(objects: Map<string, GitObject>, sha: string): CommitInfo | null {
  const obj = objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
  }
  return { tree, parents, message, authorLine };
}

/** Create a commit object; returns its sha. */
export function makeCommit(
  objects: Map<string, GitObject>, treeSha: string, parents: string[], message: string,
  authorName: string, authorEmail: string, epochSec: number,
): string {
  const lines: string[] = [`tree ${treeSha}`];
  for (const p of parents) lines.push(`parent ${p}`);
  const stamp = `${epochSec} +0000`;
  lines.push(`author ${authorName} <${authorEmail}> ${stamp}`);
  lines.push(`committer ${authorName} <${authorEmail}> ${stamp}`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
  return storeObject(objects, 'commit', data);
}

/** All ancestors of a commit (including itself), via parent links. */
export function ancestors(objects: Map<string, GitObject>, sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const info = parseCommit(objects, cur);
    if (info) for (const p of info.parents) stack.push(p);
  }
  return seen;
}

/** True when `a` is an ancestor of (or equal to) `b`. */
export function isAncestor(objects: Map<string, GitObject>, a: string, b: string): boolean {
  return ancestors(objects, b).has(a);
}

/** A merge base of two commits: the first common ancestor found walking b's history. */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const aAnc = ancestors(objects, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (aAnc.has(cur)) return cur;
    const info = parseCommit(objects, cur);
    if (info) for (const p of info.parents) queue.push(p);
  }
  return null;
}

/** History of a ref, newest first (first-parent walk with a visited set). */
export function commitHistory(objects: Map<string, GitObject>, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const info = parseCommit(objects, cur);
    if (!info) continue;
    out.push(cur);
    // Push parents in reverse so the first parent is visited first.
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
  }
  return out;
}

export interface DiffEntry { path: string; status: 'added' | 'modified' | 'deleted'; oldSha: string | null; newSha: string | null; }

/** Diff two trees (flat maps) into added/modified/deleted entries. */
export function diffTrees(
  base: Map<string, { sha: string; mode: string }>, head: Map<string, { sha: string; mode: string }>,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'deleted', oldSha: b.sha, newSha: null });
    else if (!b && h) out.push({ path, status: 'added', oldSha: null, newSha: h.sha });
    else if (b && h && b.sha !== h.sha) out.push({ path, status: 'modified', oldSha: b.sha, newSha: h.sha });
  }
  return out;
}

export interface MergeResult { files: Map<string, string>; conflict: boolean; }

/**
 * Three-way merge of file maps (path -> blob sha): base is the merge base,
 * ours is the branch being merged into, theirs is the branch being merged.
 * A path changed on both sides to different blobs is a conflict.
 */
export function threeWayMerge(
  base: Map<string, { sha: string }>, ours: Map<string, { sha: string }>, theirs: Map<string, { sha: string }>,
): MergeResult {
  const files = new Map<string, string>();
  let conflict = false;
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.sha ?? null;
    const o = ours.get(path)?.sha ?? null;
    const t = theirs.get(path)?.sha ?? null;
    if (o === t) { if (o !== null) files.set(path, o); continue; }
    if (b === o) { if (t !== null) files.set(path, t); continue; }
    if (b === t) { if (o !== null) files.set(path, o); continue; }
    conflict = true;
  }
  return { files, conflict };
}

/** Line counts for a pull file entry (multiset line diff). */
export function lineCounts(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  const linesOf = (b: Buffer | null): Map<string, number> => {
    const m = new Map<string, number>();
    if (b === null) return m;
    const text = b.toString('utf8');
    const parts = text.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    for (const line of parts) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const oldLines = linesOf(oldContent);
  const newLines = linesOf(newContent);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}
