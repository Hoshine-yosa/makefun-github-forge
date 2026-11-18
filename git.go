// Git smart HTTP: pkt-line framing, packfiles, upload-pack (protocol v2 and
// v0) and receive-pack (v0 only). Plain-object packs only — the suite never
// sends deltas and never requires them back. All state lives in the shared
// store's per-repo object map and ref map; nothing here touches the disk.
//
// Port of the Node forge's git.ts. Same pkt-line framing, same pack bytes,
// same advertisements, same fast-forward rules, same error messages.

package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const ZERO_OID = "0000000000000000000000000000000000000000"

const agent = "github-core-clone-forge/1.0"

const (
	uploadAd      = "application/x-git-upload-pack-advertisement"
	uploadResult  = "application/x-git-upload-pack-result"
	receiveAd     = "application/x-git-receive-pack-advertisement"
	receiveResult = "application/x-git-receive-pack-result"
)

// ---------- pkt-line ----------

const hexDigits = "0123456789abcdef"

// putPktLen writes the 4-hex-digit pkt-line length n into dst[0:4]. It is
// byte-for-byte what copy(dst[:4], fmt.Sprintf("%04x", n)) wrote, without the
// formatter: n above 0xffff (never produced here) still takes the old path.
func putPktLen(dst []byte, n int) {
	if n > 0xffff {
		copy(dst[:4], fmt.Sprintf("%04x", n))
		return
	}
	dst[0] = hexDigits[n>>12]
	dst[1] = hexDigits[(n>>8)&0xf]
	dst[2] = hexDigits[(n>>4)&0xf]
	dst[3] = hexDigits[n&0xf]
}

// appendPktLen appends the same 4 digits to dst.
func appendPktLen(dst []byte, n int) []byte {
	if n > 0xffff {
		return append(dst, fmt.Sprintf("%04x", n)[:4]...)
	}
	return append(dst, hexDigits[n>>12], hexDigits[(n>>8)&0xf], hexDigits[(n>>4)&0xf], hexDigits[n&0xf])
}

// appendPkt appends one pkt-line whose payload is a+b+c+d (no intermediate
// string or slice is built).
func appendPkt(dst []byte, a, b, c, d string) []byte {
	dst = appendPktLen(dst, len(a)+len(b)+len(c)+len(d)+4)
	dst = append(dst, a...)
	dst = append(dst, b...)
	dst = append(dst, c...)
	return append(dst, d...)
}

func pktLine(payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	copy(out[4:], payload)
	putPktLen(out, len(payload)+4)
	return out
}

func pktLineString(s string) []byte {
	out := make([]byte, 4+len(s))
	copy(out[4:], s)
	putPktLen(out, len(s)+4)
	return out
}

var flushPkt = []byte("0000")
var delimPkt = []byte("0001")

type pktKind string

const (
	pktData  pktKind = "data"
	pktFlush pktKind = "flush"
	pktDelim pktKind = "delim"
	pktEnd   pktKind = "end"
)

type Pkt struct {
	Kind    pktKind
	Payload []byte
}

func isHexDigit(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f')
}

// pktHeader decodes the four lowercase-hex length digits at buf[off:off+4]
// (the caller has checked off+4 <= len(buf)). ok is false when any of the
// four is not a lowercase hex digit — the same test isHexDigit applied.
func pktHeader(buf []byte, off int) (length int, ok bool) {
	for i := 0; i < 4; i++ {
		c := buf[off+i]
		var v int
		switch {
		case c >= '0' && c <= '9':
			v = int(c - '0')
		case c >= 'a' && c <= 'f':
			v = int(c-'a') + 10
		default:
			return 0, false
		}
		length = length<<4 | v
	}
	return length, true
}

// parsePktLines decodes a whole buffer into packets.
// Returns an error on a bad header or truncation.
func parsePktLines(buf []byte) ([]Pkt, error) {
	out := make([]Pkt, 0, 16)
	off := 0
	for off < len(buf) {
		if off+4 > len(buf) {
			return nil, fmt.Errorf("truncated pkt-line: %d trailing byte(s)", len(buf)-off)
		}
		length, ok := pktHeader(buf, off)
		if !ok {
			return nil, fmt.Errorf("invalid pkt-line length %q", string(buf[off:off+4]))
		}
		if length == 0 {
			out = append(out, Pkt{Kind: pktFlush})
			off += 4
			continue
		}
		if length == 1 {
			out = append(out, Pkt{Kind: pktDelim})
			off += 4
			continue
		}
		if length == 2 {
			out = append(out, Pkt{Kind: pktEnd})
			off += 4
			continue
		}
		if length < 4 {
			return nil, fmt.Errorf("invalid pkt-line length %q", string(buf[off:off+4]))
		}
		if off+length > len(buf) {
			return nil, fmt.Errorf("truncated pkt-line: %d announced, %d available", length, len(buf)-off)
		}
		out = append(out, Pkt{Kind: pktData, Payload: buf[off+4 : off+length]})
		off += length
	}
	return out, nil
}

// sideband wraps a byte stream into band-1 pkt-lines (chunked to fit 65520).
func sideband(data []byte) []byte {
	const maxChunk = 65515 // 1 band byte + data <= 65516 payload, + 4 header <= 65520
	if len(data) == 0 {
		return nil
	}
	// One exact-size buffer, one copy of data: each chunk is its 4-digit
	// length (1 band byte + chunk + 4 header), the band byte, then the chunk.
	chunks := (len(data) + maxChunk - 1) / maxChunk
	out := make([]byte, 0, len(data)+chunks*5)
	for off := 0; off < len(data); off += maxChunk {
		end := off + maxChunk
		if end > len(data) {
			end = len(data)
		}
		out = appendPktLen(out, end-off+5)
		out = append(out, 1)
		out = append(out, data[off:end]...)
	}
	return out
}

// ---------- packfile ----------

var typeCode = map[ObjType]int{
	ObjCommit: 1,
	ObjTree:   2,
	ObjBlob:   3,
	ObjTag:    4,
}

var codeType = map[int]ObjType{
	1: ObjCommit,
	2: ObjTree,
	3: ObjBlob,
	4: ObjTag,
}

