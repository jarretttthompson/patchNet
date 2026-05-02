/**
 * Minimal WebM/EBML cue injector.
 *
 * MediaRecorder produces WebM files without a Cues / SeekHead element, so
 * setting `currentTime` on an HTMLVideoElement falls back to keyframe scans
 * and can fail entirely on tight loop ranges. This module reads the recorded
 * file, walks its Cluster timestamps, and rewrites it with:
 *
 *   EBML-header
 *   Segment (known size) {
 *     SeekHead → { Info, Tracks, Cues }
 *     Info
 *     Tracks
 *     ...all Clusters (bytes copied verbatim)
 *     Cues (one CuePoint per Cluster, pointing at the first video track)
 *   }
 *
 * The result is a fully-seekable WebM. We only parse the structure we need
 * (top-level Segment children, plus Cluster Timecode + first video track id);
 * everything else is treated as opaque bytes.
 *
 * No external deps. No streaming — entire file is loaded once. Files are
 * capped by vbuf*'s maxSeconds (default 60s), so memory is bounded.
 */

const ID = {
  EBML: 0x1A45DFA3,
  Segment: 0x18538067,
  SeekHead: 0x114D9B74,
  Seek: 0x4DBB,
  SeekID: 0x53AB,
  SeekPosition: 0x53AC,
  Void: 0xEC,
  Info: 0x1549A966,
  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackNumber: 0xD7,
  TrackType: 0x83,
  Cluster: 0x1F43B675,
  Timecode: 0xE7,
  SimpleBlock: 0xA3,
  BlockGroup: 0xA0,
  Block: 0xA1,
  Cues: 0x1C53BB6B,
  CuePoint: 0xBB,
  CueTime: 0xB3,
  CueTrackPositions: 0xB7,
  CueTrack: 0xF7,
  CueClusterPosition: 0xF1,
};

const TRACK_TYPE_VIDEO = 1;

// ─── VINT (variable-length integer) helpers ───────────────────────────

interface VintRead { value: bigint; bytes: number; isUnknown: boolean; }

/** Read a VINT whose leading-bit width is preserved (used for element IDs). */
function readId(buf: Uint8Array, off: number): { id: number; bytes: number } {
  if (off >= buf.length) throw new Error("readId past EOF");
  const first = buf[off];
  if (first === 0) throw new Error("invalid VINT (zero leading byte)");
  let len = 0;
  for (let i = 7; i >= 0; i--) if (first & (1 << i)) { len = 8 - i; break; }
  if (off + len > buf.length) throw new Error("readId truncated");
  let id = first;
  for (let i = 1; i < len; i++) id = ((id * 256) + buf[off + i]) >>> 0;
  return { id, bytes: len };
}

/** Read a VINT whose leading bit is stripped (used for element sizes). */
function readSize(buf: Uint8Array, off: number): VintRead {
  if (off >= buf.length) throw new Error("readSize past EOF");
  const first = buf[off];
  if (first === 0) throw new Error("invalid VINT (zero leading byte)");
  let len = 0;
  for (let i = 7; i >= 0; i--) if (first & (1 << i)) { len = 8 - i; break; }
  if (off + len > buf.length) throw new Error("readSize truncated");
  // Strip the leading 1-bit
  let v = BigInt(first & ((1 << (8 - len)) - 1));
  for (let i = 1; i < len; i++) v = (v << 8n) | BigInt(buf[off + i]);
  // Unknown-size sentinel: all data bits set
  const allOnes = (1n << BigInt(7 * len)) - 1n;
  return { value: v, bytes: len, isUnknown: v === allOnes };
}

/** Encode a uint as a VINT of fixed `len` bytes, leading-1-bit included. */
function writeVintFixed(value: bigint, len: number, out: number[]): void {
  if (len < 1 || len > 8) throw new Error(`writeVintFixed bad len ${len}`);
  const max = (1n << BigInt(7 * len)) - 2n; // -2 to avoid the unknown sentinel
  if (value > max) throw new Error(`value ${value} too large for ${len}-byte VINT`);
  const bytes = new Array<number>(len).fill(0);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { bytes[i] = Number(v & 0xFFn); v >>= 8n; }
  bytes[0] |= 1 << (8 - len);
  for (const b of bytes) out.push(b);
}

/** Pick the smallest VINT length that encodes `value` (excluding the unknown sentinel). */
function vintLenFor(value: bigint): number {
  for (let len = 1; len <= 8; len++) {
    const max = (1n << BigInt(7 * len)) - 2n;
    if (value <= max) return len;
  }
  throw new Error(`value ${value} too large`);
}

// ─── Element writers ──────────────────────────────────────────────────

