// OPFS-backed streaming PCM storage for buffer~.
//
// File layout per buffer node (one OPFS file each):
//
//   <key>.pnb    — PCM, interleaved frame format (PNB2). Header is fixed-size,
//                  body grows append-only as record samples flow in.
//   <key>.peaks  — Min/max waveform summary (PNK1). Written once on record
//                  done; read for waveform drawing without touching the PCM.
//
// PNB2 (streaming PCM):
//   magic           [4]  "PNB2"
//   mode            [1]  'S' (stereo) | 'M' (mono)
//   hasStereoBackup [1]  0 | 1 — when 1, frames are 16 bytes (L,R,LStereo,RStereo)
//                        so a mono mix preserves the original stereo for restore.
//   reserved        [2]  0x00 0x00
//   <interleaved frames follow>
//     hasStereoBackup=0: 8 bytes/frame  (L float32, R float32)
//     hasStereoBackup=1: 16 bytes/frame (L, R, LStereo, RStereo float32)
//
//   Frame count = (fileSize - HEADER_SIZE) / frameBytes.
//
// PNK1 (peaks summary):
//   magic            [4]  "PNK1"
//   bucketCount      [4]  u32 LE — number of peak buckets
//   samplesPerBucket [4]  u32 LE
//   reserved         [4]  0x0
//   data             [bucketCount × 2 × float32]  min, max for L channel.
//
// Legacy PNB1 (non-streaming, L-then-R block layout) is read for backward
// compatibility with patches saved during Phase 2; new writes always use PNB2.

const PNB2_MAGIC = "PNB2";
const PNB1_MAGIC = "PNB1";
const PNB_HEADER_SIZE = 8;

const PEAKS_MAGIC = "PNK1";
const PEAKS_HEADER_SIZE = 16;
/** Default peaks resolution. Independent of recording length so a 60-min
 *  buffer and a 5-sec buffer both render at constant cost. */
export const PEAKS_DEFAULT_BUCKETS = 1024;

const FOLDER_NAME = "patchnet-buffers";

export type BufferMode = "stereo" | "mono";

export interface PeaksData {
  bucketCount: number;
  samplesPerBucket: number;
  /** Interleaved [min, max, min, max, ...] for the L channel. */
  values: Float32Array;
}

export interface StoredBuffer {
  mode: BufferMode;
  L: Float32Array;
  R: Float32Array;
  LStereo: Float32Array;
  RStereo: Float32Array;
}

// ── Header helpers ──────────────────────────────────────────────────────────

function writeMagic(view: DataView, offset: number, magic: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, magic.charCodeAt(i));
}

