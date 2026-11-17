// REST v3 handlers (/api/v3). Implements the exact wire contract from the
// rest spec: statuses, shapes, pagination (Link rel="next"), auth (401),
// foreign owner (404, never 403), duplicate repo (422), contents 201/200/409,
// squash merge 200/404/405. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors carry {"message": ...}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Store, type Repo, type Issue, type Pull } from './store.ts';
import { buildTree } from './gitobj.ts';

/** The tree sha of a subdirectory, rebuilt from the flat tree map (deterministic). */
function dirTreeSha(repo: Repo, tree: Map<string, { sha: string; mode: string }>, dirPath: string): string {
  const sub = new Map<string, string>();
  const prefix = `${dirPath}/`;
  for (const [p, e] of tree) if (p.startsWith(prefix)) sub.set(p.slice(prefix.length), e.sha);
  return buildTree(repo.objects, sub);
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) { res.writeHead(204, headers); res.end(); return; }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => { total += c.length; if (total > 10 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns {ok:false} on malformed JSON (caller sends 400). */
export function parseJson(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; }
  catch { return { ok: false }; }
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: store.globalId('repo', repo.id, 0),
    name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.nowIso, updated_at: store.nowIso, pushed_at: store.nowIso,
    has_issues: true, has_projects: true, has_wiki: true,
  };
}
export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: store.globalId('issue', repo.id, issue.number),
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: store.viewer, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: store.nowIso, updated_at: store.nowIso,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id, node_id: store.globalId('pull', repo.id, pull.number),
    number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeSha,
    mergeable: pull.merged ? false : true,
    user: { login: store.viewer, id: 1000, type: 'User' },
    created_at: store.nowIso, updated_at: store.nowIso,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function pageOf(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(items: T[], perPage: number, page: number): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, perPage: number, page: number, totalPages: number): string {
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${proto}://${host}${path}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${build(page + 1)}>; rel="next"`);
  if (totalPages > 1) parts.push(`<${build(totalPages)}>; rel="last"`);
  if (page > 1) { parts.push(`<${build(1)}>; rel="first"`); parts.push(`<${build(page - 1)}>; rel="prev"`); }
  return parts.join(', ');
}

/** Auth: the Bearer token must equal MAKEFUN_SHOP_TOKEN (or any non-empty token when unset locally). */
export function authed(req: IncomingMessage, store: Store): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (token.length === 0) return false;
  if (store.token.length === 0) return true; // local dev: no token configured
  return token === store.token;
}