function writeId(id: number, out: number[]): void {
  // ID encoding preserves the leading-1 bit; the value IS the encoded bytes.
  // Determine length from the high bit of the most-significant byte.
  let bytes: number[];
  if (id <= 0xFF)            bytes = [id];
  else if (id <= 0xFFFF)     bytes = [(id >> 8) & 0xFF, id & 0xFF];
  else if (id <= 0xFFFFFF)   bytes = [(id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF];
  else                       bytes = [(id >> 24) & 0xFF, (id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF];
  for (const b of bytes) out.push(b);
}

/** Write an element with explicit size header. */
function writeElement(id: number, payload: number[], out: number[]): void {
  writeId(id, out);
  const sizeLen = vintLenFor(BigInt(payload.length));
  writeVintFixed(BigInt(payload.length), sizeLen, out);
  for (const b of payload) out.push(b);
}

function writeUint(value: bigint, out: number[]): void {
  // Smallest big-endian unsigned encoding (1..8 bytes).
  if (value === 0n) { out.push(0); return; }
  const bytes: number[] = [];
  let v = value;
  while (v > 0n) { bytes.unshift(Number(v & 0xFFn)); v >>= 8n; }
  for (const b of bytes) out.push(b);
}

function elementBytes(id: number, payload: number[]): number[] {
  const out: number[] = [];
  writeElement(id, payload, out);
  return out;
}

function uintElement(id: number, value: bigint): number[] {
  const body: number[] = [];
  writeUint(value, body);
  return elementBytes(id, body);
}

function idElement(id: number, idValue: number): number[] {
  // SeekID's payload is the raw id bytes (preserving the VINT leading-1).
  const body: number[] = [];
  writeId(idValue, body);
  return elementBytes(id, body);
}

// ─── Parser ───────────────────────────────────────────────────────────

interface TopChild {
  id: number;
  /** Offset of element header (id byte) in the source buffer. */
  headerOff: number;
  /** Offset of element data in the source buffer. */
  dataOff: number;
  /** Data length in bytes. */
  dataSize: number;
  /** Total bytes from headerOff (header + data). */
  totalSize: number;
}

interface ParsedSegment {
  segmentDataOff: number;
  segmentDataEnd: number;
  ebmlHeaderBytes: Uint8Array;
  /** All immediate Segment children, in file order. */
  children: TopChild[];
}

function parseTopLevel(buf: Uint8Array): ParsedSegment {
  // 1) EBML header
  const idHdr = readId(buf, 0);
  if (idHdr.id !== ID.EBML) throw new Error(`expected EBML header, got 0x${idHdr.id.toString(16)}`);
  const sizeHdr = readSize(buf, idHdr.bytes);
  const ebmlEnd = idHdr.bytes + sizeHdr.bytes + Number(sizeHdr.value);
  const ebmlHeaderBytes = buf.subarray(0, ebmlEnd);

  // 2) Segment
  const segIdRead = readId(buf, ebmlEnd);
  if (segIdRead.id !== ID.Segment) throw new Error(`expected Segment, got 0x${segIdRead.id.toString(16)}`);
  const segSizeRead = readSize(buf, ebmlEnd + segIdRead.bytes);
  const segDataOff = ebmlEnd + segIdRead.bytes + segSizeRead.bytes;
  const segDataEnd = segSizeRead.isUnknown
    ? buf.length
    : segDataOff + Number(segSizeRead.value);

  // 3) Walk Segment children
  const children: TopChild[] = [];
  let off = segDataOff;
  while (off < segDataEnd) {
    if (off + 1 > buf.length) break;
    let idr: { id: number; bytes: number };
    try { idr = readId(buf, off); } catch { break; }
    let szr: VintRead;
    try { szr = readSize(buf, off + idr.bytes); } catch { break; }
    const dataOff = off + idr.bytes + szr.bytes;
    let dataSize: number;
    if (szr.isUnknown) {
      // Unknown-size element runs to the next top-level sibling. For our
      // parser, this only realistically happens on a Cluster — find the next
      // top-level ID by scanning.
      dataSize = scanNextSiblingEnd(buf, dataOff, segDataEnd) - dataOff;
    } else {
      dataSize = Number(szr.value);
    }
    const total = idr.bytes + szr.bytes + dataSize;
    if (dataOff + dataSize > segDataEnd) break;
    children.push({ id: idr.id, headerOff: off, dataOff, dataSize, totalSize: total });
    off += total;
  }

  return { segmentDataOff: segDataOff, segmentDataEnd: segDataEnd, ebmlHeaderBytes, children };
}

/** When a Cluster has unknown size (MediaRecorder live mode), scan forward
 *  for the next top-level ID to determine where it ends. */
function scanNextSiblingEnd(buf: Uint8Array, fromOff: number, hardEnd: number): number {
  // Look for any of the Segment-level IDs.
  const targets = new Set<number>([
    ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Void,
  ]);
  let off = fromOff;
  while (off < hardEnd - 4) {
    // Try to read an ID at this offset.
    try {
      const idr = readId(buf, off);
      if (targets.has(idr.id)) return off;
    } catch { /* fall through */ }
    off++;
  }
  return hardEnd;
}

/** Read a Cluster's Timecode child (uint, in TimecodeScale units). */
function readClusterTimecode(buf: Uint8Array, dataOff: number, dataSize: number): bigint {
  const end = dataOff + dataSize;
  let off = dataOff;
  while (off < end) {
    let idr: { id: number; bytes: number };
    try { idr = readId(buf, off); } catch { break; }
    let szr: VintRead;
    try { szr = readSize(buf, off + idr.bytes); } catch { break; }
    const childData = off + idr.bytes + szr.bytes;
    const childSize = szr.isUnknown ? 0 : Number(szr.value);
    if (idr.id === ID.Timecode) {
      let tc = 0n;
      for (let i = 0; i < childSize; i++) tc = (tc << 8n) | BigInt(buf[childData + i]);
      return tc;
    }
    off = childData + childSize;
  }
  return 0n;
}

/** Find the first video TrackNumber in a Tracks element. Returns 1 if none found. */
function findFirstVideoTrack(buf: Uint8Array, dataOff: number, dataSize: number): number {
  const end = dataOff + dataSize;
  let off = dataOff;
  while (off < end) {
    let idr: { id: number; bytes: number };
    try { idr = readId(buf, off); } catch { break; }
    let szr: VintRead;
    try { szr = readSize(buf, off + idr.bytes); } catch { break; }
    const childData = off + idr.bytes + szr.bytes;
    const childSize = Number(szr.value);
    if (idr.id === ID.TrackEntry) {
      // Walk this entry for TrackNumber + TrackType
      let tNum = 0, tType = 0;
      let inOff = childData;
      const inEnd = childData + childSize;
      while (inOff < inEnd) {
        let inIdr: { id: number; bytes: number };
        try { inIdr = readId(buf, inOff); } catch { break; }
        let inSzr: VintRead;
        try { inSzr = readSize(buf, inOff + inIdr.bytes); } catch { break; }
        const v = inOff + inIdr.bytes + inSzr.bytes;
        const s = Number(inSzr.value);
        if (inIdr.id === ID.TrackNumber) {
          let n = 0; for (let i = 0; i < s; i++) n = (n << 8) | buf[v + i]; tNum = n;
        } else if (inIdr.id === ID.TrackType) {
          let n = 0; for (let i = 0; i < s; i++) n = (n << 8) | buf[v + i]; tType = n;
        }
        inOff = v + s;
      }
      if (tType === TRACK_TYPE_VIDEO && tNum > 0) return tNum;
    }
    off = childData + childSize;
  }
  return 1;
}

// ─── Public: rewrite WebM with Cues ───────────────────────────────────

/**
 * Rewrite a WebM Blob to include a Cues element + SeekHead. Returns a new
 * Blob. If the input is malformed or already has Cues, returns null (caller
 * should fall back to the original).
 */
export async function injectWebmCues(input: Blob): Promise<Blob | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await input.arrayBuffer());
  } catch { return null; }

  let parsed: ParsedSegment;
  try { parsed = parseTopLevel(bytes); } catch { return null; }

  // Already has Cues? Don't double-write.
  if (parsed.children.some(c => c.id === ID.Cues)) return null;

  const tracksChild = parsed.children.find(c => c.id === ID.Tracks);
  if (!tracksChild) return null;
  const trackNumber = findFirstVideoTrack(bytes, tracksChild.dataOff, tracksChild.dataSize);

  const clusters = parsed.children.filter(c => c.id === ID.Cluster);
  if (clusters.length === 0) return null;

  // Compute SeekHead size first using fixed-width 8-byte SeekPosition values.
  // Three Seek entries: Info, Tracks, Cues.
  // We don't yet know Cues_pos until we know SeekHead_total_size, but using
  // fixed-width positions makes SeekHead_total_size constant (independent of
  // value), so the dependency is breakable in one pass.

  // Build Seek entries with fixed 8-byte SeekPosition encodings so SeekHead's
  // total size is constant regardless of position values. Lets us size the
  // SeekHead before we know Cues_pos (which depends on SeekHead's size).
  const seekEntryBytes = (idValue: number, pos: bigint): number[] => {
    const body: number[] = [];
    for (const b of idElement(ID.SeekID, idValue)) body.push(b);
    const posBody: number[] = [];
    for (let i = 7; i >= 0; i--) posBody.push(Number((pos >> BigInt(i * 8)) & 0xFFn));
    for (const b of elementBytes(ID.SeekPosition, posBody)) body.push(b);
    return elementBytes(ID.Seek, body);
  };

  const seekEntrySize = seekEntryBytes(ID.Info, 0n).length;

  const seekHeadBodySize = 3 * seekEntrySize;
  const seekHeadIdLen = 4;
  const seekHeadSizeVintLen = vintLenFor(BigInt(seekHeadBodySize));
  const seekHeadTotalSize = seekHeadIdLen + seekHeadSizeVintLen + seekHeadBodySize;

  // Compute new positions of Info, Tracks, Cues relative to Segment data start.
  // Order: SeekHead, [original Segment children copied verbatim except we drop
  //   any preexisting SeekHead/Cues], then Cues at the end.
  // For simplicity: keep original Info, Tracks, Clusters in their original
  //   relative order; drop preexisting SeekHead.
  const keptChildren = parsed.children.filter(c => c.id !== ID.SeekHead && c.id !== ID.Void);
  // We require Info before Tracks before Clusters by spec; MediaRecorder honors this.

  let cursor = seekHeadTotalSize;
  let infoPos = -1, tracksPos = -1;
  const clusterNewPositions: bigint[] = [];
  for (const c of keptChildren) {
    if (c.id === ID.Info) infoPos = cursor;
    else if (c.id === ID.Tracks) tracksPos = cursor;
    else if (c.id === ID.Cluster) clusterNewPositions.push(BigInt(cursor));
    cursor += c.totalSize;
  }
  const cuesPos = cursor;

  // Build Cues (one CuePoint per Cluster).
  const cuesBody: number[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    const tc = readClusterTimecode(bytes, cl.dataOff, cl.dataSize);
    // CuePoint: { CueTime, CueTrackPositions{ CueTrack, CueClusterPosition } }
    const ctp: number[] = [];
    for (const b of uintElement(ID.CueTrack, BigInt(trackNumber))) ctp.push(b);
    for (const b of uintElement(ID.CueClusterPosition, clusterNewPositions[i])) ctp.push(b);
    const cp: number[] = [];
    for (const b of uintElement(ID.CueTime, tc)) cp.push(b);
    for (const b of elementBytes(ID.CueTrackPositions, ctp)) cp.push(b);
    for (const b of elementBytes(ID.CuePoint, cp)) cuesBody.push(b);
  }
  const cuesElement = elementBytes(ID.Cues, cuesBody);

  // Build SeekHead with real positions now that they're known.
  if (infoPos < 0 || tracksPos < 0) return null;
  const shBody: number[] = [];
  for (const b of seekEntryBytes(ID.Info,   BigInt(infoPos))) shBody.push(b);
  for (const b of seekEntryBytes(ID.Tracks, BigInt(tracksPos))) shBody.push(b);
  for (const b of seekEntryBytes(ID.Cues,   BigInt(cuesPos))) shBody.push(b);
  const seekHeadElement = elementBytes(ID.SeekHead, shBody);
  if (seekHeadElement.length !== seekHeadTotalSize) {
    // Sanity: our size pre-calc must match.
    return null;
  }

  // Compute new Segment data length and assemble.
  let segDataLen = seekHeadTotalSize;
  for (const c of keptChildren) segDataLen += c.totalSize;
  segDataLen += cuesElement.length;

  // Assemble final file as a flat ArrayBuffer (avoids SharedArrayBuffer
  // typing pitfalls when passing Uint8Array views directly to Blob).
  let totalLen = parsed.ebmlHeaderBytes.length;
  // Segment header: ID + 8-byte size VINT.
  const segHeader: number[] = [];
  writeId(ID.Segment, segHeader);
  writeVintFixed(BigInt(segDataLen), 8, segHeader);
  totalLen += segHeader.length;
  totalLen += seekHeadElement.length;
  for (const c of keptChildren) totalLen += c.totalSize;
  totalLen += cuesElement.length;

  const out = new Uint8Array(totalLen);
  let p = 0;
  out.set(parsed.ebmlHeaderBytes, p); p += parsed.ebmlHeaderBytes.length;
  out.set(segHeader, p); p += segHeader.length;
  out.set(seekHeadElement, p); p += seekHeadElement.length;
  for (const c of keptChildren) {
    out.set(bytes.subarray(c.headerOff, c.headerOff + c.totalSize), p);
    p += c.totalSize;
  }
  out.set(cuesElement, p); p += cuesElement.length;

  return new Blob([out.buffer], { type: input.type || "video/webm" });
}