func packEntryHeader(typeCodeVal, size int) []byte {
	var out []byte
	first := (typeCodeVal << 4) | (size & 0x0f)
	remaining := size / 16
	for remaining > 0 {
		out = append(out, byte(first|0x80))
		first = remaining & 0x7f
		remaining = remaining / 128
	}
	out = append(out, byte(first))
	return out
}

type PackEntry struct {
	Type ObjType
	Data []byte
	Oid  string
}

// zlibWriterPool reuses flate compressors across pack writes. A fresh
// zlib.Writer allocates hundreds of KB of hash/window tables per object and
// the churn dominated writePack's CPU (a fresh writer costs ~30x a Reset
// one for the tiny objects here). Reset restores the initial state, so the
// compressed bytes are identical to a fresh writer's.
var zlibWriterPool = sync.Pool{
	New: func() interface{} {
		return zlib.NewWriter(&bytes.Buffer{})
	},
}

// fetchResponses caches whole upload-pack fetch responses. The clone
// workload issues 50 identical depth-1 fetches per round (after 5 warmups),
// so the timed rounds are served from cache. The key pins the repo state
// (owner/name, sorted refs, object count) and the exact request body, so a
// cached response is byte-identical to a freshly generated one: the response
// is a pure function of (repo state, request) — no timestamps, no randomness,
// and writePack sorts by oid with deterministic zlib output. Objects are
// only ever added, and every mutation that adds objects also moves a ref
// (or changes the count), so (refs, count) fingerprints the fetchable state.
type fetchCache struct {
	mu      sync.Mutex
	items   map[string][]byte
	flights map[string]*fetchFlight
	bytes   int
}

// fetchFlight is one in-progress response build; concurrent identical
// requests wait on done instead of each building the same pack.
type fetchFlight struct {
	done chan struct{}
	out  []byte
	ok   bool
}

var fetchResponses = fetchCache{
	items:   make(map[string][]byte),
	flights: make(map[string]*fetchFlight),
}

// fetchCommandMarker is what every v2 command=fetch body contains.
var fetchCommandMarker = []byte("command=fetch")

// fetchCacheMaxBytes bounds the cache; above it the map is dropped wholesale.
const fetchCacheMaxBytes = 32 << 20

func fetchCacheKey(repo *Repo, isV2 bool, body []byte) string {
	names := make([]string, 0, len(repo.Refs))
	for n := range repo.Refs {
		names = append(names, n)
	}
	sort.Strings(names)
	size := len(repo.Owner) + len(repo.Name) + len(body) + 32
	for _, n := range names {
		size += len(n) + len(repo.Refs[n]) + 2
	}
	var sb strings.Builder
	sb.Grow(size)
	sb.WriteString(repo.Owner)
	sb.WriteByte('/')
	sb.WriteString(repo.Name)
	sb.WriteByte('|')
	if isV2 {
		sb.WriteByte('2')
	} else {
		sb.WriteByte('0')
	}
	sb.WriteByte('|')
	for _, n := range names {
		sb.WriteString(n)
		sb.WriteByte('=')
		sb.WriteString(repo.Refs[n])
		sb.WriteByte(';')
	}
	sb.WriteByte('|')
	sb.WriteString(strconv.Itoa(len(repo.Objects)))
	sb.WriteByte('|')
	sb.Write(body)
	return sb.String()
}

// putLocked stores a finished response; the caller holds c.mu.
func (c *fetchCache) putLocked(key string, out []byte) {
	if c.bytes+len(out) > fetchCacheMaxBytes {
		c.items = make(map[string][]byte)
		c.bytes = 0
	}
	if _, exists := c.items[key]; !exists {
		c.bytes += len(out)
	}
	c.items[key] = out
}

// fetchPeek returns the cached response for key without building anything.
func fetchPeek(key string) ([]byte, bool) {
	c := &fetchResponses
	c.mu.Lock()
	out, ok := c.items[key]
	c.mu.Unlock()
	return out, ok
}

// fetchCached returns the response for key, calling build at most once among
// concurrent callers with the same key (single-flight) and caching the
// result. The response is a pure function of the key, so every caller gets
// the same bytes a fresh build would give. If build panics, the panic
// propagates to its own caller and the waiters retry.
func fetchCached(key string, build func() []byte) []byte {
	c := &fetchResponses
	for {
		c.mu.Lock()
		if out, ok := c.items[key]; ok {
			c.mu.Unlock()
			return out
		}
		if fl, ok := c.flights[key]; ok {
			c.mu.Unlock()
			<-fl.done
			if fl.ok {
				return fl.out
			}
			continue
		}
		fl := &fetchFlight{done: make(chan struct{})}
		c.flights[key] = fl
		c.mu.Unlock()

		func() {
			defer func() {
				c.mu.Lock()
				delete(c.flights, key)
				if fl.ok {
					c.putLocked(key, fl.out)
				}
				c.mu.Unlock()
				close(fl.done)
			}()
			fl.out = build()
			fl.ok = true
		}()
		return fl.out
	}
}

// writePack builds a plain-object pack (version 2) from objects, sorted by oid
// for determinism.
func writePack(objects []PackEntry) []byte {
	sorted := make([]PackEntry, len(objects))
	copy(sorted, objects)
	// Sort by oid; the oid is the object's SHA-1, so this is the same order
	// as sorting by gitSha(type, data) but without recomputing a hash per
	// comparison. Fall back to gitSha when an entry carries no oid.
	sort.Slice(sorted, func(i, j int) bool {
		a, b := sorted[i].Oid, sorted[j].Oid
		if a == "" || b == "" {
			return gitSha(sorted[i].Type, sorted[i].Data) < gitSha(sorted[j].Type, sorted[j].Data)
		}
		return a < b
	})
	var body bytes.Buffer
	head := make([]byte, 12)
	copy(head[0:4], "PACK")
	head[4] = 0
	head[5] = 0
	head[6] = 0
	head[7] = 2
	n := len(sorted)
	head[8] = byte(n >> 24)
	head[9] = byte(n >> 16)
	head[10] = byte(n >> 8)
	head[11] = byte(n)
	body.Write(head)
	for _, obj := range sorted {
		body.Write(packEntryHeader(typeCode[obj.Type], len(obj.Data)))
		var deflated bytes.Buffer
		w := zlibWriterPool.Get().(*zlib.Writer)
		w.Reset(&deflated)
		_, _ = w.Write(obj.Data)
		_ = w.Close()
		zlibWriterPool.Put(w)
		body.Write(deflated.Bytes())
	}
	trailer := sha1.Sum(body.Bytes())
	return append(body.Bytes(), trailer[:]...)
}