/** Handle one /api/v3 request. Always sends a response. Returns true. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store, pathname: string, query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const reqId = store.nextRequestId();
  const baseHeaders: Record<string, string> = { 'x-github-request-id': reqId, 'x-oauth-scopes': 'repo, read:org' };
  const err = (status: number, message: string): void => { sendJson(res, status, { message }, baseHeaders); };
  const ok = (status: number, body: unknown, extra: Record<string, string> = {}): void => { sendJson(res, status, body, { ...baseHeaders, ...extra }); };

  // Auth first: every /api/v3 call needs the token.
  if (!authed(req, store)) { err(401, 'Bad credentials'); return true; }

  // Read + parse a JSON body for methods that carry one.
  let body: unknown = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const buf = await readBody(req);
    const parsed = parseJson(buf);
    if (!parsed.ok) { err(400, 'Problems parsing JSON'); return true; }
    body = parsed.value;
  }
  const b = asRecord(body);

  const parts = pathname.split('/').filter((s) => s.length > 0).slice(2); // after /api/v3
  const seg = (i: number): string => decodeURIComponent(parts[i] ?? '');

  // GET /api/v3/ (root) and /api/v3 (no slash)
  if (parts.length === 0) {
    if (method === 'GET') { ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }); return true; }
    err(404, 'Not Found'); return true;
  }
  // GET /api/v3/meta
  if (parts.length === 1 && parts[0] === 'meta') {
    if (method === 'GET') { ok(200, { installed_version: '1.0.0' }); return true; }
    err(404, 'Not Found'); return true;
  }
  // GET /api/v3/user
  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    ok(200, { login: store.viewer, id: 1000, type: 'User', name: store.viewer, email: `${store.viewer}@example.invalid` });
    return true;
  }
  // GET/POST /api/v3/user/repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = pageOf(query);
      const repos = store.listRepos();
      const { pageItems, totalPages } = paginate(repos, perPage, page);
      const extra: Record<string, string> = {};
      const link = linkHeader(req, pathname, query, perPage, page, totalPages);
      if (link) extra.link = link;
      ok(200, pageItems.map((r) => repoJson(store, r)), extra);
      return true;
    }
    if (method === 'POST') {
      const name = asString(b.name);
      if (!name) { err(422, 'Repository name is required'); return true; }
      const { repo, duplicate } = store.createRepo(name, asBool(b.private, false), asString(b.description, ''));
      if (duplicate) { err(422, 'Repository already exists'); return true; }
      ok(201, repoJson(store, repo as Repo));
      return true;
    }
    err(404, 'Not Found'); return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = seg(1);
    const name = seg(2);
    const repo = store.getRepo(owner, name);
    if (!repo) { err(404, 'Not Found'); return true; }
    const rest = parts.slice(3);

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') { ok(200, repoJson(store, repo)); return true; }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        ok(200, repoJson(store, repo)); return true;
      }
      if (method === 'DELETE') { store.deleteRepo(owner, name); sendJson(res, 204, null, baseHeaders); return true; }
      err(404, 'Not Found'); return true;
    }

    // /repos/{o}/{r}/branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        ok(200, store.listBranches(repo).map((br) => ({ name: br.name, commit: { sha: br.sha } })));
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const br = store.listBranches(repo).find((x) => x.name === seg(4));
        if (!br) { err(404, 'Not Found'); return true; }
        ok(200, { name: br.name, commit: { sha: br.sha } });
        return true;
      }
      err(404, 'Not Found'); return true;
    }

    // /repos/{o}/{r}/commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      ok(200, store.listCommits(repo, shaParam).map((c) => ({ sha: c.sha, commit: { message: c.message } })));
      return true;
    }

    // /repos/{o}/{r}/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = asString(b.ref);
        const sha = asString(b.sha);
        if (!ref || !sha || !store.createRef(repo, ref, sha)) { err(422, 'Invalid ref or sha'); return true; }
        ok(201, { ref, object: { sha } });
        return true;
      }
      if (method === 'GET' && rest.length >= 3) {
        // /git/refs/heads/{branch} (branch may contain slashes)
        const refPath = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
        const sha = repo.refs.get(refPath) ?? repo.refs.get(`refs/${refPath}`) ?? null;
        if (!sha) { err(404, 'Not Found'); return true; }
        const fullRef = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
        ok(200, { ref: fullRef, object: { sha } });
        return true;
      }
      err(404, 'Not Found'); return true;
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = query.get('ref');
      if (method === 'PUT') {
        const message = asString(b.message, 'Update file');
        const contentB64 = asString(b.content, '');
        const branch = asString(b.branch, repo.defaultBranch);
        const sha = typeof b.sha === 'string' ? b.sha : null;
        let content: Buffer;
        try { content = Buffer.from(contentB64, 'base64'); } catch { err(400, 'Invalid base64 content'); return true; }
        const result = store.commitFile(repo, branch, filePath, content, message, sha);
        if (result.status === 409) { err(409, 'Conflict: stale sha'); return true; }
        ok(result.status, { content: { sha: result.blobSha, encoding: 'base64' }, commit: { sha: result.commitSha } });
        return true;
      }
      if (method === 'GET') {
        const tree = store.treeAt(repo, refParam);
        if (tree === null) { err(404, 'Not Found'); return true; }
        const file = tree.get(filePath);
        if (file) {
          const obj = repo.objects.get(file.sha);
          const data = obj?.data ?? Buffer.alloc(0);
          ok(200, {
            type: 'file', encoding: 'base64', content: data.toString('base64'),
            sha: file.sha, size: data.length,
            name: filePath.split('/').pop() ?? filePath, path: filePath,
          });
          return true;
        }
        // Directory listing: immediate children of the prefix.
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
        for (const [p, e] of tree) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          if (restPath === '') continue;
          const slash = restPath.indexOf('/');
          if (slash === -1) {
            children.set(restPath, { type: 'file', name: restPath, path: p, sha: e.sha });
          } else {
            const dirName = restPath.slice(0, slash);
            if (!children.has(dirName)) {
              // The dir's sha is its tree sha: find it by rebuilding is costly; use the
              // first file's blob sha is wrong — compute the subtree sha from the tree.
              const dirSha = dirTreeSha(repo, tree, prefix + dirName);
              children.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: dirSha });
            }
          }
        }
        if (children.size === 0) { err(404, 'Not Found'); return true; }
        ok(200, [...children.values()]);
        return true;
      }
      if (method === 'DELETE') {
        const message = asString(b.message, 'Delete file');
        const branch = asString(b.branch, repo.defaultBranch);
        const result = store.deleteFile(repo, branch, filePath, message);
        if (result.status === 404) { err(404, 'Not Found'); return true; }
        ok(200, { commit: { sha: result.commitSha } });
        return true;
      }
      err(404, 'Not Found'); return true;
    }

    // /repos/{o}/{r}/labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const name = asString(b.name);
        if (!name) { err(422, 'Label name is required'); return true; }
        const label = store.createLabel(repo, name, asString(b.color, 'ededed'));
        ok(201, { name: label.name, color: label.color });
        return true;
      }
      if (method === 'GET' && rest.length === 1) {
        ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
        return true;
      }
      err(404, 'Not Found'); return true;
    }

    // /repos/{o}/{r}/issues...
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = asString(b.title, '');
          const bodyText = asString(b.body, '');
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          const issue = store.createIssue(repo, title, bodyText, labels);
          if (!issue) { err(422, 'Unknown label'); return true; }
          ok(201, issueJson(store, repo, issue));
          return true;
        }
        if (method === 'GET') {
          const { perPage, page } = pageOf(query);
          const state = query.get('state');
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const list = store.listIssues(repo, state, sort, direction);
          const { pageItems, totalPages } = paginate(list, perPage, page);
          const extra: Record<string, string> = {};
          const link = linkHeader(req, pathname, query, perPage, page, totalPages);
          if (link) extra.link = link;
          ok(200, pageItems.map((i) => issueJson(store, repo, i)), extra);
          return true;
        }
        err(404, 'Not Found'); return true;
      }
      const num = Number.parseInt(rest[1], 10);
      if (!Number.isSafeInteger(num)) { err(404, 'Not Found'); return true; }
      if (rest.length === 2) {
        if (method === 'GET') {
          const issue = store.getIssue(repo, num);
          if (!issue) { err(404, 'Not Found'); return true; }
          ok(200, issueJson(store, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const state = b.state === 'closed' ? 'closed' : b.state === 'open' ? 'open' : null;
          const issue = store.patchIssue(repo, num, state);
          if (!issue) { err(404, 'Not Found'); return true; }
          ok(200, issueJson(store, repo, issue));
          return true;
        }
        err(404, 'Not Found'); return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const comment = store.createComment(repo, num, asString(b.body, ''));
          if (!comment) { err(404, 'Not Found'); return true; }
          ok(201, { id: comment.id, body: comment.body });
          return true;
        }
        if (method === 'GET') {
          const comments = store.listComments(repo, num);
          if (comments === null) { err(404, 'Not Found'); return true; }
          ok(200, comments.map((c) => ({ id: c.id, body: c.body })));
          return true;
        }
        err(404, 'Not Found'); return true;
      }
      err(404, 'Not Found'); return true;
    }

    // /repos/{o}/{r}/pulls...
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const pull = store.createPull(repo, asString(b.title, ''), asString(b.body, ''), asString(b.head, ''), asString(b.base, ''));
          if (!pull) { err(422, 'Invalid head or base branch'); return true; }
          ok(201, pullJson(store, repo, pull));
          return true;
        }
        if (method === 'GET') {
          const { perPage, page } = pageOf(query);
          const state = query.get('state') ?? 'open';
          const list = store.listPulls(repo, state);
          const { pageItems, totalPages } = paginate(list, perPage, page);
          const extra: Record<string, string> = {};
          const link = linkHeader(req, pathname, query, perPage, page, totalPages);
          if (link) extra.link = link;
          ok(200, pageItems.map((p) => pullJson(store, repo, p)), extra);
          return true;
        }
        err(404, 'Not Found'); return true;
      }
      const num = Number.parseInt(rest[1], 10);
      if (!Number.isSafeInteger(num)) { err(404, 'Not Found'); return true; }
      if (rest.length === 2 && method === 'GET') {
        const pull = store.getPull(repo, num);
        if (!pull) { err(404, 'Not Found'); return true; }
        ok(200, pullJson(store, repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pull = store.getPull(repo, num);
        if (!pull) { err(404, 'Not Found'); return true; }
        ok(200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const result = store.mergePull(repo, num);
        if (result.status === 404) { err(404, 'Not Found'); return true; }
        if (result.status === 405) { err(405, 'Merge conflict'); return true; }
        ok(200, { sha: result.sha, merged: true, message: `Pull request #${num} successfully merged` });
        return true;
      }
      err(404, 'Not Found'); return true;
    }
    err(404, 'Not Found'); return true;
  }

  err(404, 'Not Found');
  return true;
}
