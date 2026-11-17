// GraphQL v4 executor for the exact documents gh and github-mcp-server send.
// A small recursive-descent parser plus a schema-aware resolver over the
// shared store. Unknown fields answer HTTP 200 with an errors array naming
// the field; an unknown repository is data.repository = null with no errors;
// a missing token is exactly 401; a JSON array body is answered in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Store, type Repo, type Issue, type Pull } from './store.ts';
import { sendJson, readBody, parseJson, authed } from './rest.ts';

// ---------- parser ----------
type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface Selection {
  alias: string | null; name: string; args: Map<string, Value>;
  children: Selection[]; fragmentOn: string | null;
}
interface Operation {
  kind: 'query' | 'mutation'; name: string | null;
  vars: Map<string, Value | null>; selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) { this.src = src; }
  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos += 1;
      else if (c === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; }
      else break;
    }
  }
  private peek(): string { this.skipWs(); return this.src[this.pos] ?? ''; }
  private eat(ch: string): boolean { this.skipWs(); if (this.src[this.pos] === ch) { this.pos += 1; return true; } return false; }
  private expect(ch: string): void { if (!this.eat(ch)) throw new Error(`expected ${ch} at ${this.pos}`); }
  private readName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  private readString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '"') { this.pos += 1; return out; }
      if (c === '\\') { this.pos += 1; const e = this.src[this.pos]; out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; this.pos += 1; continue; }
      out += c; this.pos += 1;
    }
    throw new Error('unterminated string');
  }
  private readNumber(): number {
    this.skipWs();
    const m = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected number at ${this.pos}`);
    this.pos += m[0].length;
    return Number(m[0]);
  }
  parseValue(): Value {
    const c = this.peek();
    if (c === '$') { this.pos += 1; return { kind: 'var', name: this.readName() }; }
    if (c === '"') return { kind: 'string', value: this.readString() };
    if (c === '[') {
      this.pos += 1;
      const items: Value[] = [];
      while (!this.eat(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (c === '{') {
      this.pos += 1;
      const fields = new Map<string, Value>();
      while (!this.eat('}')) { const k = this.readName(); this.expect(':'); fields.set(k, this.parseValue()); }
      return { kind: 'object', fields };
    }
    if (c === '-' || (c >= '0' && c <= '9')) return { kind: 'int', value: this.readNumber() };
    const name = this.readName();
    if (name === 'true') return { kind: 'bool', value: true };
    if (name === 'false') return { kind: 'bool', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }
  private parseArgs(): Map<string, Value> {
    const args = new Map<string, Value>();
    if (!this.eat('(')) return args;
    while (!this.eat(')')) { const k = this.readName(); this.expect(':'); args.set(k, this.parseValue()); }
    return args;
  }
  private parseSelections(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.eat('}')) {
      if (this.src.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skipWs();
        let fragmentOn: string | null = null;
        if (this.src.slice(this.pos, this.pos + 2) === 'on' && !/[A-Za-z0-9_]/.test(this.src[this.pos + 2] ?? '')) {
          this.pos += 2;
          this.skipWs();
          fragmentOn = this.readName();
        }
        const children = this.parseSelections();
        for (const child of children) out.push({ ...child, fragmentOn });
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      if (this.eat(':')) { alias = first; name = this.readName(); }
      const args = this.parseArgs();
      const children = this.peek() === '{' ? this.parseSelections() : [];
      out.push({ alias, name, args, children, fragmentOn: null });
    }
    return out;
  }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.src.length) {
      this.skipWs();
      if (this.pos >= this.src.length) break;
      let kind: 'query' | 'mutation' = 'query';
      const word = this.peek();
      if (word === 'q' || word === 'm') {
        const name = this.readName();
        if (name === 'mutation') kind = 'mutation';
        else if (name !== 'query') throw new Error(`unexpected ${name}`);
      }
      let opName: string | null = null;
      if (/[A-Za-z_]/.test(this.peek())) opName = this.readName();
      const vars = new Map<string, Value | null>();
      if (this.eat('(')) {
        while (!this.eat(')')) {
          this.eat('$');
          const vname = this.readName();
          this.expect(':');
          // Skip the type (may be [X!]! etc.) until '=' or ')'.
          let depth = 0;
          while (this.pos < this.src.length) {
            const c = this.src[this.pos];
            if (c === '[' || c === '(') depth += 1;
            if (c === ']' || c === ')') { if (depth === 0) break; depth -= 1; }
            if (c === '=' && depth === 0) break;
            this.pos += 1;
          }
          let def: Value | null = null;
          if (this.eat('=')) def = this.parseValue();
          vars.set(vname, def);
        }
      }
      const selections = this.parseSelections();
      ops.push({ kind, name: opName, vars, selections });
    }
    return ops;
  }
}

function resolveValue(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'string': case 'int': case 'bool': case 'enum': return v.value;
    case 'null': return null;
    case 'list': return v.items.map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = resolveValue(val, vars);
      return out;
    }
  }
}
function argOf(sel: Selection, name: string, vars: Record<string, unknown>): unknown {
  const v = sel.args.get(name);
  return v === undefined ? undefined : resolveValue(v, vars);
}

// ---------- schema ----------
const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PR_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'url', 'createdAt', 'updatedAt', 'author'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ---------- executor ----------
interface Ctx { store: Store; errors: { message: string }[]; }

function issueStateGql(state: 'open' | 'closed'): string { return state === 'open' ? 'OPEN' : 'CLOSED'; }
function prStateGql(pull: Pull): string { return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'; }

function selectIssue(ctx: Ctx, repo: Repo, issue: Issue, sels: Selection[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sels) {
    const key = s.alias ?? s.name;
    switch (s.name) {
      case 'id': out[key] = ctx.store.globalId('issue', repo.id, issue.number); break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'state': out[key] = issueStateGql(issue.state); break;
      case 'body': out[key] = issue.body; break;
      default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "Issue".` }); break;
    }
  }
  return out;
}

