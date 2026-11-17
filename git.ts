// Git smart HTTP: pkt-line framing, packfiles, upload-pack (protocol v2 and
// v0) and receive-pack (v0 only). Plain-object packs only — the suite never
// sends deltas and never requires them back. All state lives in the shared
// store's per-repo object map and ref map; nothing here touches the disk.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Store, type Repo } from './store.ts';
import { type GitObject, type ObjType, gitSha, storeObject, parseCommit, parseTree, isAncestor } from './gitobj.ts';
import { readBody, authed } from './rest.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'github-core-clone-forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

// ---------- pkt-line ----------
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer; }

/** Decode a whole buffer into packets. Throws on a bad header or truncation. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error(`truncated pkt-line: ${buf.length - off} trailing byte(s)`);
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4) throw new Error(`invalid pkt-line length ${head}`);
    if (off + len > buf.length) throw new Error(`truncated pkt-line: ${len} announced, ${buf.length - off} available`);
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Sideband-wrap a byte stream into band-1 pkt-lines (chunked to fit 65520). */
function sideband(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 65515; // 1 band byte + data <= 65516 payload, + 4 header <= 65520
  for (let off = 0; off < data.length; off += MAX) {
    const piece = data.subarray(off, Math.min(off + MAX, data.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  return Buffer.concat(chunks);
}

// ---------- packfile ----------
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a plain-object pack (version 2) from objects, sorted by oid for determinism. */
export function writePack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const sorted = objects.slice().sort((a, b) => (gitSha(a.type, a.data) < gitSha(b.type, b.data) ? -1 : 1));
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  for (const obj of sorted) {
    parts.push(packEntryHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `off`; returns the data and bytes consumed. */
function inflateAt(buf: Buffer, off: number): { data: Buffer; consumed: number } {
  const sub = buf.subarray(off);
  const result = inflateSync(sub, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const consumed = result.engine?.bytesWritten ?? 0;
  if (consumed > 0 && consumed <= sub.length) return { data: result.buffer, consumed };
  // Fallback: binary-search the minimal length that inflates cleanly.
  let lo = 1;
  let hi = sub.length;
  let found = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try { inflateSync(sub.subarray(0, mid)); found = mid; hi = mid - 1; }
    catch { lo = mid + 1; }
  }
  if (found === -1) throw new Error('pack entry is not a valid zlib stream');
  return { data: inflateSync(sub.subarray(0, found)), consumed: found };
}

export interface PackEntry { type: ObjType; data: Buffer; oid: string; }

/** Parse a pack (plain objects and deltas). `resolveBase` looks up bases the pack omits. */
export function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | null): { version: number; entries: PackEntry[]; checksumOk: boolean } {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expected = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  const checksumOk = trailer.equals(expected);
  const raw: { typeCode: number; size: number; data: Buffer; offset: number; baseOid?: string; baseOffset?: number }[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    let b = buf[off];
    off += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) { b = buf[off]; off += 1; size |= (b & 0x7f) << shift; shift += 7; }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      let byte = buf[off]; off += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) { byte = buf[off]; off += 1; value = ((value + 1) << 7) | (byte & 0x7f); }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { data, consumed } = inflateAt(buf, off);
    off += consumed;
    if (data.length !== size) throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${data.length}`);
    raw.push({ typeCode, size, data, offset: entryOffset, baseOid, baseOffset });
  }
  if (off !== buf.length - 20) throw new Error(`pack has ${buf.length - 20 - off} stray bytes before its trailer`);

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  const resolve = (idx: number, seen: Set<number>): PackEntry => {
    const r = raw[idx];
    if (byOffset.has(r.offset)) return byOffset.get(r.offset) as PackEntry;
    if (seen.has(idx)) throw new Error(`delta cycle at pack offset ${r.offset}`);
    seen.add(idx);
    let entry: PackEntry;
    if (r.typeCode >= 1 && r.typeCode <= 4) {
      const type = CODE_TYPE[r.typeCode];
      entry = { type, data: r.data, oid: gitSha(type, r.data) };
    } else if (r.typeCode === 6 || r.typeCode === 7) {
      let base: PackEntry | GitObject | null = null;
      if (r.typeCode === 6) {
        const baseIdx = raw.findIndex((x) => x.offset === r.baseOffset);
        if (baseIdx === -1) throw new Error(`ofs-delta base at offset ${r.baseOffset} is not in the pack`);
        base = resolve(baseIdx, seen);
      } else {
        base = byOid.get(r.baseOid as string) ?? null;
        if (!base && resolveBase) base = resolveBase(r.baseOid as string);
        if (!base) throw new Error(`ref-delta base ${r.baseOid} is neither in the pack nor supplied`);
      }
      const data = applyDelta(base.data, r.data);
      entry = { type: base.type, data, oid: gitSha(base.type, data) };
    } else {
      throw new Error(`pack entry ${idx} has unknown type code ${r.typeCode}`);
    }
    byOffset.set(r.offset, entry);
    byOid.set(entry.oid, entry);
    entries.push(entry);
    return entry;
  };
  for (let i = 0; i < raw.length; i += 1) resolve(i, new Set());
  return { version, entries, checksumOk };
}

/** Apply a git delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (off < delta.length) {
      const b = delta[off];
      off += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[off] << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[off] << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy runs past the base');
      out.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      outLen += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (outLen !== tgtSize) throw new Error('delta output size mismatch');
  return Buffer.concat(out);
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7).trim();
  }
  return { object, type, tag, tagger };
}

/** Follow a tag to its commit (or return the oid itself when it is a commit). */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}

// ---------- fetch collection ----------
export interface FetchPlan { objects: { type: ObjType; data: Buffer }[]; shallow: string[]; unshallow: string[]; }

/**
 * Objects to send for a fetch: the reachable closure of `wants`, minus the
 * closure of `haves`, cut at `depth` generations and at the client's shallow
 * boundaries. A commit whose parents are cut is reported as a new shallow
 * boundary; an old boundary walked past is reported as unshallow.
 */
export function collectFetch(
  objects: Map<string, GitObject>, wants: string[], haves: string[],
  shallowIn: string[], depth: number | null,
): FetchPlan {
  const shallowInSet = new Set(shallowIn);
  // What the client holds: the closure of the haves, but a shallow boundary
  // cuts it — the client holds the boundary commit but not its parents.
  const haveSet = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (haveSet.has(oid)) continue;
      const obj = objects.get(oid);
      if (!obj) continue;
      haveSet.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(objects, oid);
        if (info) {
          stack.push(info.tree);
          if (!shallowInSet.has(oid)) for (const p of info.parents) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  const send = new Map<string, GitObject>();
  const shallowOut = new Set<string>();
  const visited = new Set<string>();

  const addObject = (oid: string): void => {
    if (haveSet.has(oid)) return;
    const obj = objects.get(oid);
    if (obj && !send.has(oid)) send.set(oid, obj);
  };
  const addTreeClosure = (treeSha: string): void => {
    const stack = [treeSha];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const t = stack.pop() as string;
      if (seen.has(t) || haveSet.has(t)) continue;
      seen.add(t);
      const obj = objects.get(t);
      if (!obj || obj.type !== 'tree') continue;
      addObject(t);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') stack.push(e.sha);
        else addObject(e.sha);
      }
    }
  };

  const queue: { oid: string; depth: number }[] = wants.map((w) => ({ oid: w, depth: 0 }));
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift() as { oid: string; depth: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      addObject(oid);
      queue.push({ oid: parseTag(obj.data).object, depth: d });
      continue;
    }
    if (obj.type !== 'commit') { addObject(oid); continue; }
    addObject(oid);
    const info = parseCommit(objects, oid);
    if (info) addTreeClosure(info.tree);
    // A commit is a new shallow boundary when the depth limit is reached,
    // or when it is an old shallow boundary and deepen does not extend past
    // it (no deepen, or the boundary sits at/beyond the depth limit). When
    // deepen extends past an old boundary, the walk continues through it and
    // the boundary moves deeper (reported as unshallow below).
    const depthCuts = depth !== null && d + 1 >= depth;
    const isBoundary = depthCuts || (shallowInSet.has(oid) && depth === null);
    if (isBoundary) { shallowOut.add(oid); continue; }
    if (info) for (const p of info.parents) queue.push({ oid: p, depth: d + 1 });
  }
  const unshallow = [...shallowInSet].filter((b) => visited.has(b) && !shallowOut.has(b));
  return {
    objects: [...send.values()].map((o) => ({ type: o.type, data: o.data })),
    shallow: [...shallowOut],
    unshallow,
  };
}

// ---------- advertisements ----------
interface RefLine { name: string; oid: string; peeled?: string; }

/** All refs of a repo, sorted, with peeled tag targets. HEAD is handled by the caller. */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled) line.peeled = peeled;
    }
    out.push(line);
  }
  return out;
}

const UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** v0 advertisement body (upload-pack or receive-pack). */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = refLines(repo);
  const main = repo.refs.get('refs/heads/main') ?? null;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = main ?? refs[0].oid;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 advertisement body (upload-pack only). */
function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
}

// ---------- v2 ls-refs ----------
function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = refLines(repo);
  const main = repo.refs.get('refs/heads/main') ?? null;
  const out: string[] = [];
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (symrefs && include('HEAD')) {
    if (main) out.push(`${main} HEAD symref-target:refs/heads/main`);
    else if (unborn) out.push('unborn HEAD symref-target:refs/heads/main');
  }
  for (const r of refs) {
    if (!include(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel && r.peeled) line += ` peeled:${r.peeled}`;
    out.push(line);
  }
  const parts = out.map((l) => pktLine(`${l}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------- fetch ----------
interface FetchRequest {
  wants: string[]; haves: string[]; shallow: string[]; depth: number | null;
  thinPack: boolean;
}

/** Parse the pkt-line text of a v2 fetch / ls-refs body into plain lines. */
function textLines(pkts: Pkt[]): string[] {
  const lines: string[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

function parseFetchRequest(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, thinPack: false };
  for (const line of lines) {
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) { const n = parseInt(line.slice(7), 10); if (Number.isFinite(n)) req.depth = n; }
    else if (line === 'thin-pack') req.thinPack = true;
  }
  return req;
}

/** v2 fetch response: acknowledgments, optional shallow-info, optional packfile. */
function v2FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const plan = collectFetch(repo.objects, req.wants, req.haves, req.shallow, req.depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const acked = req.wants.filter((w) => req.haves.includes(w));
  if (acked.length > 0) for (const w of acked) parts.push(pktLine(`ACK ${w}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(DELIM);
  }
  if (plan.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(sideband(writePack(plan.objects)));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch response: NAK/ACK + shallow lines, then sideband pack data. */
function v0FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const plan = collectFetch(repo.objects, req.wants, req.haves, req.shallow, req.depth);
  const parts: Buffer[] = [];
  const acked = req.wants.filter((w) => req.haves.includes(w));
  if (acked.length > 0) for (const w of acked) parts.push(pktLine(`ACK ${w}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (plan.objects.length > 0) parts.push(sideband(writePack(plan.objects)));
  return Buffer.concat(parts);
}

// ---------- receive-pack ----------
interface PushCommand { oldOid: string; newOid: string; ref: string; }

/** Apply one push command to the store. Returns 'ok' or a refusal reason. */
function applyPush(repo: Repo, cmd: PushCommand): string | null {
  const current = repo.refs.get(cmd.ref) ?? null;
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === null) return 'reference does not exist';
    if (cmd.oldOid !== current) return 'non-fast-forward';
    repo.refs.delete(cmd.ref);
    return null;
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== null) return 'non-fast-forward';
    if (!repo.objects.has(cmd.newOid)) return 'object not found';
    repo.refs.set(cmd.ref, cmd.newOid);
    return null;
  }
  // Update.
  if (current === null) return 'non-fast-forward';
  if (cmd.oldOid !== current) return 'non-fast-forward';
  if (!repo.objects.has(cmd.newOid)) return 'object not found';
  if (!isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) return 'non-fast-forward';
  repo.refs.set(cmd.ref, cmd.newOid);
  return null;
}

function pushReport(results: { ref: string; reason: string | null }[]): Buffer {
  const inner: Buffer[] = [pktLine('unpack ok\n')];
  for (const r of results) {
    inner.push(r.reason === null ? pktLine(`ok ${r.ref}\n`) : pktLine(`ng ${r.ref} ${r.reason}\n`));
  }
  return Buffer.concat([sideband(Buffer.concat(inner)), FLUSH]);
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, headers: Record<string, string>): Promise<void> {
  const body = await readBody(req);
  let commands: PushCommand[] = [];
  let packOffset = 0;
  try {
    // Parse pkt-lines one at a time until the flush; the bytes after the
    // flush are the raw pack, not pkt-lines, so the whole-body parser cannot
    // be used here.
    let off = 0;
    let sawFlush = false;
    while (off < body.length) {
      if (off + 4 > body.length) throw new Error(`truncated pkt-line: ${body.length - off} trailing byte(s)`);
      const head = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-f]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
      const len = parseInt(head, 16);
      if (len === 0) { off += 4; sawFlush = true; break; }
      if (len === 1 || len === 2) { off += 4; continue; }
      if (len < 4) throw new Error(`invalid pkt-line length ${head}`);
      if (off + len > body.length) throw new Error(`truncated pkt-line: ${len} announced, ${body.length - off} available`);
      const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const cmd = nul === -1 ? line : line.slice(0, nul);
      const parts = cmd.split(' ');
      if (parts.length !== 3) throw new Error(`bad receive-pack command: ${JSON.stringify(cmd.slice(0, 60))}`);
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      off += len;
    }
    if (!sawFlush) throw new Error('receive-pack body has no flush after the command list');
    packOffset = off;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'bad request';
    res.writeHead(400, { ...headers, 'content-type': RECEIVE_RESULT });
    res.end(Buffer.concat([sideband(pktLine(`unpack error: ${msg}\n`)), FLUSH]));
    return;
  }
  if (commands.length === 0) {
    res.writeHead(400, { ...headers, 'content-type': RECEIVE_RESULT });
    res.end(Buffer.concat([sideband(pktLine('unpack error: no commands\n')), FLUSH]));
    return;
  }
  const packBytes = body.subarray(packOffset);
  const hasCreateOrUpdate = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasCreateOrUpdate && packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, (oid) => repo.objects.get(oid) ?? null);
      if (!pack.checksumOk) throw new Error('pack trailer checksum mismatch');
      for (const e of pack.entries) storeObject(repo.objects, e.type, e.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unpack failed';
      res.writeHead(200, { ...headers, 'content-type': RECEIVE_RESULT });
      res.end(Buffer.concat([sideband(pktLine(`unpack error: ${msg}\n`)), FLUSH]));
      return;
    }
  }
  const results = commands.map((cmd) => ({ ref: cmd.ref, reason: applyPush(repo, cmd) }));
  res.writeHead(200, { ...headers, 'content-type': RECEIVE_RESULT });
  res.end(pushReport(results));
}

