import type { PatchGraph } from "../graph/PatchGraph";
import type { AudioBackend } from "../platform/audio";

/**
 * Native (Tauri / CPAL) implementation of `AudioBackend`.
 *
 * **Skeleton today (M3/c).** All methods are non-throwing no-ops so the
 * rest of the app boots cleanly on native without real audio. Users see
 * the patch render, controllers receive a `null` audio graph (via the
 * registry), and the Audio Status panel reports zeros across the board.
 *
 * The real CPAL implementation lands in **M3/f** — see
 * `docs/audio-backend.md §8` for the planned IPC commands
 * (`audio_start`, `audio_stop`, `audio_sync_graph`, `audio_meter_levels`)
 * and Rust dependencies (`cpal`, `cpal-jack`).
 *
 * Per the M3/c contract (`docs/audio-backend.md §7.2`):
 *   - `start()` flips `_started: true` and logs a one-time stub notice.
 *   - `sync()` is a no-op.
 *   - `latencyMs` / `sampleRate` are `0` before start; placeholders
 *      (`48000` / `0`) after start so the UI shows *something*.
 *   - Nothing throws — calling any method on native is harmless.
 */
export class NativeAudioBackend implements AudioBackend {
  private _started = false;
  private _loggedStub = false;

  // graph captured at construction so M3/f can serialize+invoke without a
  // signature change. Today's no-op sync() ignores it.
  constructor(_graph: PatchGraph) {
    // Intentionally empty. Tauri IPC channels and CPAL stream handle are
    // initialized in start() once M3/f ships.
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    if (!this._loggedStub) {
      console.info(
        "[NativeAudioBackend] start() — stub. Real CPAL audio lands in " +
          "M3/f. See docs/audio-backend.md §8.",
      );
      this._loggedStub = true;
    }
    // M3/f will: await invoke("audio_start", { sampleRate, bufferSize });
  }

  async stop(): Promise<void> {
    this._started = false;
    // M3/f will: await invoke("audio_stop");
  }

  get isStarted(): boolean {
    return this._started;
  }

  get sampleRate(): number {
    // M3/f will report the real rate from the CPAL stream. The placeholder
    // 48 kHz lets the Audio Status panel render a number that won't confuse
    // users in a debugging session.
    return this._started ? 48000 : 0;
  }

  get latencyMs(): number {
    // Real CPAL latency reporting waits for M3/f. Returning 0 makes the
    // Status panel show "—" rather than a misleading number.
    return 0;
  }

  sync(_graph: PatchGraph): void {
    // M3/f will: invoke("audio_sync_graph", { nodes, edges, args })
    // with a serialized subset of audio-relevant nodes.
  }

  destroy(): void {
    this._started = false;
    // M3/f will: release the CPAL stream handle here.
  }
}
