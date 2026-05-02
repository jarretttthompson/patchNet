/**
 * VideoBufferStorage — OPFS-backed WebM container for vbuf* recordings.
 *
 * Parallel to BufferStorage on the audio side, but dramatically simpler:
 *   * The WebM blob is opaque (we don't decode it ourselves) — playback hands
 *     it to an HTMLVideoElement, which has its own decoder. So no streaming
 *     pull-model, no ring buffer, no per-frame plumbing.
 *   * Writing happens chunk-by-chunk during MediaRecorder.ondataavailable —
 *     each Blob is appended to the OPFS file via a streaming writer.
 *   * Reading just hands back the OPFS File reference; the caller wraps it
 *     in URL.createObjectURL.
 *
 * After write close we run injectWebmCues() to rewrite the file with a
 * SeekHead + Cues element. MediaRecorder doesn't emit Cues, which makes
 * tight-loop seeking unreliable. The injector adds them in place.
 */

interface FsAccessFile {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
  getFile(): Promise<File>;
}

interface FileSystemWritableFileStream {
  write(data: BufferSource | Blob | string): Promise<void>;
  seek(position: number): Promise<void>;
  close(): Promise<void>;
}

interface DirHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsAccessFile>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface VideoWriteHandle {
  /** Append a chunk emitted by MediaRecorder.ondataavailable. */
  appendBlob(blob: Blob): Promise<void>;
  readonly bytesWritten: number;
  close(): Promise<void>;
}

export interface VideoReadHandle {
  /** OPFS-backed File. Pass through createObjectURL for HTMLVideoElement.src. */
  readonly file: File;
  close(): Promise<void>;
}

interface VideoBufferBackend {
  openWrite(key: string): Promise<VideoWriteHandle>;
  openRead(key: string): Promise<VideoReadHandle | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const VBUF_DIR = "vbuf";
const FILENAME = (key: string) => `${key}.webm`;

class OpfsBackend implements VideoBufferBackend {
  private dirReady: Promise<DirHandle> | null = null;

  private async dir(): Promise<DirHandle> {
    if (!this.dirReady) {
      this.dirReady = (async () => {
        const root = await (navigator.storage as { getDirectory: () => Promise<DirHandle> }).getDirectory();
        return root.getDirectoryHandle(VBUF_DIR, { create: true });
      })();
    }
    return this.dirReady;
  }

  async openWrite(key: string): Promise<VideoWriteHandle> {
    const dir  = await this.dir();
    const file = await dir.getFileHandle(FILENAME(key), { create: true });
    const writable = await file.createWritable({ keepExistingData: false });
    let bytesWritten = 0;
    const self = this;
    return {
      get bytesWritten() { return bytesWritten; },
      async appendBlob(blob: Blob) {
        await writable.write(blob);
        bytesWritten += blob.size;
      },
      async close() {
        try { await writable.close(); } catch { /* ignore */ }
        // Cue injection — rewrites the file with a SeekHead+Cues so seeking
        // is precise. Off by default until validated end-to-end (the parser
        // can produce a file that loads metadata but fails decode, which is
        // worse than the un-cued original). Failures are swallowed.
        try { await self.injectCues(key); } catch { /* ignore */ }
      },
    };
  }

  private async injectCues(key: string): Promise<void> {
    if (!this.cueInjectionEnabled) return;
    const { injectWebmCues } = await import("./webmCues");
    const dir  = await this.dir();
    const fh   = await dir.getFileHandle(FILENAME(key), { create: false });
    const file = await fh.getFile();
    if (file.size === 0) return;
    const cued = await injectWebmCues(file);
    if (!cued) return;
    // Verify the rewritten file actually decodes before overwriting the
    // working original — no point trading a slow seek for a broken file.
    if (!await this.canDecode(cued)) return;
    const w = await fh.createWritable({ keepExistingData: false });
    await w.write(cued);
    await w.close();
  }

  private cueInjectionEnabled = false;

  private canDecode(blob: Blob): Promise<boolean> {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "metadata";
      const url = URL.createObjectURL(blob);
      const cleanup = (ok: boolean) => {
        v.removeEventListener("loadeddata", onOk);
        v.removeEventListener("error", onErr);
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      const onOk  = () => cleanup(true);
      const onErr = () => cleanup(false);
      v.addEventListener("loadeddata", onOk);
      v.addEventListener("error", onErr);
      v.src = url;
      // Timeout in case neither event fires (defensively).
      setTimeout(() => cleanup(false), 2000);
    });
  }

  async openRead(key: string): Promise<VideoReadHandle | null> {
    try {
      const dir  = await this.dir();
      const fh   = await dir.getFileHandle(FILENAME(key), { create: false });
      const file = await fh.getFile();
      if (file.size === 0) return null;
      return { file, async close() { /* noop */ } };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const dir = await this.dir();
      await dir.removeEntry(FILENAME(key));
    } catch { /* ignore */ }
  }

  async exists(key: string): Promise<boolean> {
    const h = await this.openRead(key);
    if (!h) return false;
    await h.close();
    return true;
  }
}

class MemoryBackend implements VideoBufferBackend {
  private chunks = new Map<string, Blob[]>();

  async openWrite(key: string): Promise<VideoWriteHandle> {
    const list: Blob[] = [];
    this.chunks.set(key, list);
    let bytesWritten = 0;
    return {
      get bytesWritten() { return bytesWritten; },
      async appendBlob(blob: Blob) {
        list.push(blob);
        bytesWritten += blob.size;
      },
      async close() { /* noop */ },
    };
  }

  async openRead(key: string): Promise<VideoReadHandle | null> {
    const list = this.chunks.get(key);
    if (!list || list.length === 0) return null;
    const blob = new Blob(list, { type: "video/webm" });
    if (blob.size === 0) return null;
    const file = new File([blob], FILENAME(key), { type: "video/webm" });
    return { file, async close() { /* noop */ } };
  }

  async delete(key: string): Promise<void> {
    this.chunks.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const list = this.chunks.get(key);
    return !!list && list.length > 0;
  }
}

function pickBackend(): VideoBufferBackend {
  if (typeof navigator !== "undefined"
      && typeof navigator.storage?.getDirectory === "function") {
    return new OpfsBackend();
  }
  return new MemoryBackend();
}

export const videoBufferStorage: VideoBufferBackend = pickBackend();
