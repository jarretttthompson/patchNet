/**
 * src/platform/audio.ts
 *
 * AudioBackend interface — the contract every audio implementation must satisfy.
 *
 * Two implementations:
 *   - BrowserAudioBackend  (src/runtime/AudioGraph.ts)  — Web Audio API, ~10–20ms latency
 *   - NativeAudioBackend   (src-tauri/src/audio/)       — CPAL via Tauri IPC, ~1–3ms latency
 *
 * All code outside src/runtime/ and src-tauri/ talks to this interface only.
 * The active backend is returned by getAudioBackend() in src/platform/registry.ts.
 *
 * Keep this interface minimal. Add methods here only when a caller outside
 * src/runtime/ genuinely needs them. Internal AudioGraph helpers stay internal.
 */

import type { PatchGraph } from "../graph/PatchGraph";

export interface AudioBackend {
  /**
   * Start the audio engine. Must be called from a user gesture.
   * Resolves when the engine is running and ready to process audio.
   */
  start(): Promise<void>;

  /**
   * Stop the audio engine and release all hardware resources.
   */
  stop(): Promise<void>;

  /**
   * Whether the engine is currently running.
   */
  readonly isStarted: boolean;

  /**
   * Current sample rate in Hz.
   * Available after start() resolves.
   */
  readonly sampleRate: number;

  /**
   * Approximate round-trip latency in milliseconds.
   * Browser: ~10–20ms. Native: ~1–3ms.
   * Used for display in the Audio Status panel.
   */
  readonly latencyMs: number;

  /**
   * Sync the audio graph with the current patch state.
   * Called automatically on every graph "change" event.
   * Idempotent — safe to call frequently.
   */
  sync(graph: PatchGraph): void;

  /**
   * Tear down all audio nodes and release all resources.
   * Called when the app unloads or a scratch tab is closed.
   */
  destroy(): void;
}

/**
 * Capability flags — checked at object registration time to decide which
 * objects are available on the current platform.
 *
 * Add new capabilities here as native-only objects are introduced.
 */
export interface AudioCapabilities {
  /** Sub-5ms hardware I/O latency. Native only. */
  lowLatencyIO: boolean;

  /** MIDI device access. Native only (browser Web MIDI API excluded by design). */
  midiIO: boolean;

  /** More than 2 audio output channels via a pro audio interface. */
  multiChannelProIO: boolean;

  /** Ability to spawn a sidecar native process (mDNS discovery etc). */
  nativeSidecar: boolean;
}

export function getAudioCapabilities(native: boolean): AudioCapabilities {
  return {
    lowLatencyIO:      native,
    midiIO:            native,
    multiChannelProIO: native,
    nativeSidecar:     native,
  };
}
