// Local smoke test of the REST surface (mirrors the suite's key checks).
const BASE = 'http://127.0.0.1:18099';
const TOKEN = 'test-token-123';
const H = { 'accept': 'application/vnd.github+json', 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } }
async function req(method, path, body = undefined, headers = H) {
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers, text };
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// boot
let r = await req('GET', '/healthz', undefined, {});
check('healthz 200', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
// root + meta
r = await req('GET', '/api/v3/');
check('root 200 + scopes', r.status === 200 && r.headers.get('x-oauth-scopes') !== null, r.status + '');
r = await req('GET', '/api/v3/meta');
check('meta installed_version', r.status === 200 && typeof r.json?.installed_version === 'string' && r.json.installed_version.length > 0);
// anon 401
r = await req('GET', '/api/v3/user/repos', undefined, { 'accept': 'application/vnd.github+json' });
check('anon 401', r.status === 401 && typeof r.json?.message === 'string', r.status + '');
// create repo
r = await req('POST', '/api/v3/user/repos', { name: 'demo-repo', private: true, description: 'demo' });
check('create repo 201', r.status === 201 && r.json?.name === 'demo-repo' && r.json?.private === true, JSON.stringify(r.json));
r = await req('POST', '/api/v3/user/repos', { name: 'demo-repo', private: true, description: 'demo' });
check('dup repo 422', r.status === 422, r.status + '');
r = await req('GET', '/api/v3/repos/adaiversen/demo-repo');
check('get repo 200 + default_branch', r.status === 200 && typeof r.json?.default_branch === 'string', JSON.stringify(r.json));
r = await req('GET', '/api/v3/repos/olgabauer/demo-repo');
check('foreign owner 404', r.status === 404, r.status + '');
// contents on unborn repo
r = await req('PUT', '/api/v3/repos/adaiversen/demo-repo/contents/docs/readme.md', { message: 'seed', content: b64('# demo\n') });
check('contents create 201', r.status === 201 && /^[0-9a-f]{40}$/.test(r.json?.commit?.sha ?? ''), JSON.stringify(r.json));
const blobSha = r.json?.content?.sha;
r = await req('GET', '/api/v3/repos/adaiversen/demo-repo/contents/docs/readme.md');
check('contents get decodes', r.status === 200 && Buffer.from(r.json?.content ?? '', 'base64').toString() === '# demo\n' && r.json?.sha === blobSha, JSON.stringify(r.json));
r = await req('GET', '/api/v3/repos/adaiversen/demo-repo/contents/docs');
check('contents dir lists', r.status === 200 && Array.isArray(r.json) && r.json.some((e) => e.name === 'readme.md'), JSON.stringify(r.json));
r = await req('PUT', '/api/v3/repos/adaiversen/demo-repo/contents/docs/readme.md', { message: 'upd', content: b64('# demo2\n'), sha: blobSha });
check('contents update 200 + sha changes', (r.status === 200 || r.status === 201) && r.json?.content?.sha !== blobSha, JSON.stringify(r.json));
r = await req('PUT', '/api/v3/repos/adaiversen/demo-repo/contents/docs/readme.md', { message: 'stale', content: b64('# x\n'), sha: blobSha });
check('contents stale 409', r.status === 409, r.status + '');
// branches + commits
r = await req('GET', '/api/v3/repos/adaiversen/demo-repo/branches');
check('branches lists main', r.status === 200 && r.json?.some((b) => b.name === 'main'), JSON.stringify(r.json));
r = await req('GET', '/api/v3/repos/adaiversen/demo-repo/commits');
check('commits list', r.status === 200 && Array.isArray(r.json) && r.json.length === 2, JSON.stringify(r.json));
// labels + issues
r = await req('POST', '/api/v3/repos/adaiversen/demo-repo/labels', { name: 'bug', color: 'ededed' });
check('label 201', r.status === 201 && r.json?.name === 'bug', JSON.stringify(r.json));
r = await req('POST', '/api/v3/repos/adaiversen/demo-repo/issues', { title: 'first issue', body: 'body here', labels: ['bug'] });
check('issue 201 open', r.status === 201 && r.json?.state === 'open' && r.json?.number === 1, JSON.stringify(r.json));
r = await req('POST', '/api/v3/repos/adaiversen/demo-repo/issues', { title: 'bad', body: 'b', labels: ['nope-not-a-label'] });
check('issue bad label 422', r.status === 422, r.status + '');
r = await req('POST', '/api/v3/repos/adaiversen/demo-repo/issues', { title: 'second', body: 'b2' });
check('issue number increments', r.status === 201 && r.json?.number === 2, JSON.stringify(r.json));
r = await req('PATCH', '/api/v3/repos/adaiversen/demo-repo/issues/2', { state: 'closed' });
check('issue close 200', r.status === 200 && r.json?.state === 'closed', JSON.stringify(r.json));
r = await req('GET', '/api/v3/repos/adaiversen/demo-repo/issues?state=open&per_page=100');
check('list open excludes closed', r.status === 200 && r.json?.length === 1 && r.json[0].number === 1, JSON.stringify(r.json));
r = await req('POST', '/api/v3/repos/adaiversen/demo-repo/issues/1/comments', { body: 'a comment' });
check('comment 201', r.status === 201 && r.json?.id === 1 && r.json?.body === 'a comment', JSON.stringify(r.json));
// pagination: 30 repos
for (let i = 0; i < 30; i++) { await req('POST', '/api/v3/user/repos', { name: `page-repo-${i}`, private: true, description: 'p' }); }
r = await req('GET', '/api/v3/user/repos?per_page=10');
let pages = 1, seen = new Set(r.json?.map((x) => x.name) ?? []);
let link = r.headers.get('link') ?? '';
while (link.includes('rel="next"')) {
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  const next = m[1];
  const rr = await fetch(next, { headers: H });
  const jj = await rr.json();
  pages++;
  for (const x of jj) seen.add(x.name);
  link = rr.headers.get('link') ?? '';
}
check('pagination 30 repos, >=3 pages, no dupes', pages >= 3 && seen.size >= 30 && (r.json?.length ?? 99) <= 10, `pages=${pages} seen=${seen.size}`);
// PR flow: branch + commit + PR + merge
r = await req('GET', '/api/v3/repos/adaiversen/demo-repo/commits');
const tip = r.json?.[0]?.sha;
r = await req('POST', '/api/v3/repos/adaiversen/demo-repo/git/refs', { ref: 'refs/heads/feature-x', sha: tip });
check('create ref 201', r.status === 201 && r.json?.ref === 'refs/heads/feature-x', JSON.stringify(r.json));
r = await req('PUT', '/api/v3/repos/adaiversen/demo-repo/contents/newfile.txt', { message: 'add file', content: b64('hello\n'), branch: 'feature-x' });
check('commit on branch 201', r.status === 201, JSON.stringify(r.json));
r = await req('POST', '/api/v3/repos/adaiversen/demo-repo/pulls', { title: 'my pr', body: 'pr body', head: 'feature-x', base: 'main' });
check('PR 201 open', r.status === 201 && r.json?.state === 'open' && r.json?.head?.ref === 'feature-x', JSON.stringify(r.json));
const prNum = r.json?.number;
r = await req('GET', `/api/v3/repos/adaiversen/demo-repo/pulls/${prNum}/files`);
check('PR files lists newfile', r.status === 200 && r.json?.some((f) => f.filename === 'newfile.txt' && f.additions >= 1), JSON.stringify(r.json));
r = await req('PUT', `/api/v3/repos/adaiversen/demo-repo/pulls/${prNum}/merge`, { merge_method: 'squash' });
check('merge 200 merged', r.status === 200 && r.json?.merged === true && /^[0-9a-f]{40}$/.test(r.json?.sha ?? ''), JSON.stringify(r.json));
const mergeSha = r.json?.sha;
r = await req('GET', `/api/v3/repos/adaiversen/demo-repo/pulls/${prNum}`);
check('merged PR closed + merge_commit_sha', r.status === 200 && r.json?.state === 'closed' && r.json?.merged === true && r.json?.merge_commit_sha === mergeSha, JSON.stringify(r.json));
r = await req('GET', '/api/v3/repos/adaiversen/demo-repo/contents/newfile.txt?ref=main');
check('squash content on main', r.status === 200 && Buffer.from(r.json?.content ?? '', 'base64').toString() === 'hello\n', JSON.stringify(r.json));
r = await req('PUT', '/api/v3/repos/adaiversen/demo-repo/pulls/999999999/merge', { merge_method: 'squash' });
check('merge unknown 404', r.status === 404, r.status + '');
// conflict fixture
r = await req('POST', '/api/v3/repos/adaiversen/demo-repo/git/refs', { ref: 'refs/heads/conf-a', sha: tip });
const curA = await req('GET', '/api/v3/repos/adaiversen/demo-repo/contents/docs/readme.md?ref=conf-a');
await req('PUT', '/api/v3/repos/adaiversen/demo-repo/contents/docs/readme.md', { message: 'a', content: b64('content A\n'), branch: 'conf-a', sha: curA.json?.sha });
const rA = await req('POST', '/api/v3/repos/adaiversen/demo-repo/pulls', { title: 'pa', body: 'b', head: 'conf-a', base: 'main' });
await req('POST', '/api/v3/repos/adaiversen/demo-repo/git/refs', { ref: 'refs/heads/conf-b', sha: tip });
const cur = await req('GET', '/api/v3/repos/adaiversen/demo-repo/contents/docs/readme.md?ref=conf-b');
await req('PUT', '/api/v3/repos/adaiversen/demo-repo/contents/docs/readme.md', { message: 'b', content: b64('content B\n'), branch: 'conf-b', sha: cur.json?.sha });
const rB = await req('POST', '/api/v3/repos/adaiversen/demo-repo/pulls', { title: 'pb', body: 'b', head: 'conf-b', base: 'main' });
const m1 = await req('PUT', `/api/v3/repos/adaiversen/demo-repo/pulls/${rA.json?.number}/merge`, { merge_method: 'squash' });
const m2 = await req('PUT', `/api/v3/repos/adaiversen/demo-repo/pulls/${rB.json?.number}/merge`, { merge_method: 'squash' });
check('conflict: first merge 200, second 405', m1.status === 200 && m2.status === 405, `m1=${m1.status} m2=${m2.status}`);
// protocol
r = await req('GET', '/api/v3/no-such-route-xyz');
check('unknown route 404 json', r.status === 404 && typeof r.json?.message === 'string' && !r.text.trimStart().startsWith('<'), r.status + '');
const raw = await fetch(BASE + '/api/v3/user/repos', { method: 'POST', headers: { ...H }, body: '{"name":' });
check('malformed body 400', raw.status === 400, raw.status + '');
r = await req('GET', '/api/v3/');
check('request-id header present', typeof r.headers.get('x-github-request-id') === 'string' && r.headers.get('x-github-request-id').length > 0, r.headers.get('x-github-request-id') ?? '');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