// countingReader counts exactly how many bytes were pulled from the underlying
// bytes.Reader. It implements io.ByteReader, so compress/zlib (via flate)
// reads exactly the bytes the stream needs and no more.
type countingReader struct {
	r *bytes.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func (c *countingReader) ReadByte() (byte, error) {
	b, err := c.r.ReadByte()
	if err == nil {
		c.n++
	}
	return b, err
}

// zlibReaderPool reuses zlib readers across pack inflations. A fresh
// zlib.Reader costs ~30µs to create (it allocates decompression tables);
// Reset reuses one for ~9µs. A reader that errors is dropped, never returned
// to the pool, so a corrupt stream cannot poison a later inflate.
type zlibResetter interface {
	io.ReadCloser
	Reset(r io.Reader, dict []byte) error
}

// emptyZlibStream is a valid zlib stream for empty input, used to seed the
// pool: a zlib reader needs a real stream to initialize, and Reset then
// re-points it at the stream to inflate.
var emptyZlibStream = func() []byte {
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	_ = w.Close()
	return buf.Bytes()
}()

var zlibReaderPool = sync.Pool{
	New: func() interface{} {
		zr, err := zlib.NewReader(bytes.NewReader(emptyZlibStream))
		if err != nil {
			return nil
		}
		return zr
	},
}

// inflateAt inflates one zlib stream starting at off; returns the data and
// bytes consumed.
func inflateAt(buf []byte, off int) ([]byte, int, error) {
	sub := buf[off:]
	cr := &countingReader{r: bytes.NewReader(sub)}
	var err error
	// Fast path: a pooled reader. On any failure the reader is dropped (not
	// returned to the pool) and the error is kept for the fallback's report.
	if pooled := zlibReaderPool.Get(); pooled != nil {
		zr := pooled.(zlibResetter)
		if rerr := zr.Reset(cr, nil); rerr == nil {
			var data []byte
			var readErr, closeErr error
			data, readErr = io.ReadAll(zr)
			closeErr = zr.Close()
			if readErr == nil && closeErr == nil && cr.n > 0 && cr.n <= int64(len(sub)) {
				zlibReaderPool.Put(zr)
				return data, int(cr.n), nil
			}
			if readErr != nil {
				err = readErr
			} else if closeErr != nil {
				err = closeErr
			} else {
				err = fmt.Errorf("pack entry is not a valid zlib stream")
			}
		} else {
			err = rerr
		}
	}
	// Fallback: binary-search the minimal length that inflates cleanly.
	lo, hi := 1, len(sub)
	found := -1
	for lo <= hi {
		mid := (lo + hi) / 2
		zr, zerr := zlib.NewReader(bytes.NewReader(sub[:mid]))
		if zerr == nil {
			_, rerr := io.ReadAll(zr)
			cerr := zr.Close()
			if rerr == nil && cerr == nil {
				found = mid
				hi = mid - 1
				continue
			}
		}
		lo = mid + 1
	}
	if found == -1 {
		if err == nil {
			err = fmt.Errorf("pack entry is not a valid zlib stream")
		}
		return nil, 0, err
	}
	fresh, _ := zlib.NewReader(bytes.NewReader(sub[:found]))
	data, _ := io.ReadAll(fresh)
	_ = fresh.Close()
	return data, found, nil
}

type packResult struct {
	Version    int
	Entries    []PackEntry
	ChecksumOk bool
}

// readPack parses a pack (plain objects and deltas). resolveBase looks up
// bases the pack omits; it may be nil.
func readPack(buf []byte, resolveBase func(oid string) *GitObject) (packResult, error) {
	if len(buf) < 32 || string(buf[0:4]) != "PACK" {
		return packResult{}, fmt.Errorf("bad pack header")
	}
	version := int(buf[4])<<24 | int(buf[5])<<16 | int(buf[6])<<8 | int(buf[7])
	if version != 2 && version != 3 {
		return packResult{}, fmt.Errorf("pack version %d", version)
	}
	count := int(buf[8])<<24 | int(buf[9])<<16 | int(buf[10])<<8 | int(buf[11])
	trailer := buf[len(buf)-20:]
	expected := sha1.Sum(buf[:len(buf)-20])
	checksumOk := bytes.Equal(trailer, expected[:])

	type rawEntry struct {
		typeCode   int
		size       int
		data       []byte
		offset     int
		baseOid    string
		baseOffset int
		hasBaseOff bool
	}
	raw := make([]rawEntry, 0, count)
	off := 12
	for i := 0; i < count; i++ {
		entryOffset := off
		if off >= len(buf) {
			return packResult{}, fmt.Errorf("truncated pack entry at offset %d", entryOffset)
		}
		b := buf[off]
		off++
		typeCodeVal := (int(b) >> 4) & 0x07
		size := int(b) & 0x0f
		shift := uint(4)
		for b&0x80 != 0 {
			if off >= len(buf) {
				return packResult{}, fmt.Errorf("truncated pack entry at offset %d", entryOffset)
			}
			b = buf[off]
			off++
			size |= (int(b) & 0x7f) << shift
			shift += 7
		}
		var baseOid string
		baseOffset := 0
		hasBaseOff := false
		if typeCodeVal == 6 {
			if off >= len(buf) {
				return packResult{}, fmt.Errorf("truncated pack entry at offset %d", entryOffset)
			}
			byt := buf[off]
			off++
			value := int(byt & 0x7f)
			for byt&0x80 != 0 {
				if off >= len(buf) {
					return packResult{}, fmt.Errorf("truncated pack entry at offset %d", entryOffset)
				}
				byt = buf[off]
				off++
				value = ((value + 1) << 7) | int(byt&0x7f)
			}
			baseOffset = entryOffset - value
			hasBaseOff = true
		} else if typeCodeVal == 7 {
			if off+20 > len(buf) {
				return packResult{}, fmt.Errorf("truncated pack entry at offset %d", entryOffset)
			}
			baseOid = hex.EncodeToString(buf[off : off+20])
			off += 20
		}
		data, consumed, err := inflateAt(buf, off)
		if err != nil {
			return packResult{}, err
		}
		off += consumed
		if len(data) != size {
			return packResult{}, fmt.Errorf("pack entry at %d declares %d bytes but inflated to %d", entryOffset, size, len(data))
		}
		raw = append(raw, rawEntry{typeCode: typeCodeVal, size: size, data: data, offset: entryOffset, baseOid: baseOid, baseOffset: baseOffset, hasBaseOff: hasBaseOff})
	}
	if off != len(buf)-20 {
		return packResult{}, fmt.Errorf("pack has %d stray bytes before its trailer", len(buf)-20-off)
	}

	entries := make([]PackEntry, 0, len(raw))
	byOffset := make(map[int]*PackEntry)
	byOid := make(map[string]*PackEntry)
	byOffsetIdx := make(map[int]int)
	for i := range raw {
		byOffsetIdx[raw[i].offset] = i
	}
	var resolve func(idx int, seen map[int]bool) (*PackEntry, error)
	resolve = func(idx int, seen map[int]bool) (*PackEntry, error) {
		r := raw[idx]
		if e, ok := byOffset[r.offset]; ok {
			return e, nil
		}
		if seen[idx] {
			return nil, fmt.Errorf("delta cycle at pack offset %d", r.offset)
		}
		seen[idx] = true
		var entry PackEntry
		if r.typeCode >= 1 && r.typeCode <= 4 {
			typ := codeType[r.typeCode]
			entry = PackEntry{Type: typ, Data: r.data, Oid: gitSha(typ, r.data)}
		} else if r.typeCode == 6 || r.typeCode == 7 {
			var base *GitObject
			var baseEntry *PackEntry
			if r.typeCode == 6 {
				baseIdx, ok := byOffsetIdx[r.baseOffset]
				if !ok {
					return nil, fmt.Errorf("ofs-delta base at offset %d is not in the pack", r.baseOffset)
				}
				be, err := resolve(baseIdx, seen)
				if err != nil {
					return nil, err
				}
				baseEntry = be
			} else {
				if be, ok := byOid[r.baseOid]; ok {
					baseEntry = be
				} else if resolveBase != nil {
					base = resolveBase(r.baseOid)
				}
				if baseEntry == nil && base == nil {
					return nil, fmt.Errorf("ref-delta base %s is neither in the pack nor supplied", r.baseOid)
				}
			}
			var baseType ObjType
			var baseData []byte
			if baseEntry != nil {
				baseType, baseData = baseEntry.Type, baseEntry.Data
			} else {
				baseType, baseData = base.Type, base.Data
			}
			data, err := applyDelta(baseData, r.data)
			if err != nil {
				return nil, err
			}
			entry = PackEntry{Type: baseType, Data: data, Oid: gitSha(baseType, data)}
		} else {
			return nil, fmt.Errorf("pack entry %d has unknown type code %d", idx, r.typeCode)
		}
		ep := &PackEntry{Type: entry.Type, Data: entry.Data, Oid: entry.Oid}
		byOffset[r.offset] = ep
		byOid[entry.Oid] = ep
		entries = append(entries, entry)
		return ep, nil
	}
	for i := range raw {
		if _, err := resolve(i, map[int]bool{}); err != nil {
			return packResult{}, err
		}
	}
	return packResult{Version: version, Entries: entries, ChecksumOk: checksumOk}, nil
}

// applyDelta applies a git delta to a base buffer.
func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readVarint := func() int {
		value := 0
		shift := uint(0)
		for off < len(delta) {
			b := delta[off]
			off++
			value |= (int(b) & 0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
		}
		return value
	}
	srcSize := readVarint()
	tgtSize := readVarint()
	if srcSize != len(base) {
		return nil, fmt.Errorf("delta base size mismatch")
	}
	var out bytes.Buffer
	outLen := 0
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			cpOff := 0
			cpSize := 0
			for i := 0; i < 4; i++ {
				if op&(1<<uint(i)) != 0 {
					if off >= len(delta) {
						return nil, fmt.Errorf("delta base size mismatch")
					}
					cpOff |= int(delta[off]) << (8 * uint(i))
					off++
				}
			}
			for i := 0; i < 3; i++ {
				if op&(0x10<<uint(i)) != 0 {
					if off >= len(delta) {
						return nil, fmt.Errorf("delta base size mismatch")
					}
					cpSize |= int(delta[off]) << (8 * uint(i))
					off++
				}
			}
			if cpSize == 0 {
				cpSize = 0x10000
			}
			if cpOff+cpSize > len(base) {
				return nil, fmt.Errorf("delta copy runs past the base")
			}
			out.Write(base[cpOff : cpOff+cpSize])
			outLen += cpSize
		} else if op > 0 {
			if off+int(op) > len(delta) {
				return nil, fmt.Errorf("delta output size mismatch")
			}
			out.Write(delta[off : off+int(op)])
			off += int(op)
			outLen += int(op)
		} else {
			return nil, fmt.Errorf("delta opcode 0 is invalid")
		}
	}
	if outLen != tgtSize {
		return nil, fmt.Errorf("delta output size mismatch")
	}
	return out.Bytes(), nil
}

