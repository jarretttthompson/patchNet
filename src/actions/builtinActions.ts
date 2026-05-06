import type { PatchAction } from "./types";

const APP = "Application";
const VIEW = "View";
const TAB = "Tab";
const CANVAS = "Canvas";
const SELECTION = "Selection";

/**
 * Built-in actions covering every keyboard shortcut and toolbar button
 * that existed before the action system. Each id is stable — user keymaps
 * (Milestone 2) and macro definitions (Milestone 3) reference them.
 */
export const BUILTIN_ACTIONS: PatchAction[] = [
  // ── App / dialog ─────────────────────────────────────────────────────
  {
    id: "app.actions.open",
    title: "Show action list",
    section: APP,
    defaultKeys: ["?"],
    keywords: ["palette", "command", "menu", "shortcuts"],
    run: (ctx) => ctx.openActionList(),
  },

  // ── File ─────────────────────────────────────────────────────────────
  {
    id: "app.file.save",
    title: "Save patch to file",
    section: APP,
    category: "File",
    defaultKeys: ["Mod+S"],
    keywords: ["export", "download", "patchnet"],
    run: (ctx) => ctx.app.saveToFile(),
  },
  {
    id: "app.file.load",
    title: "Load patch from file…",
    section: APP,
    category: "File",
    keywords: ["open", "import"],
    run: (ctx) => ctx.app.openLoadPicker(),
  },
  {
    id: "app.file.share",
    title: "Copy share link",
    section: APP,
    category: "File",
    keywords: ["url", "share", "copy"],
    run: (ctx) => ctx.app.share(),
  },

  // ── Audio / DSP ──────────────────────────────────────────────────────
  {
    id: "app.audio.toggleDsp",
    title: "Toggle DSP",
    section: APP,
    category: "Audio",
    keywords: ["audio", "sound", "play", "stop"],
    run: (ctx) => ctx.app.toggleDsp(),
  },
  {
    id: "app.audio.startDsp",
    title: "Start DSP",
    section: APP,
    category: "Audio",
    keywords: ["audio", "play"],
    enabled: (ctx) => !ctx.app.isDspOn(),
    run: (ctx) => { if (!ctx.app.isDspOn()) ctx.app.toggleDsp(); },
  },
  {
    id: "app.audio.stopDsp",
    title: "Stop DSP",
    section: APP,
    category: "Audio",
    keywords: ["audio", "stop", "mute"],
    enabled: (ctx) => ctx.app.isDspOn(),
    run: (ctx) => { if (ctx.app.isDspOn()) ctx.app.toggleDsp(); },
  },

  // ── Modes / view ─────────────────────────────────────────────────────
  {
    id: "app.patchMode.toggle",
    title: "Toggle patch mode",
    section: VIEW,
    defaultKeys: ["P"],
    keywords: ["lock", "cables", "edit"],
    run: (ctx) => ctx.app.togglePatchMode(),
  },
  {
    id: "app.view.toggleToolbar",
    title: "Toggle toolbar",
    section: VIEW,
    defaultKeys: ["Q"],
    keywords: ["controls", "header"],
    run: (ctx) => ctx.app.toggleToolbar(),
  },
  {
    id: "app.view.toggleConsole",
    title: "Toggle text/console panel",
    section: VIEW,
    keywords: ["panel", "log", "side"],
    run: (ctx) => ctx.app.toggleConsole(),
  },

  // ── Tabs ─────────────────────────────────────────────────────────────
  {
    id: "app.tab.newScratch",
    title: "New scratch tab",
    section: TAB,
    defaultKeys: ["Mod+T"],
    keywords: ["tab", "scratch", "blank"],
    run: (ctx) => ctx.app.newScratchTab(),
  },

  // ── Edit / undo ──────────────────────────────────────────────────────
  {
    id: "canvas.undo",
    title: "Undo",
    section: CANVAS,
    defaultKeys: ["Mod+Z"],
    keywords: ["history", "back"],
    enabled: (ctx) => !!ctx.undo,
    run: (ctx) => ctx.canvas.undo(),
  },

  // ── Selection ────────────────────────────────────────────────────────
  {
    id: "canvas.selection.delete",
    title: "Delete selection",
    section: SELECTION,
    defaultKeys: ["Delete", "Backspace"],
    keywords: ["remove", "erase"],
    run: (ctx) => ctx.canvas.deleteSelection(),
  },
  {
    id: "canvas.selection.selectAll",
    title: "Select all",
    section: SELECTION,
    defaultKeys: ["Mod+A"],
    run: (ctx) => ctx.canvas.selectAllNodes(),
  },
  {
    id: "canvas.selection.clear",
    title: "Clear selection / dismiss entry",
    section: SELECTION,
    defaultKeys: ["Escape"],
    keywords: ["deselect", "cancel"],
    run: (ctx) => ctx.canvas.clearSelectionAndEntry(),
  },
  {
    id: "canvas.selection.groupToggle",
    title: "Group / ungroup selection",
    section: SELECTION,
    defaultKeys: ["G"],
    keywords: ["combine", "bundle"],
    run: (ctx) => ctx.canvas.toggleGroupSelection(),
  },

  // ── Zoom ─────────────────────────────────────────────────────────────
  {
    id: "canvas.view.zoomIn",
    title: "Zoom in",
    section: VIEW,
    category: "Canvas",
    defaultKeys: ["Mod+=", "Mod++"],
    run: (ctx) => ctx.canvas.zoomBy(1.15),
  },
  {
    id: "canvas.view.zoomOut",
    title: "Zoom out",
    section: VIEW,
    category: "Canvas",
    defaultKeys: ["Mod+-"],
    run: (ctx) => ctx.canvas.zoomBy(1 / 1.15),
  },
  {
    id: "canvas.view.zoomReset",
    title: "Reset zoom",
    section: VIEW,
    category: "Canvas",
    defaultKeys: ["Mod+0"],
    run: (ctx) => ctx.canvas.resetZoom(),
  },

  // ── Object placement ────────────────────────────────────────────────
  {
    id: "canvas.object.entry",
    title: "New object… (entry box)",
    section: CANVAS,
    defaultKeys: ["N"],
    keywords: ["create", "place", "type"],
    run: (ctx) => ctx.canvas.openObjectEntryAtCursor(),
  },
  // Quick-place shortcuts — preserve B/T/S/A/M behavior. Each one is also
  // exposed as canvas.object.create:<type> with no default key (added in
  // commit (c)) so the palette has parameterized rows for every object.
  {
    id: "canvas.object.create.button",
    title: "Place button",
    section: CANVAS,
    category: "Place object",
    defaultKeys: ["B"],
    run: (ctx) => ctx.canvas.placeObject("button"),
  },
  {
    id: "canvas.object.create.toggle",
    title: "Place toggle",
    section: CANVAS,
    category: "Place object",
    defaultKeys: ["T"],
    run: (ctx) => ctx.canvas.placeObject("toggle"),
  },
  {
    id: "canvas.object.create.slider",
    title: "Place slider",
    section: CANVAS,
    category: "Place object",
    defaultKeys: ["S"],
    run: (ctx) => ctx.canvas.placeObject("slider"),
  },
  {
    id: "canvas.object.create.attribute",
    title: "Place attribute",
    section: CANVAS,
    category: "Place object",
    defaultKeys: ["A"],
    run: (ctx) => ctx.canvas.placeObject("attribute"),
  },
  {
    id: "canvas.object.create.message",
    title: "Place message",
    section: CANVAS,
    category: "Place object",
    defaultKeys: ["M"],
    run: (ctx) => ctx.canvas.placeObject("message", { requireCursorOverCanvas: true }),
  },
];