function readMagic(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function buildPnb2Header(mode: BufferMode, hasStereoBackup: boolean): ArrayBuffer {
  const buf = new ArrayBuffer(PNB_HEADER_SIZE);
  const view = new DataView(buf);
  writeMagic(view, 0, PNB2_MAGIC);
  view.setUint8(4, mode === "mono" ? 0x4D : 0x53);
  view.setUint8(5, hasStereoBackup ? 1 : 0);
  view.setUint16(6, 0, true);
  return buf;
}

function frameBytes(hasStereoBackup: boolean): number {
  return hasStereoBackup ? 16 : 8;
}

// ── PCM streaming write handle ──────────────────────────────────────────────

export interface PcmWriteHandle {
  /** Append `frameCount` interleaved frames. Sample arrays must be the same
   *  length and follow the layout determined at creation (L,R or L,R,Ls,Rs). */
  appendFrames(L: Float32Array, R: Float32Array, LStereo?: Float32Array, RStereo?: Float32Array): Promise<void>;
  /** Persist + close. Subsequent reads see the full file. */
  close(): Promise<void>;
  /** Discard pending bytes if any and abandon the file. */
  abort(): Promise<void>;
}

// ── PCM streaming read handle ───────────────────────────────────────────────

export interface PcmReadHandle {
  readonly mode: BufferMode;
  readonly hasStereoBackup: boolean;
  readonly frameCount: number;
  /** Read `count` frames starting at absolute frame `offset`. Returns L+R
   *  Float32Arrays; LStereo/RStereo only populated for hasStereoBackup files. */
  readFrames(offset: number, count: number): Promise<{
    L: Float32Array;
    R: Float32Array;
    LStereo: Float32Array;
    RStereo: Float32Array;
  }>;
  close(): Promise<void>;
}

// ── Backend interface ──────────────────────────────────────────────────────

interface StorageBackend {
  /** Streaming write: open append-only, callee writes header on creation. */
  openWrite(key: string, mode: BufferMode, hasStereoBackup: boolean): Promise<PcmWriteHandle>;
  openRead(key: string): Promise<PcmReadHandle | null>;
  delete(key: string): Promise<void>;
  /** One-shot legacy reader — decodes PNB1 OR PNB2 fully into memory. Used
   *  on patch load when the caller wants the whole take at once (e.g. for
   *  mode-switch transformations). Prefer openRead for play streaming. */
  readAll(key: string): Promise<StoredBuffer | null>;
  /** One-shot legacy writer — encodes the whole take in one go. Used by
   *  loadBuffers (legacy migration path) when we already have the full PCM. */
  writeAll(key: string, payload: StoredBuffer): Promise<void>;
  /** Peaks sidecar. */
  writePeaks(key: string, peaks: PeaksData): Promise<void>;
  readPeaks(key: string): Promise<PeaksData | null>;
}

// ── OPFS backend ────────────────────────────────────────────────────────────

class OpfsBackend implements StorageBackend {
  private dirPromise: Promise<FileSystemDirectoryHandle> | null = null;

  private getDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.dirPromise) {
      this.dirPromise = navigator.storage.getDirectory().then(root =>
        root.getDirectoryHandle(FOLDER_NAME, { create: true }),
      );
    }
    return this.dirPromise;
  }

  async openWrite(key: string, mode: BufferMode, hasStereoBackup: boolean): Promise<PcmWriteHandle> {
    const dir  = await this.getDir();
    const file = await dir.getFileHandle(`${key}.pnb`, { create: true });
    const ws   = await file.createWritable();
    await ws.write(buildPnb2Header(mode, hasStereoBackup));
    const fb = frameBytes(hasStereoBackup);
    let aborted = false;
    return {
      async appendFrames(L: Float32Array, R: Float32Array, LStereo?: Float32Array, RStereo?: Float32Array) {
        if (aborted) return;
        const n = L.length;
        if (R.length !== n) throw new Error("buffer~: L/R chunk length mismatch");
        if (hasStereoBackup) {
          if (!LStereo || !RStereo || LStereo.length !== n || RStereo.length !== n) {
            throw new Error("buffer~: hasStereoBackup but missing or mismatched LStereo/RStereo");
          }
        }
        const out = new Float32Array(n * (fb / 4));
        if (hasStereoBackup) {
          for (let i = 0; i < n; i++) {
            const o = i * 4;
            out[o    ] = L[i];
            out[o + 1] = R[i];
            out[o + 2] = LStereo![i];
            out[o + 3] = RStereo![i];
          }
        } else {
          for (let i = 0; i < n; i++) {
            const o = i * 2;
            out[o    ] = L[i];
            out[o + 1] = R[i];
          }
        }
        await ws.write(out.buffer);
      },
      async close() {
        if (!aborted) await ws.close();
      },
      async abort() {
        aborted = true;
        try { await ws.abort(); } catch { /* ignore */ }
      },
    };
  }

  async openRead(key: string): Promise<PcmReadHandle | null> {
    try {
      const dir = await this.getDir();
      const fh  = await dir.getFileHandle(`${key}.pnb`);
      const file = await fh.getFile();
      // Read just the header to determine layout.
      const headerBuf = await file.slice(0, PNB_HEADER_SIZE).arrayBuffer();
      const headerView = new DataView(headerBuf);
      const magic = readMagic(headerView, 0);
      if (magic === PNB2_MAGIC) {
        const mode: BufferMode = headerView.getUint8(4) === 0x4D ? "mono" : "stereo";
        const hasStereoBackup = headerView.getUint8(5) === 1;
        const fb = frameBytes(hasStereoBackup);
        const frameCount = Math.floor((file.size - PNB_HEADER_SIZE) / fb);
        return {
          mode,
          hasStereoBackup,
          frameCount,
          async readFrames(offset: number, count: number) {
            const start = PNB_HEADER_SIZE + offset * fb;
            const end   = Math.min(file.size, start + count * fb);
            if (end <= start) return {
              L: new Float32Array(0), R: new Float32Array(0),
              LStereo: new Float32Array(0), RStereo: new Float32Array(0),
            };
            const buf = await file.slice(start, end).arrayBuffer();
            const realCount = (end - start) / fb;
            const f32 = new Float32Array(buf);
            const L = new Float32Array(realCount);
            const R = new Float32Array(realCount);
            const LStereo = hasStereoBackup ? new Float32Array(realCount) : new Float32Array(0);
            const RStereo = hasStereoBackup ? new Float32Array(realCount) : new Float32Array(0);
            if (hasStereoBackup) {
              for (let i = 0; i < realCount; i++) {
                const o = i * 4;
                L[i]       = f32[o];
                R[i]       = f32[o + 1];
                LStereo[i] = f32[o + 2];
                RStereo[i] = f32[o + 3];
              }
            } else {
              for (let i = 0; i < realCount; i++) {
                const o = i * 2;
                L[i] = f32[o];
                R[i] = f32[o + 1];
              }
            }
            return { L, R, LStereo, RStereo };
          },
          async close() { /* nothing to close — File is GC'd */ },
        };
      }
      // PNB1 fallback: legacy non-streaming reader. Decode the whole file
      // into a synthetic frame-based ReadHandle. Costs RAM proportional to
      // the file size; only happens when migrating Phase-2 patches.
      if (magic === PNB1_MAGIC) {
        const stored = await this.readAll(key);
        if (!stored) return null;
        const frameCount = stored.L.length;
        const hasStereoBackup = stored.LStereo.length > 0;
        return {
          mode: stored.mode,
          hasStereoBackup,
          frameCount,
          async readFrames(offset: number, count: number) {
            const lo = Math.max(0, offset);
            const hi = Math.min(frameCount, offset + count);
            if (hi <= lo) return {
              L: new Float32Array(0), R: new Float32Array(0),
              LStereo: new Float32Array(0), RStereo: new Float32Array(0),
            };
            return {
              L: stored.L.slice(lo, hi),
              R: stored.R.slice(lo, hi),
              LStereo: hasStereoBackup ? stored.LStereo.slice(lo, hi) : new Float32Array(0),
              RStereo: hasStereoBackup ? stored.RStereo.slice(lo, hi) : new Float32Array(0),
            };
          },
          async close() { /* noop */ },
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const dir = await this.getDir();
      await dir.removeEntry(`${key}.pnb`);
    } catch { /* ignore */ }
    try {
      const dir = await this.getDir();
      await dir.removeEntry(`${key}.peaks`);
    } catch { /* ignore */ }
  }

  async readAll(key: string): Promise<StoredBuffer | null> {
    try {
      const dir  = await this.getDir();
      const fh   = await dir.getFileHandle(`${key}.pnb`);
      const file = await fh.getFile();
      const buf  = await file.arrayBuffer();
      return decodeAny(buf);
    } catch {
      return null;
    }
  }

  async writeAll(key: string, payload: StoredBuffer): Promise<void> {
    const hasStereoBackup = payload.LStereo.length > 0 || payload.RStereo.length > 0;
    const handle = await this.openWrite(key, payload.mode, hasStereoBackup);
    try {
      await handle.appendFrames(
        payload.L, payload.R,
        hasStereoBackup ? payload.LStereo : undefined,
        hasStereoBackup ? payload.RStereo : undefined,
      );
    } finally {
      await handle.close();
    }
  }

  async writePeaks(key: string, peaks: PeaksData): Promise<void> {
    const dir = await this.getDir();
    const fh  = await dir.getFileHandle(`${key}.peaks`, { create: true });
    const ws  = await fh.createWritable();
    const total = PEAKS_HEADER_SIZE + peaks.values.byteLength;
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    writeMagic(view, 0, PEAKS_MAGIC);
    view.setUint32(4,  peaks.bucketCount,      true);
    view.setUint32(8,  peaks.samplesPerBucket, true);
    view.setUint32(12, 0, true);
    new Float32Array(buf, PEAKS_HEADER_SIZE).set(peaks.values);
    await ws.write(buf);
    await ws.close();
  }

  async readPeaks(key: string): Promise<PeaksData | null> {
    try {
      const dir  = await this.getDir();
      const fh   = await dir.getFileHandle(`${key}.peaks`);
      const file = await fh.getFile();
      const buf  = await file.arrayBuffer();
      const view = new DataView(buf);
      if (readMagic(view, 0) !== PEAKS_MAGIC) return null;
      const bucketCount      = view.getUint32(4,  true);
      const samplesPerBucket = view.getUint32(8,  true);
      const values = new Float32Array(buf, PEAKS_HEADER_SIZE, bucketCount * 2);
      // Copy out so the underlying ArrayBuffer can be GC'd.
      return { bucketCount, samplesPerBucket, values: new Float32Array(values) };
    } catch {
      return null;
    }
  }
}

// ── In-memory fallback ──────────────────────────────────────────────────────

class MemoryBackend implements StorageBackend {
  private readonly pcm    = new Map<string, ArrayBuffer>();
  private readonly peaks  = new Map<string, PeaksData>();

  async openWrite(key: string, mode: BufferMode, hasStereoBackup: boolean): Promise<PcmWriteHandle> {
    const fb = frameBytes(hasStereoBackup);
    const chunks: ArrayBuffer[] = [buildPnb2Header(mode, hasStereoBackup)];
    let aborted = false;
    return {
      async appendFrames(L, R, LStereo?, RStereo?) {
        if (aborted) return;
        const n = L.length;
        const out = new Float32Array(n * (fb / 4));
        if (hasStereoBackup) {
          for (let i = 0; i < n; i++) {
            const o = i * 4;
            out[o    ] = L[i];
            out[o + 1] = R[i];
            out[o + 2] = LStereo![i];
            out[o + 3] = RStereo![i];
          }
        } else {
          for (let i = 0; i < n; i++) {
            const o = i * 2;
            out[o    ] = L[i];
            out[o + 1] = R[i];
          }
        }
        chunks.push(out.buffer);
      },
      close: async () => {
        if (aborted) return;
        let total = 0;
        for (const c of chunks) total += c.byteLength;
        const merged = new Uint8Array(total);
        let p = 0;
        for (const c of chunks) {
          merged.set(new Uint8Array(c), p);
          p += c.byteLength;
        }
        this.pcm.set(key, merged.buffer);
      },
      async abort() { aborted = true; },
    };
  }

  async openRead(key: string): Promise<PcmReadHandle | null> {
    const buf = this.pcm.get(key);
    if (!buf) return null;
    const view = new DataView(buf);
    const magic = readMagic(view, 0);
    if (magic !== PNB2_MAGIC) {
      // Decode legacy PNB1 fully.
      const stored = decodeAny(buf);
      if (!stored) return null;
      const frameCount = stored.L.length;
      const hasStereoBackup = stored.LStereo.length > 0;
      return {
        mode: stored.mode, hasStereoBackup, frameCount,
        async readFrames(offset, count) {
          const lo = Math.max(0, offset);
          const hi = Math.min(frameCount, offset + count);
          if (hi <= lo) return {
            L: new Float32Array(0), R: new Float32Array(0),
            LStereo: new Float32Array(0), RStereo: new Float32Array(0),
          };
          return {
            L: stored.L.slice(lo, hi),
            R: stored.R.slice(lo, hi),
            LStereo: hasStereoBackup ? stored.LStereo.slice(lo, hi) : new Float32Array(0),
            RStereo: hasStereoBackup ? stored.RStereo.slice(lo, hi) : new Float32Array(0),
          };
        },
        async close() { /* noop */ },
      };
    }
    const mode: BufferMode = view.getUint8(4) === 0x4D ? "mono" : "stereo";
    const hasStereoBackup = view.getUint8(5) === 1;
    const fb = frameBytes(hasStereoBackup);
    const frameCount = Math.floor((buf.byteLength - PNB_HEADER_SIZE) / fb);
    return {
      mode, hasStereoBackup, frameCount,
      async readFrames(offset, count) {
        const lo = Math.max(0, offset);
        const hi = Math.min(frameCount, offset + count);
        if (hi <= lo) return {
          L: new Float32Array(0), R: new Float32Array(0),
          LStereo: new Float32Array(0), RStereo: new Float32Array(0),
        };
        const f32 = new Float32Array(buf, PNB_HEADER_SIZE + lo * fb, (hi - lo) * (fb / 4));
        const realCount = hi - lo;
        const L = new Float32Array(realCount);
        const R = new Float32Array(realCount);
        const LStereo = hasStereoBackup ? new Float32Array(realCount) : new Float32Array(0);
        const RStereo = hasStereoBackup ? new Float32Array(realCount) : new Float32Array(0);
        if (hasStereoBackup) {
          for (let i = 0; i < realCount; i++) {
            const o = i * 4;
            L[i] = f32[o]; R[i] = f32[o + 1];
            LStereo[i] = f32[o + 2]; RStereo[i] = f32[o + 3];
          }
        } else {
          for (let i = 0; i < realCount; i++) {
            const o = i * 2;
            L[i] = f32[o]; R[i] = f32[o + 1];
          }
        }
        return { L, R, LStereo, RStereo };
      },
      async close() { /* noop */ },
    };
  }

  async delete(key: string): Promise<void> {
    this.pcm.delete(key);
    this.peaks.delete(key);
  }

  async readAll(key: string): Promise<StoredBuffer | null> {
    const buf = this.pcm.get(key);
    return buf ? decodeAny(buf) : null;
  }

  async writeAll(key: string, payload: StoredBuffer): Promise<void> {
    const hasStereoBackup = payload.LStereo.length > 0 || payload.RStereo.length > 0;
    const handle = await this.openWrite(key, payload.mode, hasStereoBackup);
    try {
      await handle.appendFrames(
        payload.L, payload.R,
        hasStereoBackup ? payload.LStereo : undefined,
        hasStereoBackup ? payload.RStereo : undefined,
      );
    } finally {
      await handle.close();
    }
  }

  async writePeaks(key: string, peaks: PeaksData): Promise<void> {
    this.peaks.set(key, {
      bucketCount: peaks.bucketCount,
      samplesPerBucket: peaks.samplesPerBucket,
      values: new Float32Array(peaks.values),
    });
  }

  async readPeaks(key: string): Promise<PeaksData | null> {
    return this.peaks.get(key) ?? null;
  }
}

// ── Decoder for either PNB1 (legacy) or PNB2 ────────────────────────────────

function decodeAny(buf: ArrayBuffer): StoredBuffer | null {
  if (buf.byteLength < 8) return null;
  const view = new DataView(buf);
  const magic = readMagic(view, 0);
  if (magic === PNB2_MAGIC) return decodePnb2(buf);
  if (magic === PNB1_MAGIC) return decodePnb1(buf);
  return null;
}

function decodePnb2(buf: ArrayBuffer): StoredBuffer | null {
  const view = new DataView(buf);
  const mode: BufferMode = view.getUint8(4) === 0x4D ? "mono" : "stereo";
  const hasStereoBackup = view.getUint8(5) === 1;
  const fb = frameBytes(hasStereoBackup);
  const frameCount = Math.floor((buf.byteLength - PNB_HEADER_SIZE) / fb);
  const f32 = new Float32Array(buf, PNB_HEADER_SIZE, frameCount * (fb / 4));
  const L = new Float32Array(frameCount);
  const R = new Float32Array(frameCount);
  const LStereo = hasStereoBackup ? new Float32Array(frameCount) : new Float32Array(0);
  const RStereo = hasStereoBackup ? new Float32Array(frameCount) : new Float32Array(0);
  if (hasStereoBackup) {
    for (let i = 0; i < frameCount; i++) {
      const o = i * 4;
      L[i] = f32[o]; R[i] = f32[o + 1];
      LStereo[i] = f32[o + 2]; RStereo[i] = f32[o + 3];
    }
  } else {
    for (let i = 0; i < frameCount; i++) {
      const o = i * 2;
      L[i] = f32[o]; R[i] = f32[o + 1];
    }
  }
  return { mode, L, R, LStereo, RStereo };
}

function decodePnb1(buf: ArrayBuffer): StoredBuffer | null {
  // Legacy: magic[4] mode[1] hasStereo[1] reserved[2] length[4] L[N×4] R[N×4] [LStereo[N×4] RStereo[N×4]]
  const PNB1_HEADER = 12;
  if (buf.byteLength < PNB1_HEADER) return null;
  const view = new DataView(buf);
  const mode: BufferMode = view.getUint8(4) === 0x4D ? "mono" : "stereo";
  const hasStereoBackup = view.getUint8(5) === 1;
  const len = view.getUint32(8, true);
  const channels = hasStereoBackup ? 4 : 2;
  if (buf.byteLength < PNB1_HEADER + len * 4 * channels) return null;
  const f32 = new Float32Array(buf, PNB1_HEADER, len * channels);
  const out: StoredBuffer = {
    mode,
    L: new Float32Array(len),
    R: new Float32Array(len),
    LStereo: hasStereoBackup ? new Float32Array(len) : new Float32Array(0),
    RStereo: hasStereoBackup ? new Float32Array(len) : new Float32Array(0),
  };
  out.L.set(f32.subarray(0,        len));
  out.R.set(f32.subarray(len,      len * 2));
  if (hasStereoBackup) {
    out.LStereo.set(f32.subarray(len * 2, len * 3));
    out.RStereo.set(f32.subarray(len * 3, len * 4));
  }
  return out;
}

// ── Singleton ───────────────────────────────────────────────────────────────

const backend: StorageBackend =
  typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function"
    ? new OpfsBackend()
    : new MemoryBackend();

export const isOpfsBacked = backend instanceof OpfsBackend;

export const bufferStorage = {
  openWrite:  (key: string, mode: BufferMode, hasStereoBackup: boolean) => backend.openWrite(key, mode, hasStereoBackup),
  openRead:   (key: string) => backend.openRead(key),
  delete:     (key: string) => backend.delete(key),
  readAll:    (key: string) => backend.readAll(key),
  writeAll:   (key: string, payload: StoredBuffer) => backend.writeAll(key, payload),
  writePeaks: (key: string, peaks: PeaksData) => backend.writePeaks(key, peaks),
  readPeaks:  (key: string) => backend.readPeaks(key),
};