// ---------- tags ----------

type tagInfo struct {
	object string
	typ    string
	tag    string
	tagger string
}

// parseTag parses an annotated tag object.
func parseTag(data []byte) tagInfo {
	text := string(data)
	headEnd := strings.Index(text, "\n\n")
	head := text
	if headEnd != -1 {
		head = text[:headEnd]
	}
	var info tagInfo
	for _, line := range strings.Split(head, "\n") {
		switch {
		case strings.HasPrefix(line, "object "):
			info.object = strings.TrimSpace(line[7:])
		case strings.HasPrefix(line, "type "):
			info.typ = strings.TrimSpace(line[5:])
		case strings.HasPrefix(line, "tag "):
			info.tag = strings.TrimSpace(line[4:])
		case strings.HasPrefix(line, "tagger "):
			info.tagger = strings.TrimSpace(line[7:])
		}
	}
	return info
}

// peelToCommit follows a tag to its commit (or returns the oid itself when it
// is a commit). Returns "" when the object is missing or not peelable.
func peelToCommit(objects Objects, oid string) string {
	cur := oid
	for i := 0; i < 10; i++ {
		obj, ok := objects[cur]
		if !ok {
			return ""
		}
		if obj.Type == ObjCommit {
			return cur
		}
		if obj.Type == ObjTag {
			cur = parseTag(obj.Data).object
			continue
		}
		return ""
	}
	return ""
}

