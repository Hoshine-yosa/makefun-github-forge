// MCP over streamable HTTP (JSON-RPC 2.0), modern revision 2026-07-28 with a
// legacy initialize handshake as fallback. Auth is enforced before dispatch
// on every method: no/wrong Authorization is exactly 401. tools/list is
// built once and answered byte-identically every time. Tools act on the
// same store REST reads.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Store } from './store.ts';
import { sendJson, readBody, authed } from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

interface ToolDef {
  name: string; description: string;
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo', description: 'Create a repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['owner', 'name'],
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue', description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues', description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Issue state: open, closed or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request', description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const TOOLS_LIST: Record<string, unknown>[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: { type: 'object', properties: t.properties, required: t.required },
}));

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function findTool(name: string): ToolDef | null {
  const want = normalizeName(name);
  for (const t of TOOLS) if (normalizeName(t.name) === want) return t;
  for (const t of TOOLS) {
    const n = normalizeName(t.name);
    if (n.length > want.length && n.endsWith(want)) return t;
  }
  return null;
}

function toolResult(obj: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asStr(v: unknown): string { return typeof v === 'string' ? v : ''; }
function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

async function callTool(store: Store, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, unknown>; errorCode?: number; errorMessage?: string }> {
  const tool = findTool(name);
  if (!tool) return { ok: false, errorCode: -32602, errorMessage: `Unknown tool: ${name}` };
  // Required-argument validation (the missing-arguments check sends {}).
  const missing = tool.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length > 0) return { ok: false, errorCode: -32602, errorMessage: `Missing required arguments: ${missing.join(', ')}` };

  switch (tool.name) {
    case 'create_repo': {
      const repoName = asStr(args.name);
      if (!repoName) return { ok: true, result: toolError('Repository name is required') };
      const { repo, duplicate } = store.createRepo(repoName, args.private === true, asStr(args.description));
      if (duplicate || !repo) return { ok: true, result: toolError(`Repository ${repoName} already exists`) };
      return { ok: true, result: toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }) };
    }
    case 'get_repo': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (!repo) return { ok: true, result: toolError(`Repository ${asStr(args.owner)}/${asStr(args.repo)} not found`) };
      return { ok: true, result: toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }) };
    }
    case 'create_issue': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (!repo) return { ok: true, result: toolError(`Repository ${asStr(args.owner)}/${asStr(args.repo)} not found`) };
      const issue = store.createIssue(repo, asStr(args.title), asStr(args.body), []);
      if (!issue) return { ok: true, result: toolError('Could not create the issue') };
      return { ok: true, result: toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, full_name: `${repo.owner}/${repo.name}` }) };
    }
    case 'list_issues': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (!repo) return { ok: true, result: toolError(`Repository ${asStr(args.owner)}/${asStr(args.repo)} not found`) };
      const state = asStr(args.state) || 'open';
      const list = store.listIssues(repo, state === 'all' ? 'all' : state, 'created', 'asc');
      const issues = list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return { ok: true, result: toolResult({ issues }) };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (!repo) return { ok: true, result: toolError(`Repository ${asStr(args.owner)}/${asStr(args.repo)} not found`) };
      const pull = store.createPull(repo, asStr(args.title), asStr(args.body), asStr(args.head), asStr(args.base));
      if (!pull) return { ok: true, result: toolError('Could not create the pull request: unknown head or base branch') };
      return { ok: true, result: toolResult({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: pull.headRef, base: pull.baseRef }) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (!repo) return { ok: true, result: toolError(`Repository ${asStr(args.owner)}/${asStr(args.repo)} not found`) };
      const num = asNum(args.pull_number);
      if (num === null) return { ok: false, errorCode: -32602, errorMessage: 'pull_number must be an integer' };
      const result = store.mergePull(repo, num);
      if (result.status === 404) return { ok: true, result: toolError(`Pull request #${num} not found`) };
      if (result.status === 405) return { ok: true, result: toolError(`Pull request #${num} has a merge conflict`) };
      return { ok: true, result: toolResult({ number: num, merged: true, state: 'closed', sha: result.sha }) };
    }
    default:
      return { ok: false, errorCode: -32602, errorMessage: `Unknown tool: ${name}` };
  }
}

/** Handle one POST /mcp request (and tolerate DELETE for legacy session teardown). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const reqId = store.nextRequestId();
  const headers: Record<string, string> = { 'x-github-request-id': reqId };
  if (req.method === 'DELETE') { res.writeHead(200, headers); res.end(); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, headers); return; }

  // Auth before dispatch, on every method.
  if (!authed(req, store)) { sendJson(res, 401, { message: 'Bad credentials' }, headers); return; }

  const buf = await readBody(req);
  let body: unknown;
  try { body = JSON.parse(buf.toString('utf8')); }
  catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, headers);
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, headers);
    return;
  }
  const rpc = body as Record<string, unknown>;
  const id = rpc.id === undefined ? null : rpc.id;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (rpc.params !== null && typeof rpc.params === 'object' && !Array.isArray(rpc.params)) ? (rpc.params as Record<string, unknown>) : {};

  // A notification (no id) gets no JSON-RPC response.
  const isNotification = rpc.id === undefined;

  const result = (value: unknown): void => {
    if (isNotification) { res.writeHead(202, headers); res.end(); return; }
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value }, headers);
  };
  const rpcError = (code: number, message: string): void => {
    if (isNotification) { res.writeHead(202, headers); res.end(); return; }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } }, headers);
  };

  if (method === 'server/discover') {
    result({
      supportedVersions: [REVISION, '2025-11-25', '2025-06-18'],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
    result({
      protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : REVISION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'notifications/initialized') { res.writeHead(202, headers); res.end(); return; }
  if (method === 'tools/list') {
    result({ tools: TOOLS_LIST });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>) : {};
    const outcome = await callTool(store, name, args);
    if (!outcome.ok) { rpcError(outcome.errorCode ?? -32602, outcome.errorMessage ?? 'Invalid params'); return; }
    result(outcome.result);
    return;
  }
  if (method === 'ping') { result({}); return; }
  rpcError(-32601, `Method not found: ${method}`);
}
