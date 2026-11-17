// Git smoke test: drives the forge like the suite's git-client.ts does.
import { makeBlob, buildTree, makeCommit, gitSha, parseCommit, parseTree } from './gitobj.ts';
import { writePack, readPack, parsePktLines, pktLine, ZERO_OID } from './git.ts';
import type { GitObject } from './gitobj.ts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18099';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token-123';
const OWNER = 'adaiversen';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = ''): void {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name} ${extra}`); }
}

async function req(method: string, path: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; buf: Buffer; text: string }> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { ...H, ...headers }, body: body ?? undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, buf, text: buf.toString('utf8') };
}

// Local object store (the "client" side), like the suite's.
const objs = new Map<string, GitObject>();
const storeObj = (type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string => {
  const sha = gitSha(type, data);
  if (!objs.has(sha)) objs.set(sha, { type, data });
  return sha;
};
const mkBlob = (s: string): string => storeObj('blob', Buffer.from(s, 'utf8'));
const mkCommit = (tree: string, parents: string[], msg: string, epoch: number): string => {
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`),
    `author ${OWNER} <${OWNER}@example.invalid> ${epoch} +0000`,
    `committer ${OWNER} <${OWNER}@example.invalid> ${epoch} +0000`];
  return storeObj('commit', Buffer.from(`${lines.join('\n')}\n\n${msg}\n`, 'utf8'));
};
async function infoRefs(service: string, v2: boolean): Promise<{ status: number; ct: string | null; buf: Buffer }> {
  const headers: Record<string, string> = v2 ? { 'Git-Protocol': 'version=2' } : {};
  const r = await req('GET', `/${OWNER}/gitconf-main.git/info/refs?service=${service}`, undefined, headers);
  return { status: r.status, ct: r.headers.get('content-type'), buf: r.buf };
}

function parseAd(buf: Buffer): { isV2: boolean; caps: string[]; refs: { oid: string; name: string }[] } {
  const pkts = parsePktLines(buf);
  const lines = pkts.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const first = lines[0] ?? '';
  const isV2 = first.trim() === 'version 2';
  const caps: string[] = [];
  const refs: { oid: string; name: string }[] = [];
  if (isV2) {
    for (const l of lines.slice(1)) caps.push(l.trim().split('=')[0]);
  } else {
    for (const l of lines.slice(1)) {
      const nul = l.indexOf('\0');
      const head = nul === -1 ? l : l.slice(0, nul);
      if (nul !== -1) caps.push(...l.slice(nul + 1).trim().split(' '));
      const m = /^([0-9a-f]{40}) (\S+)/.exec(head.trim());
      if (m) refs.push({ oid: m[1], name: m[2] });
    }
  }
  return { isV2, caps, refs };
}