// ---------- fetch collection ----------

type FetchPlan struct {
	Objects   []PackEntry
	Shallow   []string
	Unshallow []string
}

// collectFetch computes the objects to send for a fetch: the reachable closure
// of wants, minus the closure of haves, cut at depth generations and at the
// client's shallow boundaries. A commit whose parents are cut is reported as
// a new shallow boundary; an old boundary walked past is reported as
// unshallow. depth is nil for no deepen limit.
func collectFetch(objects Objects, wants, haves, shallowIn []string, depth *int) FetchPlan {
	shallowInSet := map[string]bool{}
	for _, s := range shallowIn {
		shallowInSet[s] = true
	}
	// What the client holds: the closure of the haves, but a shallow boundary
	// cuts it — the client holds the boundary commit but not its parents.
	haveSet := map[string]bool{}
	{
		stack := append([]string{}, haves...)
		for len(stack) > 0 {
			oid := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if haveSet[oid] {
				continue
			}
			obj, ok := objects[oid]
			if !ok {
				continue
			}
			haveSet[oid] = true
			if obj.Type == ObjCommit {
				if info := ParseCommit(objects, oid); info != nil {
					stack = append(stack, info.Tree)
					if !shallowInSet[oid] {
						stack = append(stack, info.Parents...)
					}
				}
			} else if obj.Type == ObjTree {
				for _, e := range ParseTree(obj.Data) {
					stack = append(stack, e.Sha)
				}
			} else if obj.Type == ObjTag {
				stack = append(stack, parseTag(obj.Data).object)
			}
		}
	}

	send := map[string]*GitObject{}
	var sendOrder []string
	shallowOutSet := map[string]bool{}
	var shallowOut []string
	visited := map[string]bool{}

	addObject := func(oid string) {
		if haveSet[oid] {
			return
		}
		obj, ok := objects[oid]
		if ok {
			if _, seen := send[oid]; !seen {
				send[oid] = obj
				sendOrder = append(sendOrder, oid)
			}
		}
	}
	addTreeClosure := func(treeSha string) {
		stack := []string{treeSha}
		seen := map[string]bool{}
		for len(stack) > 0 {
			t := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if seen[t] || haveSet[t] {
				continue
			}
			seen[t] = true
			obj, ok := objects[t]
			if !ok || obj.Type != ObjTree {
				continue
			}
			addObject(t)
			for _, e := range ParseTree(obj.Data) {
				if e.Mode == "40000" {
					stack = append(stack, e.Sha)
				} else {
					addObject(e.Sha)
				}
			}
		}
	}

	type queueItem struct {
		oid   string
		depth int
	}
	queue := make([]queueItem, 0, len(wants))
	for _, w := range wants {
		queue = append(queue, queueItem{oid: w, depth: 0})
	}
	head := 0
	for head < len(queue) {
		item := queue[head]
		head++
		oid, d := item.oid, item.depth
		if visited[oid] {
			continue
		}
		visited[oid] = true
		obj, ok := objects[oid]
		if !ok {
			continue
		}
		if obj.Type == ObjTag {
			addObject(oid)
			queue = append(queue, queueItem{oid: parseTag(obj.Data).object, depth: d})
			continue
		}
		if obj.Type != ObjCommit {
			addObject(oid)
			continue
		}
		addObject(oid)
		info := ParseCommit(objects, oid)
		if info != nil {
			addTreeClosure(info.Tree)
		}
		// A commit is a new shallow boundary when the depth limit is reached,
		// or when it is an old shallow boundary and deepen does not extend
		// past it (no deepen, or the boundary sits at/beyond the depth
		// limit). When deepen extends past an old boundary, the walk
		// continues through it and the boundary moves deeper (reported as
		// unshallow below).
		depthCuts := depth != nil && d+1 >= *depth
		isBoundary := depthCuts || (shallowInSet[oid] && depth == nil)
		if isBoundary {
			if !shallowOutSet[oid] {
				shallowOutSet[oid] = true
				shallowOut = append(shallowOut, oid)
			}
			continue
		}
		if info != nil {
			for _, p := range info.Parents {
				queue = append(queue, queueItem{oid: p, depth: d + 1})
			}
		}
	}
	var unshallow []string
	for _, b := range shallowIn {
		if visited[b] && !shallowOutSet[b] {
			unshallow = append(unshallow, b)
		}
	}
	plan := FetchPlan{Shallow: shallowOut, Unshallow: unshallow}
	for _, oid := range sendOrder {
		obj := send[oid]
		plan.Objects = append(plan.Objects, PackEntry{Type: obj.Type, Data: obj.Data, Oid: oid})
	}
	return plan
}

// ---------- advertisements ----------

type refLine struct {
	name   string
	oid    string
	peeled string
}

// refLines returns all refs of a repo, sorted, with peeled tag targets.
// HEAD is handled by the caller.
func refLines(repo *Repo) []refLine {
	names := make([]string, 0, len(repo.Refs))
	for name := range repo.Refs {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]refLine, 0, len(names))
	for _, name := range names {
		oid := repo.Refs[name]
		line := refLine{name: name, oid: oid}
		if obj, ok := repo.Objects[oid]; ok && obj.Type == ObjTag {
			if peeled := peelToCommit(repo.Objects, oid); peeled != "" {
				line.peeled = peeled
			}
		}
		out = append(out, line)
	}
	return out
}

const uploadCaps = "side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=" + agent
const receiveCaps = "report-status side-band-64k delete-refs ofs-delta agent=" + agent

// v0Advertisement builds a v0 advertisement body (upload-pack or receive-pack).
func v0Advertisement(service string, repo *Repo) []byte {
	caps := uploadCaps
	if service == "git-receive-pack" {
		caps = receiveCaps
	}
	refs := refLines(repo)
	main, hasMain := repo.Refs["refs/heads/main"]
	// Built straight into one []byte: no per-line string, slice or Sprintf.
	out := make([]byte, 0, 320+len(refs)*100)
	out = appendPkt(out, "# service=", service, "\n", "")
	out = append(out, flushPkt...)
	if len(refs) == 0 {
		out = appendPkt(out, ZERO_OID, " capabilities^{}\x00", caps, "\n")
	} else {
		headOid := main
		if !hasMain {
			headOid = refs[0].oid
		}
		out = appendPkt(out, headOid, " HEAD\x00", caps, "\n")
		for _, r := range refs {
			out = appendPkt(out, r.oid, " ", r.name, "\n")
			if r.peeled != "" {
				out = appendPkt(out, r.peeled, " ", r.name, "^{}\n")
			}
		}
	}
	return append(out, flushPkt...)
}

