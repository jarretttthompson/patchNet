import type { PatchGraph } from "../graph/PatchGraph";
import type { CanvasController } from "../canvas/CanvasController";
import type { ObjectInteractionController } from "../canvas/ObjectInteractionController";
import type { ActionRegistry } from "./ActionRegistry";
import type { ActionKeymap } from "./ActionKeymap";

export interface UndoLike {
  undo(): void;
  readonly canUndo?: boolean;
}

/**
 * App-level functions exposed to actions. These are session-independent —
 * they live on the application singleton (main.ts) regardless of which tab
 * is active.
 */
export interface AppActionsAPI {
  saveToFile(): void | Promise<void>;
  openLoadPicker(): void;
  share(): void | Promise<void>;
  toggleDsp(): void;
  isDspOn(): boolean;
  togglePatchMode(): void;
  isPatchMode(): boolean;
  toggleToolbar(): void;
  toggleConsole(): void;
  newScratchTab(): void;
}

/**
 * Per-invocation context handed to an action's enabled() and run().
 * Action consumers must not capture this object — it is rebuilt each
 * dispatch so the active session is always current.
 */
export interface ActionContext {
  /** Active tab's graph (main / scratch / subpatch). */
  graph: PatchGraph;
  /** Active tab's CanvasController. */
  canvas: CanvasController;
  /** Active tab's ObjectInteractionController. */
  interaction: ObjectInteractionController;
  /** Active tab's UndoManager (main has one; subpatches/scratch may not). */
  undo: UndoLike | null;
  /** App-level functions (DSP, files, view toggles). */
  app: AppActionsAPI;
  /** Open the action list / palette dialog. */
  openActionList(): void;
  /** Toolbar status flash. */
  flashStatus(msg: string): void;
  /** Registry — for plugin actions that want to introspect siblings. */
  registry: ActionRegistry;
  /** Keymap — used by the action list to render shortcuts. */
  keymap: ActionKeymap;
}

/**
 * One named, dispatchable command.
 *
 * IDs are dotted, stable, and unique. Sections group rows in the action list.
 * defaultKeys are chord strings (see ActionKeymap.ts) — multiple bindings
 * for one action are allowed.
 *
 * runsInEditable: by default actions are blocked when the keyboard target
 * is an INPUT/TEXTAREA/SELECT/contenteditable. Set true only for actions
 * that explicitly need to fire while typing (none today).
 */
export interface PatchAction {
  id: string;
  title: string;
  section: string;
  category?: string;
  defaultKeys?: string[];
  keywords?: string[];
  runsInEditable?: boolean;
  /** If false, the action is hidden from the palette and its key is ignored. */
  enabled?(ctx: ActionContext): boolean;
  run(ctx: ActionContext, args?: unknown): void | Promise<void>;
}
