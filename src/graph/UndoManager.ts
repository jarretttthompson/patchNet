import type { PatchGraph } from "./PatchGraph";

const MAX_HISTORY = 100;

/**
 * Snapshot-based undo manager for PatchGraph.
 *
 * Strategy:
 *   - Maintains `previousState` — the serialized graph from before the most
 *     recent "change" event.
 *   - On every "change", pushes previousState onto the history stack, then
 *     updates previousState to the current (post-change) serialization.
 *   - undo() pops the top snapshot and calls graph.deserialize() with an
 *     `isRestoring` guard so that the resulting "change" event is not
 *     itself pushed onto the stack.
 */
export class UndoManager {
  private readonly history: string[] = [];
  private previousState: string;
  private isRestoring = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly graph: PatchGraph) {
    this.previousState = graph.serialize();

    this.unsubscribe = graph.on("change", () => {
      if (this.isRestoring) return;
      this.history.push(this.previousState);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.previousState = graph.serialize();
    });
  }

  undo(): void {
    if (this.history.length === 0) return;
    const state = this.history.pop()!;
    this.isRestoring = true;
    this.graph.deserialize(state);
    this.isRestoring = false;
    // previousState is now the restored snapshot — correct for the next change
    this.previousState = state;
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  destroy(): void {
    this.unsubscribe();
  }
}