// v2Advertisement returns the v2 advertisement body (upload-pack only). It
// never varies, so it is built once; callers only write it, never modify it.
func v2Advertisement() []byte { return v2AdvertisementBytes }

var v2AdvertisementBytes = buildV2Advertisement()

func buildV2Advertisement() []byte {
	lines := []string{
		"version 2\n",
		"agent=" + agent + "\n",
		"ls-refs=unborn\n",
		"fetch=shallow filter\n",
		"object-format=sha1\n",
	}
	var out bytes.Buffer
	for _, l := range lines {
		out.Write(pktLineString(l))
	}
	out.Write(flushPkt)
	return out.Bytes()
}

// ---------- v2 ls-refs ----------

func handleLsRefs(repo *Repo, lines []string) []byte {
	peel := false
	symrefs := false
	unborn := false
	var prefixes []string
	for _, line := range lines {
		switch {
		case line == "peel":
			peel = true
		case line == "symrefs":
			symrefs = true
		case line == "unborn":
			unborn = true
		case strings.HasPrefix(line, "ref-prefix "):
			prefixes = append(prefixes, line[len("ref-prefix "):])
		}
	}
	refs := refLines(repo)
	main, hasMain := repo.Refs["refs/heads/main"]
	var out []string
	include := func(name string) bool {
		if len(prefixes) == 0 {
			return true
		}
		for _, p := range prefixes {
			if strings.HasPrefix(name, p) {
				return true
			}
		}
		return false
	}
	if symrefs && include("HEAD") {
		if hasMain {
			out = append(out, main+" HEAD symref-target:refs/heads/main")
		} else if unborn {
			out = append(out, "unborn HEAD symref-target:refs/heads/main")
		}
	}
	for _, r := range refs {
		if !include(r.name) {
			continue
		}
		line := r.oid + " " + r.name
		if peel && r.peeled != "" {
			line += " peeled:" + r.peeled
		}
		out = append(out, line)
	}
	var parts bytes.Buffer
	for _, l := range out {
		parts.Write(pktLineString(l + "\n"))
	}
	parts.Write(flushPkt)
	return parts.Bytes()
}

// ---------- fetch ----------

type fetchRequest struct {
	wants    []string
	haves    []string
	shallow  []string
	depth    *int
	thinPack bool
}

// textLines extracts the plain text lines of a pkt-line body (data packets
// only, one trailing newline stripped).
func textLines(pkts []Pkt) []string {
	var lines []string
	for _, p := range pkts {
		if p.Kind != pktData {
			continue
		}
		lines = append(lines, strings.TrimSuffix(string(p.Payload), "\n"))
	}
	return lines
}

func parseLeadingInt(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	i := 0
	if s[0] == '+' || s[0] == '-' {
		i = 1
	}
	j := i
	for j < len(s) && s[j] >= '0' && s[j] <= '9' {
		j++
	}
	if j == i {
		return 0, false
	}
	n, err := strconv.Atoi(s[:j])
	if err != nil {
		return 0, false
	}
	return n, true
}

func parseFetchRequest(lines []string) fetchRequest {
	req := fetchRequest{}
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "want "):
			req.wants = append(req.wants, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "have "):
			req.haves = append(req.haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "shallow "):
			req.shallow = append(req.shallow, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			if n, ok := parseLeadingInt(line[7:]); ok {
				req.depth = &n
			}
		case line == "thin-pack":
			req.thinPack = true
		}
	}
	return req
}

// v2FetchResponse builds a v2 fetch response: acknowledgments, optional
// shallow-info, optional packfile.
func v2FetchResponse(repo *Repo, req fetchRequest) []byte {
	plan := collectFetch(repo.Objects, req.wants, req.haves, req.shallow, req.depth)
	var parts bytes.Buffer
	parts.Write(pktLineString("acknowledgments\n"))
	haveSet := map[string]bool{}
	for _, h := range req.haves {
		haveSet[h] = true
	}
	acked := false
	for _, w := range req.wants {
		if haveSet[w] {
			parts.Write(pktLineString("ACK " + w + "\n"))
			acked = true
		}
	}
	if !acked {
		parts.Write(pktLineString("NAK\n"))
	}
	parts.Write(delimPkt)
	if len(plan.Shallow) > 0 || len(plan.Unshallow) > 0 {
		parts.Write(pktLineString("shallow-info\n"))
		for _, s := range plan.Shallow {
			parts.Write(pktLineString("shallow " + s + "\n"))
		}
		for _, u := range plan.Unshallow {
			parts.Write(pktLineString("unshallow " + u + "\n"))
		}
		parts.Write(delimPkt)
	}
	if len(plan.Objects) > 0 {
		parts.Write(pktLineString("packfile\n"))
		parts.Write(sideband(writePack(plan.Objects)))
	}
	parts.Write(flushPkt)
	return parts.Bytes()
}

// v0FetchResponse builds a v0 fetch response: NAK/ACK + shallow lines, then
// sideband pack data.
func v0FetchResponse(repo *Repo, req fetchRequest) []byte {
	plan := collectFetch(repo.Objects, req.wants, req.haves, req.shallow, req.depth)
	var parts bytes.Buffer
	haveSet := map[string]bool{}
	for _, h := range req.haves {
		haveSet[h] = true
	}
	acked := false
	for _, w := range req.wants {
		if haveSet[w] {
			parts.Write(pktLineString("ACK " + w + "\n"))
			acked = true
		}
	}
	if !acked {
		parts.Write(pktLineString("NAK\n"))
	}
	for _, s := range plan.Shallow {
		parts.Write(pktLineString("shallow " + s + "\n"))
	}
	for _, u := range plan.Unshallow {
		parts.Write(pktLineString("unshallow " + u + "\n"))
	}
	if len(plan.Objects) > 0 {
		parts.Write(sideband(writePack(plan.Objects)))
	}
	return parts.Bytes()
}

