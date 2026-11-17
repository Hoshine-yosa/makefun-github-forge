// GraphQL + MCP smoke test, using the exact documents gh sends.
const BASE = process.env.BASE ?? 'http://127.0.0.1:18099';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token-123';
const OWNER = 'adaiversen';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = ''): void {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name} ${extra}`); }
}
async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
async function gql(query: string, variables: Record<string, unknown> = {}): Promise<{ status: number; json: any }> {
  return req('POST', '/api/graphql', { query, variables });
}

const DOCS = {
  viewerLogin: `query ViewerLogin { viewer { login } }`,
  repositoryFields: `query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }`,
  issueFields: `query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }`,
  typeFields: `query PullRequestAndRepositoryFields { PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } } Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } } }`,
  searchType: `query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }`,
  openIssues: `query OpenIssues($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } } }`,
  issueByNumber: `query IssueByNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { number title state id body } } }`,
  createIssue: `mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }`,
  closeIssue: `mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }`,
  pullRequests: `query PullRequests($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } } } }`,
  pullRequestFiles: `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { number files(first: 10) { nodes { path } } } } }`,
  pullRequestId: `query PullRequestId($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id number } } }`,
  createPullRequest: `mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }`,
  mergePullRequest: `mutation MergePullRequest($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { number merged state } } }`,
  addComment: `mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id body } } } }`,
  invalidField: `query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }`,
  nodeRepository: `query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }`,
  issuesPage: `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }`,
};

async function main(): Promise<void> {
  // Setup: repo + a branch with a commit (via REST contents), 2 issues, 1 closed.
  let r = await req('POST', '/api/v3/user/repos', { name: 'gql-repo', description: 'graphql', private: true });
  ok(r.status === 201, 'create gql repo', `got ${r.status}`);
  r = await req('PUT', `/api/v3/repos/${OWNER}/gql-repo/contents/README.md`, { message: 'init', content: b64('# gql\n'), branch: 'main' });
  ok(r.status === 201, 'seed commit on main', `got ${r.status}`);
  r = await req('POST', `/api/v3/repos/${OWNER}/gql-repo/git/refs`, { ref: 'refs/heads/feature', sha: r.json?.commit?.sha });
  ok(r.status === 201, 'create feature branch', `got ${r.status}`);
  await req('PUT', `/api/v3/repos/${OWNER}/gql-repo/contents/feat.txt`, { message: 'feat', content: b64('feature\n'), branch: 'feature' });
  const issueIds: string[] = [];
  for (let i = 1; i <= 7; i += 1) {
    const ir = await req('POST', `/api/v3/repos/${OWNER}/gql-repo/issues`, { title: `issue ${i}`, body: `body ${i}` });
    if (i === 1) issueIds.push(ir.json?.id ?? 0);
  }
  // Close issue 2 via REST.
  await req('PATCH', `/api/v3/repos/${OWNER}/gql-repo/issues/2`, { state: 'closed' });

  // 1. viewer login
  let g = await gql(DOCS.viewerLogin);
  ok(g.status === 200 && !g.json?.errors && g.json?.data?.viewer?.login === OWNER, 'viewer login', JSON.stringify(g.json)?.slice(0, 200));

  // 2. repository fields
  g = await gql(DOCS.repositoryFields, { owner: OWNER, name: 'gql-repo' });
  const repo = g.json?.data?.repository;
  ok(g.status === 200 && !g.json?.errors && repo?.name === 'gql-repo' && repo?.owner?.login === OWNER && typeof repo?.id === 'string' && repo.id.length > 0 && Number.isInteger(repo?.databaseId) && repo?.databaseId > 0 && ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(repo?.viewerPermission) && repo?.hasIssuesEnabled === true && repo?.defaultBranchRef?.name === 'main', 'repository fields', JSON.stringify(repo)?.slice(0, 300));
  const repoId = repo?.id as string;

  // 3. introspection: Issue / PullRequest / Repository / SearchType
  g = await gql(DOCS.issueFields);
  const issueFieldNames = (g.json?.data?.Issue?.fields ?? []).map((f: any) => f.name);
  ok(!g.json?.errors && ['id', 'number', 'title', 'state', 'body'].every((f) => issueFieldNames.includes(f)), 'introspection Issue fields', issueFieldNames.join(','));
  g = await gql(DOCS.typeFields);
  const prFieldNames = (g.json?.data?.PullRequest?.fields ?? []).map((f: any) => f.name);
  const repoFieldNames = (g.json?.data?.Repository?.fields ?? []).map((f: any) => f.name);
  ok(!g.json?.errors && ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((f) => prFieldNames.includes(f)), 'introspection PullRequest fields', prFieldNames.join(','));
  ok(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((f) => repoFieldNames.includes(f)), 'introspection Repository fields', repoFieldNames.join(','));
  g = await gql(DOCS.searchType);
  const enumNames = (g.json?.data?.SearchType?.enumValues ?? []).map((f: any) => f.name);
  ok(!g.json?.errors && enumNames.includes('ISSUE'), 'introspection SearchType enum', enumNames.join(','));

  // 4. open issues (7 created, 1 closed -> 6 open, newest first)
  g = await gql(DOCS.openIssues, { owner: OWNER, name: 'gql-repo', first: 10 });
  const nodes = g.json?.data?.repository?.issues?.nodes ?? [];
  ok(!g.json?.errors && nodes.length === 6 && nodes[0].number === 7 && nodes.every((n: any) => n.state === 'OPEN'), 'open issues DESC', JSON.stringify(nodes.map((n: any) => n.number)));

  // 5. issue by number
  g = await gql(DOCS.issueByNumber, { owner: OWNER, name: 'gql-repo', number: 3 });
  ok(!g.json?.errors && g.json?.data?.repository?.issue?.title === 'issue 3' && g.json?.data?.repository?.issue?.body === 'body 3', 'issue by number', JSON.stringify(g.json?.data));

  // 6. create issue via mutation (round-trips to REST)
  g = await gql(DOCS.createIssue, { input: { repositoryId: repoId, title: 'gql issue', body: 'via gql' } });
  const newIssue = g.json?.data?.createIssue?.issue;
  ok(!g.json?.errors && newIssue?.number === 8 && typeof newIssue?.id === 'string', 'createIssue mutation', JSON.stringify(g.json?.data));
  const restIssue = await req('GET', `/api/v3/repos/${OWNER}/gql-repo/issues/8`);
  ok(restIssue.json?.title === 'gql issue', 'createIssue visible over REST');

  // 7. close issue via mutation
  g = await gql(DOCS.closeIssue, { input: { issueId: newIssue.id } });
  ok(!g.json?.errors && g.json?.data?.closeIssue?.issue?.state === 'CLOSED', 'closeIssue mutation', JSON.stringify(g.json?.data));
  const restClosed = await req('GET', `/api/v3/repos/${OWNER}/gql-repo/issues/8`);
  ok(restClosed.json?.state === 'closed', 'closeIssue visible over REST');

  // 8. PR create via mutation, list, files, id, merge
  g = await gql(DOCS.createPullRequest, { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'feature', title: 'gql pr', body: 'pr body' } });
  const pr = g.json?.data?.createPullRequest?.pullRequest;
  ok(!g.json?.errors && pr?.number === 1 && pr?.state === 'OPEN' && pr?.headRefName === 'feature' && pr?.baseRefName === 'main', 'createPullRequest mutation', JSON.stringify(g.json?.data));
  g = await gql(DOCS.pullRequests, { owner: OWNER, name: 'gql-repo', first: 10 });
  const prNodes = g.json?.data?.repository?.pullRequests?.nodes ?? [];
  ok(!g.json?.errors && prNodes.length === 1 && prNodes[0].mergeable === 'MERGEABLE', 'pullRequests list', JSON.stringify(prNodes));
  g = await gql(DOCS.pullRequestFiles, { owner: OWNER, name: 'gql-repo', number: 1 });
  const fileNodes = g.json?.data?.repository?.pullRequest?.files?.nodes ?? [];
  ok(!g.json?.errors && fileNodes.some((f: any) => f.path === 'feat.txt'), 'pullRequest files', JSON.stringify(fileNodes));
  g = await gql(DOCS.pullRequestId, { owner: OWNER, name: 'gql-repo', number: 1 });
  const prId = g.json?.data?.repository?.pullRequest?.id;
  ok(!g.json?.errors && prId === pr.id, 'pullRequest id round-trip', `${prId} vs ${pr.id}`);
  g = await gql(DOCS.mergePullRequest, { input: { pullRequestId: prId, mergeMethod: 'SQUASH' } });
  ok(!g.json?.errors && g.json?.data?.mergePullRequest?.pullRequest?.merged === true, 'mergePullRequest mutation', JSON.stringify(g.json?.data));
  const restPr = await req('GET', `/api/v3/repos/${OWNER}/gql-repo/pulls/1`);
  ok(restPr.json?.merged === true && restPr.json?.state === 'closed', 'merge visible over REST');

  // 9. add comment (subjectId is the issue's GraphQL global id)
  const issue1 = await gql(DOCS.issueByNumber, { owner: OWNER, name: 'gql-repo', number: 1 });
  const issue1GqlId = issue1.json?.data?.repository?.issue?.id as string;
  g = await gql(DOCS.addComment, { input: { subjectId: issue1GqlId, body: 'hello from gql' } });
  ok(!g.json?.errors && g.json?.data?.addComment?.commentEdge?.node?.body === 'hello from gql', 'addComment mutation', JSON.stringify(g.json?.data));
  const comments = await req('GET', `/api/v3/repos/${OWNER}/gql-repo/issues/1/comments`);
  ok(Array.isArray(comments.json) && comments.json.some((c: any) => c.body === 'hello from gql'), 'comment visible over REST');

  // 10. invalid field -> 200 + errors naming the field
  g = await gql(DOCS.invalidField);
  ok(g.status === 200 && Array.isArray(g.json?.errors) && g.json.errors.some((e: any) => String(e.message).includes('noSuchFieldOnViewer')), 'invalid field errors', JSON.stringify(g.json)?.slice(0, 200));

  // 11. node(id:) round-trip
  g = await gql(DOCS.nodeRepository, { id: repoId });
  ok(!g.json?.errors && g.json?.data?.node?.name === 'gql-repo' && g.json?.data?.node?.nameWithOwner === `${OWNER}/gql-repo`, 'node repository', JSON.stringify(g.json?.data));

  // 12. issues pagination: 8 issues total (1..8), no state filter -> pages 5 + 3.
  g = await gql(DOCS.issuesPage, { owner: OWNER, name: 'gql-repo', first: 5 });
  const page1 = g.json?.data?.repository?.issues;
  ok(!g.json?.errors && page1?.nodes?.length === 5 && page1?.pageInfo?.hasNextPage === true && typeof page1?.pageInfo?.endCursor === 'string' && page1.pageInfo.endCursor.length > 0, 'issues page 1', JSON.stringify(page1));
  g = await gql(DOCS.issuesPage, { owner: OWNER, name: 'gql-repo', first: 5, after: page1.pageInfo.endCursor });
  const page2 = g.json?.data?.repository?.issues;
  ok(!g.json?.errors && page2?.nodes?.length === 3 && page2?.pageInfo?.hasNextPage === false, 'issues page 2', JSON.stringify(page2));
  const allNums = [...page1.nodes, ...page2.nodes].map((n: any) => n.number);
  ok(new Set(allNums).size === allNums.length && allNums.length === 8, 'pagination distinct numbers', allNums.join(','));

  // 13. batched operations
  const batch = await req('POST', '/api/graphql', [{ query: DOCS.viewerLogin, variables: {} }, { query: DOCS.issueFields, variables: {} }]);
  ok(batch.status === 200 && Array.isArray(batch.json) && batch.json.length === 2 && batch.json[0]?.data?.viewer?.login === OWNER && Array.isArray(batch.json[1]?.data?.Issue?.fields), 'batched operations', JSON.stringify(batch.json)?.slice(0, 200));

  // 14. unknown repo -> null, no errors
  g = await gql(DOCS.repositoryFields, { owner: OWNER, name: 'gql-repo-missing' });
  ok(g.status === 200 && !g.json?.errors && g.json?.data?.repository === null, 'unknown repo null', JSON.stringify(g.json)?.slice(0, 200));

  // 15. unauthenticated -> 401
  const unauth = await fetch(`${BASE}/api/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: DOCS.viewerLogin, variables: {} }) });
  ok(unauth.status === 401, 'graphql unauthenticated 401', `got ${unauth.status}`);

  // ---- MCP ----
  async function rpc(method: string, params: Record<string, unknown> = {}, id: unknown = 1, auth = true): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${TOKEN}`;
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: r.status, json };
  }
  // discover
  let m = await rpc('server/discover', {}, 'discover-1');
  ok(m.status === 200 && m.json?.id === 'discover-1' && Array.isArray(m.json?.result?.supportedVersions) && m.json.result.supportedVersions.includes('2026-07-28') && typeof m.json?.result?.serverInfo?.name === 'string' && m.json.result.serverInfo.name.length > 0 && typeof m.json?.result?.capabilities?.tools === 'object', 'mcp server/discover', JSON.stringify(m.json?.result)?.slice(0, 200));
  // legacy initialize
  m = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 'initialize-1');
  ok(m.status === 200 && m.json?.id === 'initialize-1' && typeof m.json?.result?.protocolVersion === 'string' && typeof m.json?.result?.serverInfo?.name === 'string' && typeof m.json?.result?.capabilities?.tools === 'object', 'mcp initialize legacy', JSON.stringify(m.json?.result)?.slice(0, 200));
  // tools/list (twice, byte-identical)
  const l1 = await rpc('tools/list', {}, 2);
  const l2 = await rpc('tools/list', {}, 3);
  const tools = l1.json?.result?.tools ?? [];
  const names = tools.map((t: any) => t.name);
  ok(['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => names.includes(n)) && tools.every((t: any) => typeof t.description === 'string' && t.description.length > 0 && t.inputSchema?.type === 'object'), 'mcp tools/list has 6 tools', names.join(','));
  ok(JSON.stringify(l1.json?.result?.tools) === JSON.stringify(l2.json?.result?.tools), 'mcp tools/list byte-identical');
  // tools/call: create repo + issue + list + get
  m = await rpc('tools/call', { name: 'create_repo', arguments: { owner: OWNER, name: 'mcp-repo', description: 'via mcp', private: true } }, 10);
  ok(m.status === 200 && m.json?.result?.isError === false && m.json?.result?.structuredContent?.full_name === `${OWNER}/mcp-repo`, 'mcp create_repo', JSON.stringify(m.json?.result)?.slice(0, 200));
  m = await rpc('tools/call', { name: 'get_repo', arguments: { owner: OWNER, repo: 'mcp-repo' } }, 11);
  ok(m.json?.result?.structuredContent?.name === 'mcp-repo', 'mcp get_repo', JSON.stringify(m.json?.result)?.slice(0, 150));
  m = await rpc('tools/call', { name: 'create_issue', arguments: { owner: OWNER, repo: 'mcp-repo', title: 'mcp issue', body: 'body' } }, 12);
  ok(m.json?.result?.structuredContent?.number === 1 && m.json?.result?.structuredContent?.title === 'mcp issue', 'mcp create_issue', JSON.stringify(m.json?.result)?.slice(0, 150));
  m = await rpc('tools/call', { name: 'list_issues', arguments: { owner: OWNER, repo: 'mcp-repo', state: 'open' } }, 13);
  const listText = m.json?.result?.content?.[0]?.text ?? '';
  ok(listText.includes('mcp issue') || listText.includes('"number": 1'), 'mcp list_issues contains the issue', listText.slice(0, 150));
  // rest-parity: the mcp-created repo reads back over REST
  const restRepo = await req('GET', `/api/v3/repos/${OWNER}/mcp-repo`);
  ok(restRepo.json?.name === 'mcp-repo', 'mcp repo visible over REST');
  const restIssues = await req('GET', `/api/v3/repos/${OWNER}/mcp-repo/issues?state=open`);
  ok(Array.isArray(restIssues.json) && restIssues.json.some((i: any) => i.title === 'mcp issue'), 'mcp issue visible over REST');
  // unknown tool -> -32602 or -32601, never 500
  m = await rpc('tools/call', { name: 'no_such_tool', arguments: {} }, 14);
  ok(m.status === 200 && (m.json?.error?.code === -32602 || m.json?.error?.code === -32601), 'mcp unknown tool error code', JSON.stringify(m.json));
  // missing required args -> -32602 or isError
  m = await rpc('tools/call', { name: 'create_issue', arguments: {} }, 15);
  ok(m.status === 200 && (m.json?.error?.code === -32602 || m.json?.result?.isError === true), 'mcp missing args', JSON.stringify(m.json));
  // non-JSON body -> 400 with -32700
  const badBody = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list", "params": ' });
  const badJson: any = await badBody.json().catch(() => null);
  ok(badBody.status === 400 && badJson?.error?.code === -32700, 'mcp non-JSON 400 parse error', `${badBody.status} ${JSON.stringify(badJson)}`);
  // no auth -> 401
  m = await rpc('tools/call', { name: 'get_repo', arguments: { owner: OWNER, repo: 'mcp-repo' } }, 16, false);
  ok(m.status === 401, 'mcp no auth 401', `got ${m.status}`);
  // concurrent calls echo their own ids
  const [c1, c2] = await Promise.all([
    rpc('tools/call', { name: 'get_repo', arguments: { owner: OWNER, repo: 'gql-repo' } }, 'concurrent-a'),
    rpc('tools/call', { name: 'get_repo', arguments: { owner: OWNER, repo: 'mcp-repo' } }, 'concurrent-b'),
  ]);
  ok(c1.json?.id === 'concurrent-a' && c1.json?.result?.structuredContent?.name === 'gql-repo' && c2.json?.id === 'concurrent-b' && c2.json?.result?.structuredContent?.name === 'mcp-repo', 'mcp concurrent ids', `${c1.json?.id} ${c2.json?.id}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
