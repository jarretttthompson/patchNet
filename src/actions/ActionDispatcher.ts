import type { ActionRegistry } from "./ActionRegistry";
import type { ActionKeymap } from "./ActionKeymap";
import type { ActionContext } from "./types";
import { isEditableTarget } from "./ActionKeymap";

export class ActionDispatcher {
  constructor(
    private readonly registry: ActionRegistry,
    private readonly keymap: ActionKeymap,
    private readonly contextProvider: () => ActionContext,
  ) {}

  /** Run an action by ID. Skips when disabled. Errors are caught and flashed. */
  async run(actionId: string, args?: unknown): Promise<void> {
    const action = this.registry.get(actionId);
    if (!action) return;
    const ctx = this.contextProvider();
    if (action.enabled && !action.enabled(ctx)) return;
    try {
      await action.run(ctx, args);
    } catch (err) {
      ctx.flashStatus(`action failed: ${actionId}`);
      console.error(`[actions] ${actionId} threw`, err);
    }
  }

  /** Wire a single document-level keydown listener. Returns the unbinder. */
  attachToDocument(): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
      const ids = this.keymap.resolve(e);
      if (ids.length === 0) return;

      const editable = isEditableTarget(e.target);
      const ctx = this.contextProvider();

      for (const id of ids) {
        const action = this.registry.get(id);
        if (!action) continue;
        if (editable && !action.runsInEditable) continue;
        if (action.enabled && !action.enabled(ctx)) continue;
        e.preventDefault();
        // Fire and forget — async actions handle their own awaiting.
        Promise.resolve(action.run(ctx)).catch((err) => {
          ctx.flashStatus(`action failed: ${id}`);
          console.error(`[actions] ${id} threw`, err);
        });
        return;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }
}