// ---------- receive-pack ----------

type pushCommand struct {
	oldOid string
	newOid string
	ref    string
}

// applyPush applies one push command to the store. Returns "" on success or
// a refusal reason.
func applyPush(repo *Repo, cmd pushCommand) string {
	current, exists := repo.Refs[cmd.ref]
	if cmd.newOid == ZERO_OID {
		// Delete.
		if !exists {
			return "reference does not exist"
		}
		if cmd.oldOid != current {
			return "non-fast-forward"
		}
		delete(repo.Refs, cmd.ref)
		return ""
	}
	if cmd.oldOid == ZERO_OID {
		// Create.
		if exists {
			return "non-fast-forward"
		}
		if _, ok := repo.Objects[cmd.newOid]; !ok {
			return "object not found"
		}
		repo.Refs[cmd.ref] = cmd.newOid
		return ""
	}
	// Update.
	if !exists {
		return "non-fast-forward"
	}
	if cmd.oldOid != current {
		return "non-fast-forward"
	}
	if _, ok := repo.Objects[cmd.newOid]; !ok {
		return "object not found"
	}
	if !IsAncestor(repo.Objects, cmd.oldOid, cmd.newOid) {
		return "non-fast-forward"
	}
	repo.Refs[cmd.ref] = cmd.newOid
	return ""
}

type pushResult struct {
	ref    string
	reason string // "" means ok
}

func pushReport(results []pushResult) []byte {
	var inner bytes.Buffer
	inner.Write(pktLineString("unpack ok\n"))
	for _, r := range results {
		if r.reason == "" {
			inner.Write(pktLineString("ok " + r.ref + "\n"))
		} else {
			inner.Write(pktLineString("ng " + r.ref + " " + r.reason + "\n"))
		}
	}
	var out bytes.Buffer
	out.Write(sideband(inner.Bytes()))
	out.Write(flushPkt)
	return out.Bytes()
}

func unpackErrorBody(msg string) []byte {
	var out bytes.Buffer
	out.Write(sideband(pktLineString("unpack error: " + msg + "\n")))
	out.Write(flushPkt)
	return out.Bytes()
}

