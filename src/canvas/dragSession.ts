/**
 * Shared drag-session helper for any pointer-driven drag in patchNet
 * (object move, resize, cable draw, sliders, faders, panel drags).
 *
 * The pattern this exists to enforce: every drag MUST have a recovery path
 * for missed mouseup. Browsers swallow mouseup if the user releases the
 * button outside the window (alt-tabbed away, second monitor, system
 * dialog stole focus). Without a recovery hook, the mousemove listener
 * stays attached forever and the dragged thing follows the cursor on
 * subsequent moves — the "stuck to cursor" symptom.
 *
 * `startDragSession` always installs:
 *   - `window` mousemove + mouseup
 *   - `window.blur` → calls `onCancel`
 *   - `Escape` keydown → calls `onCancel`
 *
 * Returns a `DragSession` whose `end()` tears all four down. `end()` is
 * idempotent and is called automatically after `onUp`/`onCancel`, but it's
 * also safe to call manually (e.g. if the call site decides to bail early).
 *
 * Use `window` (not `document`): pairs naturally with `window.blur`, slightly
 * more reliable for events that fire above the document tree, and matches
 * the convention `DragController` already uses.
 */

export interface DragSessionHandlers {
  /** Called on every `window.mousemove` while the session is live. */
  onMove: (e: MouseEvent) => void;
  /** Called on `window.mouseup`. The session auto-ends after this returns. */
  onUp: (e: MouseEvent) => void;
  /**
   * Called when the drag must end without a real mouseup (window blur,
   * Escape pressed). The session auto-ends after this returns.
   *
   * If omitted, blur/Escape will simply tear down listeners without
   * notifying the caller — fine for drags whose state is already
   * committed live (e.g. mixer fader values committed on input).
   */
  onCancel?: () => void;
}

export interface DragSession {
  /** Tear down the session's listeners. Idempotent. Safe to call from
   *  inside `onUp`/`onCancel` or from external code. */
  end(): void;
}

export function startDragSession(h: DragSessionHandlers): DragSession {
  let ended = false;

  const teardown = () => {
    if (ended) return;
    ended = true;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("keydown", onKey);
  };

  const onMove = (e: MouseEvent) => {
    if (ended) return;
    h.onMove(e);
  };

  const onUp = (e: MouseEvent) => {
    if (ended) return;
    // Tear down BEFORE invoking the handler. If the handler synchronously
    // emits a graph "change" event (which rebuilds the DOM), we want our
    // window listeners gone first so they can't fire on stale state.
    teardown();
    h.onUp(e);
  };

  const onBlur = () => {
    if (ended) return;
    teardown();
    h.onCancel?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (ended) return;
    if (e.key !== "Escape") return;
    teardown();
    h.onCancel?.();
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("keydown", onKey);

  return {
    end: teardown,
  };
}
