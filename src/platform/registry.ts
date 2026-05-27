import type { PatchGraph } from "../graph/PatchGraph";
import type { SubPatchManager } from "../canvas/SubPatchManager";
import { BrowserAudioBackend } from "../runtime/BrowserAudioBackend";
import { NativeAudioBackend } from "../runtime/NativeAudioBackend";
import type { AudioBackend } from "./audio";
import { isNative } from "./index";

/**
 * Singleton accessor for the active audio backend.
 *
 * Lazy: constructed on first call, reused thereafter. The platform check
 * runs once at first call (`isNative` is itself a build-time constant
 * with a runtime `__TAURI__` override — see `src/platform/index.ts`), so
 * this is effectively a static dispatch.
 *
 * **First call wins.** Subsequent calls return the existing backend and
 * ignore their arguments — the singleton stays bound to the graph it was
 * created with. This matches main.ts's "one app, one graph, one backend"
 * shape. Tests that need a fresh backend should call
 * `_resetAudioBackendForTests()`.
 *
 * See `docs/audio-backend.md §5` for the platform-selection rule.
 */
let backend: AudioBackend | null = null;

export function getAudioBackend(
  graph: PatchGraph,
  subPatchManager?: SubPatchManager,
): AudioBackend {
  if (!backend) {
    backend = isNative
      ? new NativeAudioBackend(graph)
      : new BrowserAudioBackend(graph, subPatchManager);
  }
  return backend;
}

/**
 * Test-only: drop the singleton so the next `getAudioBackend()` call
 * constructs a fresh backend. **Never call this in production code** —
 * it would orphan any controller still holding the previous backend.
 */
export function _resetAudioBackendForTests(): void {
  backend = null;
}