// ---------- upload-pack ----------
async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, headers: Record<string, string>, isV2: boolean): Promise<void> {
  const body = await readBody(req);
  let pkts: Pkt[];
  try {
    pkts = parsePktLines(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'bad request';
    res.writeHead(400, { ...headers, 'content-type': UPLOAD_RESULT });
    res.end(msg);
    return;
  }
  const lines = textLines(pkts);
  if (isV2) {
    const command = lines.find((l) => l.startsWith('command=')) ?? '';
    if (command === 'command=ls-refs') {
      const out = handleLsRefs(repo, lines);
      res.writeHead(200, { ...headers, 'content-type': UPLOAD_RESULT });
      res.end(out);
      return;
    }
    if (command === 'command=fetch') {
      const fetchReq = parseFetchRequest(lines);
      const out = v2FetchResponse(repo, fetchReq);
      res.writeHead(200, { ...headers, 'content-type': UPLOAD_RESULT });
      res.end(out);
      return;
    }
    res.writeHead(400, { ...headers, 'content-type': UPLOAD_RESULT });
    res.end('unknown command');
    return;
  }
  // v0 fetch: two sections (wants, then haves) separated by flushes.
  const fetchReq = parseFetchRequest(lines);
  const out = v0FetchResponse(repo, fetchReq);
  res.writeHead(200, { ...headers, 'content-type': UPLOAD_RESULT });
  res.end(out);
}

// ---------- router ----------
/**
 * Handle /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}.
 * Returns true when the path is a git path (handled or 404'd); false when
 * the path is not a git path at all.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store, pathname: string, query: URLSearchParams): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!m) return false;
  const [, owner, repoName, op] = m;
  const reqId = store.nextRequestId();
  const headers: Record<string, string> = { 'x-github-request-id': reqId };

  // Auth on every git request (the suite always sends its token).
  if (!authed(req, store)) {
    res.writeHead(401, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return true;
  }

  if (op === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) {
        res.writeHead(200, { ...headers, 'content-type': UPLOAD_AD });
        res.end(v2Advertisement());
      } else {
        res.writeHead(200, { ...headers, 'content-type': UPLOAD_AD });
        res.end(v0Advertisement('git-upload-pack', repo));
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      // Receive-pack is v0-only, whatever the client asked for.
      res.writeHead(200, { ...headers, 'content-type': RECEIVE_AD });
      res.end(v0Advertisement('git-receive-pack', repo));
      return true;
    }
    res.writeHead(400, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Missing service parameter' }));
    return true;
  }

  if (op === 'git-upload-pack') {
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    await handleUploadPack(req, res, repo, headers, isV2);
    return true;
  }

  // git-receive-pack
  await handleReceivePack(req, res, repo, headers);
  return true;
}