async function lsRefs(prefixes: string[] = []): Promise<{ oid: string; name: string; attrs: Record<string, string> }[]> {
  const lines = ['command=ls-refs\n', 'agent=makefun-git-client/1.0\n', 'object-format=sha1\n', '0001', 'peel\n', 'symrefs\n', 'unborn\n'];
  for (const p of prefixes) lines.push(`ref-prefix ${p}\n`);
  lines.push('0000');
  const body = Buffer.concat(lines.map((l) => (l === '0001' ? Buffer.from('0001', 'ascii') : l === '0000' ? Buffer.from('0000', 'ascii') : pktLine(l))));
  const r = await req('POST', `/${OWNER}/gitconf-main.git/git-upload-pack`, body, { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' });
  const pkts = parsePktLines(r.buf);
  const out: { oid: string; name: string; attrs: Record<string, string> }[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').trim();
    const parts = text.split(' ');
    const attrs: Record<string, string> = {};
    for (const t of parts.slice(2)) {
      const [k, v] = t.split(':');
      if (k && v) attrs[k] = v;
    }
    out.push({ oid: parts[0], name: parts[1], attrs });
  }
  return out;
}

interface FetchOut { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[]; }
async function fetchV2(wants: string[], haves: string[] = [], depth: number | null = null, shallow: string[] = []): Promise<FetchOut> {
  const lines: string[] = ['command=fetch\n', 'agent=makefun-git-client/1.0\n', 'object-format=sha1\n', '0001', 'thin-pack\n', 'no-progress\n', 'ofs-delta\n'];
  for (const w of wants) lines.push(`want ${w}\n`);
  for (const h of haves) lines.push(`have ${h}\n`);
  for (const s of shallow) lines.push(`shallow ${s}\n`);
  if (depth !== null) lines.push(`deepen ${depth}\n`);
  lines.push('done\n', '0000');
  const body = Buffer.concat(lines.map((l) => (l === '0001' ? Buffer.from('0001', 'ascii') : l === '0000' ? Buffer.from('0000', 'ascii') : pktLine(l))));
  const r = await req('POST', `/${OWNER}/gitconf-main.git/git-upload-pack`, body, { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' });
  const pkts = parsePktLines(r.buf);
  let section = '';
  const packBytes: Buffer[] = [];
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  for (const p of pkts) {
    if (p.kind === 'flush' || p.kind === 'delim') { section = ''; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (['acknowledgments\n', 'shallow-info\n', 'wanted-refs\n', 'packfile\n', 'packfile-uris\n'].includes(text)) { section = text.trim(); continue; }
    if (section === 'shallow-info') {
      if (text.startsWith('shallow ')) shallowOut.push(text.slice(8).trim());
      else if (text.startsWith('unshallow ')) unshallowOut.push(text.slice(10).trim());
    } else if (section === 'packfile') {
      const band = p.payload[0];
      if (band === 1) packBytes.push(p.payload.subarray(1));
      else if (band === 3) throw new Error(`sideband error: ${p.payload.subarray(1).toString('utf8')}`);
    }
  }
  const objects = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    const pack = readPack(Buffer.concat(packBytes));
    ok(pack.checksumOk, 'fetch pack checksum');
    for (const e of pack.entries) objects.set(e.oid, { type: e.type, data: e.data });
  }
  return { objects, shallow: shallowOut, unshallow: unshallowOut };
}

async function push(commands: { oldOid: string; newOid: string; ref: string }[], packObjects: { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[]): Promise<{ unpackOk: boolean; refs: { ref: string; ok: boolean; reason: string }[]; sideband: boolean }> {
  const caps = 'report-status side-band-64k ofs-delta agent=makefun-git-client/1.0';
  const lines: Buffer[] = [];
  commands.forEach((c, i) => {
    const cmd = `${c.oldOid} ${c.newOid} ${c.ref}`;
    lines.push(pktLine(i === 0 ? `${cmd}\0${caps}\n` : `${cmd}\n`));
  });
  lines.push(Buffer.from('0000', 'ascii'));
  const pack = writePack(packObjects);
  const body = Buffer.concat([...lines, pack]);
  const r = await req('POST', `/${OWNER}/gitconf-main.git/git-receive-pack`, body, { 'Content-Type': 'application/x-git-receive-pack-request' });
  const pkts = parsePktLines(r.buf);
  let band1 = Buffer.alloc(0);
  let sideband = false;
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    const band = p.payload[0];
    if (band === 1) { sideband = true; band1 = Buffer.concat([band1, p.payload.subarray(1)]); }
    else if (band === 3) throw new Error(`push sideband error: ${p.payload.subarray(1).toString('utf8')}`);
  }
  const inner = parsePktLines(band1);
  const text = inner.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').trim());
  const unpackOk = text[0] === 'unpack ok';
  const refs: { ref: string; ok: boolean; reason: string }[] = [];
  for (const line of text.slice(1)) {
    if (line.startsWith('ok ')) refs.push({ ref: line.slice(3), ok: true, reason: '' });
    else if (line.startsWith('ng ')) {
      const rest = line.slice(3);
      const sp = rest.indexOf(' ');
      refs.push({ ref: rest.slice(0, sp), ok: false, reason: rest.slice(sp + 1) });
    }
  }
  return { unpackOk, refs, sideband };
}

function objectsReachable(roots: string[]): { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] {
  const seen = new Set<string>();
  const out: { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objs.get(oid);
    if (!obj) continue;
    seen.add(oid);
    out.push({ type: obj.type, data: obj.data });
    if (obj.type === 'commit') {
      const info = parseCommit(objs, oid);
      if (info) { stack.push(info.tree); for (const p of info.parents) stack.push(p); }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.sha);
    } else if (obj.type === 'tag') {
      const tag = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(tag);
      if (m) stack.push(m[1]);
    }
  }
  return out;
}
// ---- run ----
async function main(): Promise<void> {
  // 1. create repo via REST
  let r = await req('POST', '/api/v3/user/repos', JSON.stringify({ name: 'gitconf-main', description: 'git conformance', private: true, auto_init: false }));
  ok(r.status === 201, 'create repo 201', `got ${r.status}`);

  // 2. v2 advertisement
  const adV2 = await infoRefs('git-upload-pack', true);
  const parsedV2 = parseAd(adV2.buf);
  ok(adV2.status === 200 && parsedV2.isV2, 'v2 advertisement protocol 2');
  ok(parsedV2.caps.includes('fetch') && parsedV2.caps.includes('ls-refs'), 'v2 caps include fetch + ls-refs', parsedV2.caps.join(','));
  ok(adV2.ct?.includes('application/x-git-upload-pack-advertisement') ?? false, 'v2 content type');

  // 3. receive-pack advertisement
  const adR = await infoRefs('git-receive-pack', false);
  const parsedR = parseAd(adR.buf);
  ok(adR.status === 200 && !parsedR.isV2, 'receive-pack advertisement v0');
  ok(parsedR.caps.includes('report-status') && parsedR.caps.includes('side-band-64k') && parsedR.caps.includes('delete-refs'), 'receive caps', parsedR.caps.join(','));

  // 4. unknown repo 404
  const miss = await req('GET', `/${OWNER}/gitconf-main-missing.git/info/refs?service=git-upload-pack`);
  ok(miss.status === 404, 'unknown repo 404', `got ${miss.status}`);
  const again = await infoRefs('git-upload-pack', true);
  ok(again.status === 200, 'server stays up after 404');

  // 5. build the first commit and push it
  const blob1 = mkBlob('hello forge\n');
  const blob2 = mkBlob('second file\n');
  const files1 = new Map([['README.md', blob1], ['src/app.ts', blob2]]);
  const tree1 = buildTree(objs, files1);
  const tip = mkCommit(tree1, [], 'first commit', 1700000000);
  const p1 = await push([{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }], objectsReachable([tip]));
  ok(p1.unpackOk && p1.refs.length === 1 && p1.refs[0].ok, 'push first commit ok', JSON.stringify(p1.refs));
  ok(p1.sideband, 'push report is sideband framed');

  // 6. ls-refs
  const refs = await lsRefs();
  const mainRef = refs.find((x) => x.name === 'refs/heads/main');
  const headRef = refs.find((x) => x.name === 'HEAD');
  ok(mainRef?.oid === tip, 'ls-refs main at tip', `${mainRef?.oid} vs ${tip}`);
  ok(headRef?.attrs['symref-target'] === 'refs/heads/main', 'ls-refs HEAD symref', JSON.stringify(headRef?.attrs));

  // 7. full clone (fetch)
  const clone = await fetchV2([tip]);
  let allMatch = true;
  for (const [oid, obj] of objs) {
    const got = clone.objects.get(oid);
    if (!got || got.type !== obj.type || !got.data.equals(obj.data)) { allMatch = false; console.log(`  mismatch ${oid}`); }
  }
  ok(allMatch && clone.objects.size === objs.size, `full clone ${clone.objects.size} objects byte-identical`, `got ${clone.objects.size} want ${objs.size}`);

  // 8. second commit + tag
  const blob3 = mkBlob('hello forge v2\n');
  const files2 = new Map([['README.md', blob3], ['src/app.ts', blob2]]);
  const tree2 = buildTree(objs, files2);
  const second = mkCommit(tree2, [tip], 'second commit', 1700000060);
  const tagData = Buffer.from(`object ${second}\ntype commit\ntag v1\ntagger ${OWNER} <${OWNER}@example.invalid> 1700000060 +0000\n\nrelease v1\n`, 'utf8');
  const tagOid = storeObj('tag', tagData);
  const p2 = await push([
    { oldOid: tip, newOid: second, ref: 'refs/heads/main' },
    { oldOid: ZERO_OID, newOid: tagOid, ref: 'refs/tags/v1' },
  ], objectsReachable([second, tagOid]));
  ok(p2.unpackOk && p2.refs.every((x) => x.ok), 'push second + tag ok', JSON.stringify(p2.refs));
  const refs2 = await lsRefs();
  const tagRef = refs2.find((x) => x.name === 'refs/tags/v1');
  ok(tagRef?.oid === tagOid && tagRef?.attrs['peeled'] === second, 'ls-refs tag peels', JSON.stringify(tagRef));
  const heads = await lsRefs(['refs/heads/']);
  ok(heads.every((x) => x.name.startsWith('refs/heads/')) && heads.some((x) => x.name === 'refs/heads/main'), 'ls-refs prefix heads');
  const tags = await lsRefs(['refs/tags/']);
  ok(tags.every((x) => x.name.startsWith('refs/tags/')) && tags.some((x) => x.name === 'refs/tags/v1'), 'ls-refs prefix tags');
  const none = await lsRefs(['refs/does-not-exist/']);
  ok(none.length === 0, 'ls-refs prefix unmatched empty', `got ${none.length}`);

  // 9. incremental fetch
  const inc = await fetchV2([second], [tip]);
  ok(inc.objects.has(second) && !inc.objects.has(tip), 'incremental: new tip only, old tip not re-sent', `got ${inc.objects.size}`);
  // fetch nothing new
  const none2 = await fetchV2([second], [second]);
  ok(none2.objects.size === 0, 'fetch nothing new = 0 objects', `got ${none2.objects.size}`);

  // 10. shallow depth-1 clone
  const shallow = await fetchV2([second], [], 1);
  ok(shallow.objects.has(second) && !shallow.objects.has(tip), 'shallow depth-1: tip only', `got ${shallow.objects.size}`);
  ok(shallow.shallow.includes(second), 'shallow-info names the tip', shallow.shallow.join(','));

  // 10b. shallow deepen: from a depth-1 clone at second, deepen 2 -> parent (tip) only
  const deepened = await fetchV2([second], [second], 2, [second]);
  ok(deepened.objects.has(tip), 'shallow deepen: parent delivered', `got ${deepened.objects.size}`);
  ok(deepened.shallow.includes(tip) || deepened.unshallow.includes(second), 'shallow deepen: boundary moved', `shallow=${deepened.shallow.join(',')} unshallow=${deepened.unshallow.join(',')}`);

  // 11. non-fast-forward push
  const sibling = mkCommit(tree1, [tip], 'sibling commit', 1700000120);
  const p3 = await push([{ oldOid: second, newOid: sibling, ref: 'refs/heads/main' }], objectsReachable([sibling]));
  ok(p3.unpackOk && p3.refs.length === 1 && !p3.refs[0].ok && p3.refs[0].reason === 'non-fast-forward', 'non-FF refused', JSON.stringify(p3.refs));
  const refs3 = await lsRefs();
  ok(refs3.find((x) => x.name === 'refs/heads/main')?.oid === second, 'non-FF ref unmoved');

  // 12. mixed push: FF main + non-FF side
  const sideOid = second;
  await push([{ oldOid: ZERO_OID, newOid: sideOid, ref: 'refs/heads/side' }], []);
  const forward = mkCommit(tree2, [second], 'forward commit', 1700000180);
  const p4 = await push([
    { oldOid: second, newOid: forward, ref: 'refs/heads/main' },
    { oldOid: sideOid, newOid: sibling, ref: 'refs/heads/side' },
  ], objectsReachable([forward, sibling]));
  ok(p4.unpackOk && p4.refs.length === 2, 'mixed push 2 report lines', JSON.stringify(p4.refs));
  const okMain = p4.refs.find((x) => x.ref === 'refs/heads/main');
  const ngSide = p4.refs.find((x) => x.ref === 'refs/heads/side');
  ok(okMain?.ok === true && ngSide?.ok === false && ngSide?.reason === 'non-fast-forward', 'mixed push ok + ng', JSON.stringify(p4.refs));
  const refs4 = await lsRefs();
  ok(refs4.find((x) => x.name === 'refs/heads/main')?.oid === forward, 'mixed push main advanced');
  ok(refs4.find((x) => x.name === 'refs/heads/side')?.oid === sideOid, 'mixed push side unmoved');

  // 13. delete branch
  const p5 = await push([{ oldOid: sideOid, newOid: ZERO_OID, ref: 'refs/heads/side' }], []);
  ok(p5.unpackOk && p5.refs[0]?.ok, 'delete branch ok', JSON.stringify(p5.refs));
  const refs5 = await lsRefs();
  ok(!refs5.some((x) => x.name === 'refs/heads/side'), 'deleted branch gone');

  // 14. malformed POST survives
  const bad = await req('POST', `/${OWNER}/gitconf-main.git/git-upload-pack`, Buffer.from('zzzznot-a-pkt-line', 'ascii'), { 'Content-Type': 'application/x-git-upload-pack-request' });
  const after = await infoRefs('git-upload-pack', true);
  ok(after.status === 200, 'server survives malformed POST', `bad status ${bad.status}, after ${after.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