function selectPull(ctx: Ctx, repo: Repo, pull: Pull, sels: Selection[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sels) {
    const key = s.alias ?? s.name;
    switch (s.name) {
      case 'id': out[key] = ctx.store.globalId('pull', repo.id, pull.number); break;
      case 'number': out[key] = pull.number; break;
      case 'title': out[key] = pull.title; break;
      case 'state': out[key] = prStateGql(pull); break;
      case 'body': out[key] = pull.body; break;
      case 'headRefName': out[key] = pull.headRef; break;
      case 'baseRefName': out[key] = pull.baseRef; break;
      case 'mergeable': out[key] = pull.merged ? 'UNKNOWN' : 'MERGEABLE'; break;
      case 'merged': out[key] = pull.merged; break;
      case 'files': {
        const first = argOf(s, 'first', vars);
        const nodes: Record<string, unknown>[] = [];
        for (const c of s.children) {
          if (c.name === 'nodes') {
            for (const f of pull.files.slice(0, typeof first === 'number' ? first : pull.files.length)) {
              nodes.push(selectFile(f, c.children, vars, ctx));
            }
          } else ctx.errors.push({ message: `Cannot query field "${c.name}" on type "PullRequestChangedFileConnection".` });
        }
        out[key] = { nodes };
        break;
      }
      default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "PullRequest".` }); break;
    }
  }
  return out;
}

function selectFile(f: { filename: string }, sels: Selection[], vars: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sels) {
    const key = s.alias ?? s.name;
    if (s.name === 'path') out[key] = f.filename;
    else ctx.errors.push({ message: `Cannot query field "${s.name}" on type "PullRequestChangedFile".` });
  }
  return out;
}

function cursorFor(n: number): string { return Buffer.from(`cursor:${n}`, 'utf8').toString('base64'); }
function numberAfter(after: unknown): number {
  if (typeof after !== 'string' || after.length === 0) return 0;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

function selectRepo(ctx: Ctx, repo: Repo, sels: Selection[], vars: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const out: Record<string, unknown> = {};
  for (const s of sels) {
    const key = s.alias ?? s.name;
    switch (s.name) {
      case 'id': out[key] = store.globalId('repo', repo.id, 0); break;
      case 'databaseId': out[key] = repo.id; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = `${repo.owner}/${repo.name}`; break;
      case 'owner': {
        const ownerOut: Record<string, unknown> = {};
        for (const c of s.children) if (c.name === 'login') ownerOut[c.alias ?? 'login'] = repo.owner;
        else ctx.errors.push({ message: `Cannot query field "${c.name}" on type "User".` });
        out[key] = ownerOut;
        break;
      }
      case 'defaultBranchRef': {
        const refOut: Record<string, unknown> = {};
        for (const c of s.children) if (c.name === 'name') refOut[c.alias ?? 'name'] = repo.defaultBranch;
        else ctx.errors.push({ message: `Cannot query field "${c.name}" on type "Ref".` });
        out[key] = refOut;
        break;
      }
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'issue': {
        const num = argOf(s, 'number', vars);
        const issue = typeof num === 'number' ? store.getIssue(repo, num) : null;
        out[key] = issue ? selectIssue(ctx, repo, issue, s.children, vars) : null;
        break;
      }
      case 'issues': {
        const first = argOf(s, 'first', vars);
        const states = argOf(s, 'states', vars) as string[] | undefined;
        const orderBy = argOf(s, 'orderBy', vars) as { field?: string; direction?: string } | undefined;
        const after = argOf(s, 'after', vars);
        let list = repo.issues.slice();
        if (Array.isArray(states) && states.length > 0) {
          const want = new Set(states.map((x) => String(x).toLowerCase()));
          list = list.filter((i) => want.has(i.state));
        }
        if (orderBy?.field === 'CREATED_AT') {
          list.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
        }
        const afterNum = numberAfter(after);
        if (afterNum > 0) list = list.filter((i) => i.number > afterNum);
        const total = list.length;
        const limit = typeof first === 'number' ? first : total;
        const page = list.slice(0, limit);
        const nodes: Record<string, unknown>[] = [];
        let pageInfo: Record<string, unknown> = { hasNextPage: false, endCursor: null };
        for (const c of s.children) {
          if (c.name === 'nodes') {
            for (const issue of page) nodes.push(selectIssue(ctx, repo, issue, c.children, vars));
          } else if (c.name === 'pageInfo') {
            const info: Record<string, unknown> = {};
            for (const p of c.children) {
              if (p.name === 'hasNextPage') info[p.alias ?? 'hasNextPage'] = total > limit;
              else if (p.name === 'endCursor') info[p.alias ?? 'endCursor'] = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
              else ctx.errors.push({ message: `Cannot query field "${p.name}" on type "PageInfo".` });
            }
            pageInfo = info;
          } else ctx.errors.push({ message: `Cannot query field "${c.name}" on type "IssueConnection".` });
        }
        out[key] = { nodes, pageInfo };
        break;
      }
      case 'pullRequests': {
        const first = argOf(s, 'first', vars);
        const list = repo.pulls.slice();
        const limit = typeof first === 'number' ? first : list.length;
        const nodes: Record<string, unknown>[] = [];
        for (const c of s.children) {
          if (c.name === 'nodes') {
            for (const pull of list.slice(0, limit)) nodes.push(selectPull(ctx, repo, pull, c.children, vars));
          } else ctx.errors.push({ message: `Cannot query field "${c.name}" on type "PullRequestConnection".` });
        }
        out[key] = { nodes };
        break;
      }
      case 'pullRequest': {
        const num = argOf(s, 'number', vars);
        const pull = typeof num === 'number' ? store.getPull(repo, num) : null;
        out[key] = pull ? selectPull(ctx, repo, pull, s.children, vars) : null;
        break;
      }
      default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "Repository".` }); break;
    }
  }
  return out;
}