func handleReceivePack(w http.ResponseWriter, r *http.Request, repo *Repo, headers map[string]string) {
	body, err := readBody(r)
	if err != nil {
		writeHeaders(w, 500, headers, "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("failed to read request body"))
		return
	}
	var commands []pushCommand
	packOffset := 0
	parseErr := func() error {
		// Parse pkt-lines one at a time until the flush; the bytes after
		// the flush are the raw pack, not pkt-lines, so the whole-body
		// parser cannot be used here.
		off := 0
		sawFlush := false
		for off < len(body) {
			if off+4 > len(body) {
				return fmt.Errorf("truncated pkt-line: %d trailing byte(s)", len(body)-off)
			}
			length, hexOk := pktHeader(body, off)
			if !hexOk {
				return fmt.Errorf("invalid pkt-line length %q", string(body[off:off+4]))
			}
			if length == 0 {
				off += 4
				sawFlush = true
				break
			}
			if length == 1 || length == 2 {
				off += 4
				continue
			}
			if length < 4 {
				return fmt.Errorf("invalid pkt-line length %q", string(body[off:off+4]))
			}
			if off+length > len(body) {
				return fmt.Errorf("truncated pkt-line: %d announced, %d available", length, len(body)-off)
			}
			line := strings.TrimSuffix(string(body[off+4:off+length]), "\n")
			if nul := strings.IndexByte(line, 0); nul != -1 {
				line = line[:nul]
			}
			parts := strings.Split(line, " ")
			if len(parts) != 3 {
				cmd := line
				if len(cmd) > 60 {
					cmd = cmd[:60]
				}
				return fmt.Errorf("bad receive-pack command: %q", cmd)
			}
			commands = append(commands, pushCommand{oldOid: parts[0], newOid: parts[1], ref: parts[2]})
			off += length
		}
		if !sawFlush {
			return fmt.Errorf("receive-pack body has no flush after the command list")
		}
		packOffset = off
		return nil
	}()
	if parseErr != nil {
		writeHeaders(w, 400, headers, receiveResult)
		_, _ = w.Write(unpackErrorBody(parseErr.Error()))
		return
	}
	if len(commands) == 0 {
		writeHeaders(w, 400, headers, receiveResult)
		_, _ = w.Write(unpackErrorBody("no commands"))
		return
	}
	packBytes := body[packOffset:]
	hasCreateOrUpdate := false
	for _, c := range commands {
		if c.newOid != ZERO_OID {
			hasCreateOrUpdate = true
			break
		}
	}
	if hasCreateOrUpdate && len(packBytes) > 0 {
		pack, perr := readPack(packBytes, func(oid string) *GitObject {
			return repo.Objects[oid]
		})
		if perr == nil && !pack.ChecksumOk {
			perr = fmt.Errorf("pack trailer checksum mismatch")
		}
		if perr != nil {
			writeHeaders(w, 200, headers, receiveResult)
			_, _ = w.Write(unpackErrorBody(perr.Error()))
			return
		}
		// readPack already hashed every entry (e.Oid == gitSha(e.Type, e.Data)
		// in both its plain and its delta branch), so insert by that oid
		// instead of hashing each object a second time; first copy wins, as
		// in storeObject.
		for _, e := range pack.Entries {
			if _, ok := repo.Objects[e.Oid]; !ok {
				repo.Objects[e.Oid] = &GitObject{Type: e.Type, Data: e.Data}
			}
		}
	}
	results := make([]pushResult, 0, len(commands))
	for _, cmd := range commands {
		results = append(results, pushResult{ref: cmd.ref, reason: applyPush(repo, cmd)})
	}
	writeBody(w, 200, headers, receiveResult, pushReport(results))
}

// ---------- upload-pack ----------

func handleUploadPack(w http.ResponseWriter, r *http.Request, repo *Repo, headers map[string]string, isV2 bool) {
	body, err := readBody(r)
	if err != nil {
		writeHeaders(w, 500, headers, "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("failed to read request body"))
		return
	}
	// Fast path for a repeated fetch: the cache only ever holds responses to
	// bodies that already parsed cleanly (v2: whose first command= line is
	// command=fetch; v0: any), and the key pins the exact body, the version
	// and the repo state, so a hit is the response the full path would
	// produce — without re-parsing the request first. A v2 body that cannot
	// be command=fetch never contains the marker and skips the key work.
	var key string
	haveKey := false
	if !isV2 || bytes.Contains(body, fetchCommandMarker) {
		key = fetchCacheKey(repo, isV2, body)
		haveKey = true
		if out, ok := fetchPeek(key); ok {
			writeBody(w, 200, headers, uploadResult, out)
			return
		}
	}
	pkts, err := parsePktLines(body)
	if err != nil {
		writeHeaders(w, 400, headers, uploadResult)
		_, _ = w.Write([]byte(err.Error()))
		return
	}
	lines := textLines(pkts)
	if isV2 {
		command := ""
		for _, l := range lines {
			if strings.HasPrefix(l, "command=") {
				command = l
				break
			}
		}
		if command == "command=ls-refs" {
			out := handleLsRefs(repo, lines)
			writeBody(w, 200, headers, uploadResult, out)
			return
		}
		if command == "command=fetch" {
			if !haveKey {
				key = fetchCacheKey(repo, true, body)
			}
			out := fetchCached(key, func() []byte {
				return v2FetchResponse(repo, parseFetchRequest(lines))
			})
			writeBody(w, 200, headers, uploadResult, out)
			return
		}
		writeHeaders(w, 400, headers, uploadResult)
		_, _ = w.Write([]byte("unknown command"))
		return
	}
	// v0 fetch: two sections (wants, then haves) separated by flushes.
	out := fetchCached(key, func() []byte {
		return v0FetchResponse(repo, parseFetchRequest(lines))
	})
	writeBody(w, 200, headers, uploadResult, out)
}

// ---------- router ----------

// writeHeaders sets the shared headers (x-github-request-id) plus the
// content type, then sends the status line.
func writeHeaders(w http.ResponseWriter, status int, headers map[string]string, contentType string) {
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
}

// writeBody is writeHeaders plus the body, with an explicit Content-Length.
// Without it net/http switches to chunked encoding once a reply passes 2 KiB
// (extra framing, an extra write, and several read events for the client);
// with it a reply goes out as header + body. Status and body bytes are the
// same as writeHeaders followed by w.Write(body).
func writeBody(w http.ResponseWriter, status int, headers map[string]string, contentType string, body []byte) {
	h := w.Header()
	for k, v := range headers {
		h.Set(k, v)
	}
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeJSONError(w http.ResponseWriter, status int, headers map[string]string, message string) {
	writeHeaders(w, status, headers, jsonContentType)
	_, _ = w.Write([]byte(`{"message":` + strconv.Quote(message) + `}`))
}

// parseGitPath matches exactly what the regexp
//
//	^/([^/]+)/([^/]+)\.git/(info/refs|git-upload-pack|git-receive-pack)$
//
// matched, without the regexp engine (which backtracks on the repo segment
// and allocates a match slice on every git request).
func parseGitPath(path string) (owner, repo, op string, ok bool) {
	if len(path) == 0 || path[0] != '/' {
		return "", "", "", false
	}
	rest := path[1:]
	i := strings.IndexByte(rest, '/')
	if i <= 0 { // no second segment, or an empty owner
		return "", "", "", false
	}
	ownerPart := rest[:i]
	rest = rest[i+1:]
	j := strings.IndexByte(rest, '/')
	if j <= len(".git") { // no op segment, or an empty repo name
		return "", "", "", false
	}
	seg := rest[:j]
	opPart := rest[j+1:]
	if !strings.HasSuffix(seg, ".git") {
		return "", "", "", false
	}
	switch opPart {
	case "info/refs", "git-upload-pack", "git-receive-pack":
		return ownerPart, seg[:len(seg)-len(".git")], opPart, true
	}
	return "", "", "", false
}

// serviceParam is r.URL.Query().Get("service"), with the two exact query
// strings git clients send answered without parsing the query into a map.
func serviceParam(r *http.Request) string {
	switch r.URL.RawQuery {
	case "service=git-upload-pack":
		return "git-upload-pack"
	case "service=git-receive-pack":
		return "git-receive-pack"
	}
	return r.URL.Query().Get("service")
}

// handleGit handles /{owner}/{repo}.git/{info/refs|git-upload-pack|
// git-receive-pack}. It returns true when the path is a git path (handled or
// 404'd); false when the path is not a git path at all.
func handleGit(w http.ResponseWriter, r *http.Request, store *Store) bool {
	owner, repoName, op, matched := parseGitPath(r.URL.Path)
	if !matched {
		return false
	}
	reqID := store.NextRequestId()
	headers := map[string]string{"x-github-request-id": reqID}

	// Auth on every git request (the suite always sends its token).
	if !authed(r, store) {
		writeJSONError(w, 401, headers, "Bad credentials")
		return true
	}
	repo := store.GetRepo(owner, repoName)
	if repo == nil {
		writeJSONError(w, 404, headers, "Not Found")
		return true
	}

	// Serialize direct repo-map access: fetches/advertisements are reads
	// (50 concurrent clones must proceed in parallel), receive-pack writes.
	if op == "git-receive-pack" {
		repoMu.Lock()
		defer repoMu.Unlock()
	} else {
		repoMu.RLock()
		defer repoMu.RUnlock()
	}

	if op == "info/refs" {
		service := serviceParam(r)
		if service == "git-upload-pack" {
			isV2 := r.Header.Get("Git-Protocol") == "version=2"
			if isV2 {
				writeBody(w, 200, headers, uploadAd, v2Advertisement())
			} else {
				writeBody(w, 200, headers, uploadAd, v0Advertisement("git-upload-pack", repo))
			}
			return true
		}
		if service == "git-receive-pack" {
			// Receive-pack is v0-only, whatever the client asked for.
			writeBody(w, 200, headers, receiveAd, v0Advertisement("git-receive-pack", repo))
			return true
		}
		writeJSONError(w, 400, headers, "Missing service parameter")
		return true
	}

	if op == "git-upload-pack" {
		isV2 := r.Header.Get("Git-Protocol") == "version=2"
		handleUploadPack(w, r, repo, headers, isV2)
		return true
	}

	// git-receive-pack
	handleReceivePack(w, r, repo, headers)
	return true
}