function selectType(ctx: Ctx, name: string, sels: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PR_FIELDS : name === 'Repository' ? REPO_FIELDS : [];
  const enums = name === 'SearchType' ? SEARCH_ENUM : [];
  for (const s of sels) {
    const key = s.alias ?? s.name;
    if (s.name === 'fields') {
      out[key] = fields.map((f) => {
        const fo: Record<string, unknown> = {};
        for (const c of s.children) if (c.name === 'name') fo[c.alias ?? 'name'] = f;
        return fo;
      });
    } else if (s.name === 'enumValues') {
      out[key] = enums.map((e) => {
        const eo: Record<string, unknown> = {};
        for (const c of s.children) if (c.name === 'name') eo[c.alias ?? 'name'] = e;
        return eo;
      });
    } else if (s.name === 'name') out[key] = name;
    else ctx.errors.push({ message: `Cannot query field "${s.name}" on type "__Type".` });
  }
  return out;
}

function executeOperation(ctx: Ctx, op: Operation, vars: Record<string, unknown>): Record<string, unknown> | null {
  const store = ctx.store;
  const data: Record<string, unknown> = {};
  if (op.kind === 'mutation') {
    for (const s of op.selections) {
      const key = s.alias ?? s.name;
      const input = argOf(s, 'input', vars) as Record<string, unknown> | undefined;
      if (s.name === 'createIssue') {
        const repoId = typeof input?.repositoryId === 'string' ? store.resolveGlobalId(input.repositoryId) : null;
        const repo = repoId?.kind === 'repo' ? store.repoById(repoId.repoId) : null;
        if (!repo) { ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' }); data[key] = null; continue; }
        const issue = store.createIssue(repo, String(input?.title ?? ''), String(input?.body ?? ''), []);
        data[key] = issue ? { issue: { number: issue.number, id: store.globalId('issue', repo.id, issue.number) } } : null;
      } else if (s.name === 'closeIssue') {
        const ref = typeof input?.issueId === 'string' ? store.resolveGlobalId(input.issueId) : null;
        const repo = ref ? store.repoById(ref.repoId) : null;
        const issue = repo && ref?.kind === 'issue' ? store.getIssue(repo, ref.number) : null;
        if (!issue) { ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' }); data[key] = null; continue; }
        issue.state = 'closed';
        const out: Record<string, unknown> = {};
        for (const c of s.children) {
          if (c.name === 'issue') {
            const io: Record<string, unknown> = {};
            for (const f of c.children) {
              if (f.name === 'number') io[f.alias ?? 'number'] = issue.number;
              else if (f.name === 'id') io[f.alias ?? 'id'] = store.globalId('issue', repo.id, issue.number);
              else if (f.name === 'state') io[f.alias ?? 'state'] = 'CLOSED';
            }
            out[c.alias ?? 'issue'] = io;
          }
        }
        data[key] = out;
      } else if (s.name === 'createPullRequest') {
        const repoId = typeof input?.repositoryId === 'string' ? store.resolveGlobalId(input.repositoryId) : null;
        const repo = repoId?.kind === 'repo' ? store.repoById(repoId.repoId) : null;
        const pull = repo ? store.createPull(repo, String(input?.title ?? ''), String(input?.body ?? ''), String(input?.headRefName ?? ''), String(input?.baseRefName ?? '')) : null;
        if (!pull || !repo) { ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' }); data[key] = null; continue; }
        const out: Record<string, unknown> = {};
        for (const c of s.children) {
          if (c.name === 'pullRequest') {
            const po: Record<string, unknown> = {};
            for (const f of c.children) {
              if (f.name === 'number') po[f.alias ?? 'number'] = pull.number;
              else if (f.name === 'id') po[f.alias ?? 'id'] = store.globalId('pull', repo.id, pull.number);
              else if (f.name === 'state') po[f.alias ?? 'state'] = 'OPEN';
              else if (f.name === 'headRefName') po[f.alias ?? 'headRefName'] = pull.headRef;
              else if (f.name === 'baseRefName') po[f.alias ?? 'baseRefName'] = pull.baseRef;
            }
            out[c.alias ?? 'pullRequest'] = po;
          }
        }
        data[key] = out;
      } else if (s.name === 'mergePullRequest') {
        const ref = typeof input?.pullRequestId === 'string' ? store.resolveGlobalId(input.pullRequestId) : null;
        const repo = ref ? store.repoById(ref.repoId) : null;
        const result = repo && ref?.kind === 'pull' ? store.mergePull(repo, ref.number) : { status: 404 as const, sha: null };
        const pull = repo && ref ? store.getPull(repo, ref.number) : null;
        if (result.status !== 200 || !pull || !repo) { ctx.errors.push({ message: 'Could not merge the pull request.' }); data[key] = null; continue; }
        const out: Record<string, unknown> = {};
        for (const c of s.children) {
          if (c.name === 'pullRequest') {
            const po: Record<string, unknown> = {};
            for (const f of c.children) {
              if (f.name === 'number') po[f.alias ?? 'number'] = pull.number;
              else if (f.name === 'merged') po[f.alias ?? 'merged'] = true;
              else if (f.name === 'state') po[f.alias ?? 'state'] = 'MERGED';
              else if (f.name === 'id') po[f.alias ?? 'id'] = store.globalId('pull', repo.id, pull.number);
            }
            out[c.alias ?? 'pullRequest'] = po;
          }
        }
        data[key] = out;
      } else if (s.name === 'addComment') {
        const ref = typeof input?.subjectId === 'string' ? store.resolveGlobalId(input.subjectId) : null;
        const repo = ref ? store.repoById(ref.repoId) : null;
        const comment = repo && ref?.kind === 'issue' ? store.createComment(repo, ref.number, String(input?.body ?? '')) : null;
        if (!comment || !repo || !ref) { ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' }); data[key] = null; continue; }
        const out: Record<string, unknown> = {};
        for (const c of s.children) {
          if (c.name === 'commentEdge') {
            const eo: Record<string, unknown> = {};
            for (const n of c.children) {
              if (n.name === 'node') {
                const no: Record<string, unknown> = {};
                for (const f of n.children) {
                  if (f.name === 'id') no[f.alias ?? 'id'] = store.globalId('comment', repo.id, ref.number, comment.id);
                  else if (f.name === 'body') no[f.alias ?? 'body'] = comment.body;
                }
                eo[n.alias ?? 'node'] = no;
              }
            }
            out[c.alias ?? 'commentEdge'] = eo;
          }
        }
        data[key] = out;
      } else {
        ctx.errors.push({ message: `Cannot query field "${s.name}" on type "Mutation".` });
      }
    }
    return data;
  }

  // query
  for (const s of op.selections) {
    const key = s.alias ?? s.name;
    if (s.name === 'viewer') {
      const vOut: Record<string, unknown> = {};
      for (const c of s.children) {
        if (c.name === 'login') vOut[c.alias ?? 'login'] = store.viewer;
        else ctx.errors.push({ message: `Cannot query field "${c.name}" on type "User".` });
      }
      data[key] = vOut;
    } else if (s.name === 'repository') {
      const owner = argOf(s, 'owner', vars);
      const name = argOf(s, 'name', vars);
      const repo = typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) : null;
      data[key] = repo ? selectRepo(ctx, repo, s.children, vars) : null;
    } else if (s.name === 'node') {
      const id = argOf(s, 'id', vars);
      const ref = typeof id === 'string' ? store.resolveGlobalId(id) : null;
      if (!ref || ref.kind !== 'repo') { data[key] = null; continue; }
      const repo = store.repoById(ref.repoId);
      if (!repo) { data[key] = null; continue; }
      const nOut: Record<string, unknown> = {};
      for (const c of s.children) {
        if (c.name === 'id') nOut[c.alias ?? 'id'] = id;
        else if (c.fragmentOn === 'Repository') {
          if (c.name === 'name') nOut[c.alias ?? 'name'] = repo.name;
          else if (c.name === 'nameWithOwner') nOut[c.alias ?? 'nameWithOwner'] = `${repo.owner}/${repo.name}`;
          else ctx.errors.push({ message: `Cannot query field "${c.name}" on type "Repository".` });
        } else if (c.name === '__typename') nOut[c.alias ?? '__typename'] = 'Repository';
        else ctx.errors.push({ message: `Cannot query field "${c.name}" on type "Node".` });
      }
      data[key] = nOut;
    } else if (s.name === '__type') {
      const name = argOf(s, 'name', vars);
      data[key] = typeof name === 'string' ? selectType(ctx, name, s.children) : null;
    } else {
      ctx.errors.push({ message: `Cannot query field "${s.name}" on type "Query".` });
    }
  }
  return data;
}

function runOne(ctx: Ctx, body: unknown): Record<string, unknown> {
  const b = (body !== null && typeof body === 'object' && !Array.isArray(body)) ? (body as Record<string, unknown>) : {};
  const query = typeof b.query === 'string' ? b.query : '';
  const vars = (b.variables !== null && typeof b.variables === 'object' && !Array.isArray(b.variables)) ? (b.variables as Record<string, unknown>) : {};
  try {
    const ops = new Parser(query).parseDocument();
    if (ops.length === 0) return { data: null, errors: [{ message: 'No operations in the document.' }] };
    const data = executeOperation(ctx, ops[0], vars);
    if (ctx.errors.length > 0) return { data, errors: ctx.errors };
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse the document.' }] };
  }
}

/** Handle one POST /api/graphql request. Always sends a response. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const reqId = store.nextRequestId();
  const headers: Record<string, string> = { 'x-github-request-id': reqId };
  if (!authed(req, store)) { sendJson(res, 401, { message: 'Bad credentials' }, headers); return; }
  const buf = await readBody(req);
  const parsed = parseJson(buf);
  if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, headers); return; }
  const ctx: Ctx = { store, errors: [] };
  if (Array.isArray(parsed.value)) {
    const out = parsed.value.map((entry) => runOne({ store, errors: [] }, entry));
    sendJson(res, 200, out, headers);
    return;
  }
  sendJson(res, 200, runOne(ctx, parsed.value), headers);
}
