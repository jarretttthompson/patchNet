import type { PortDef, PortType } from "./PatchNode";
import type { PatchNode } from "./PatchNode";
import { getUserDefaultSize } from "./userObjectDefaults";

/** Height of the attribute panel header — must match --pn-attrui-header-h in shell.css */
export const ATTR_SIDE_INLET_HEADER_H = 22;
/** Height of each arg row — must match --pn-attrui-row-h in shell.css */
export const ATTR_SIDE_INLET_ROW_H = 24;

export interface ArgDef {
  name: string;
  type: "int" | "float" | "symbol" | "list";
  default?: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  /** If true, the arg is internal and should not appear in the attribute panel. */
  hidden?: boolean;
}

export interface MessageDef {
  inlet: number;
  selector: string;
  description: string;
  args?: string[];
}

export interface ObjectSpec {
  description: string;
  category: "ui" | "control" | "audio" | "scripting" | "visual";
  args: ArgDef[];
  messages: MessageDef[];
  inlets: PortDef[];
  outlets: PortDef[];
  defaultWidth: number;
  defaultHeight: number;
}

function mathOpDef(description: string, outLabel: string): ObjectSpec {
  return {
    description,
    category: "control",
    args: [{ name: "value", type: "float", default: "0", description: "Right operand (cold)." }],
    messages: [
      { inlet: 0, selector: "float", description: "set left operand, compute, and output" },
      { inlet: 0, selector: "bang",  description: "recompute with stored operands and output" },
      { inlet: 1, selector: "float", description: "set right operand (no output)" },
    ],
    inlets: [
      { index: 0, type: "float", label: "left operand (hot)",  temperature: "hot"  },
      { index: 1, type: "float", label: "right operand (cold)", temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "float", label: outLabel }],
    defaultWidth: 60,
    defaultHeight: 40,
  };
}

export const OBJECT_DEFS: Record<string, ObjectSpec> = {
  comment: {
    description: "Non-functional annotation text. Double-click to edit.",
    category: "ui",
    args: [{ name: "text", type: "symbol", default: "comment", description: "Annotation text." }],
    messages: [],
    inlets: [],
    outlets: [],
    defaultWidth: 160,
    defaultHeight: 28,
  },

  button: {
    description: "Momentary trigger that flashes and sends a bang.",
    category: "ui",
    args: [],
    messages: [{ inlet: 0, selector: "bang", description: "flash + dispatch bang" }],
    inlets:  [{ index: 0, type: "bang",  label: "bang: flash & send" }],
    outlets: [{ index: 0, type: "bang",  label: "bang out" }],
    defaultWidth: 40,
    defaultHeight: 40,
  },

  toggle: {
    description: "Two-state UI toggle that outputs 0.0 or 1.0.",
    category: "ui",
    args: [
      { name: "value", type: "int", default: "0", min: 0, max: 1, step: 1,
        description: "Initial on/off state." },
    ],
    messages: [
      { inlet: 0, selector: "bang",  description: "flip current state and output float state" },
      { inlet: 0, selector: "float", description: "set state from zero/nonzero and output float state" },
      { inlet: 0, selector: "value", description: "set value via attribute: value 0|1" },
    ],
    inlets:  [{ index: 0, type: "any",   label: "bang: flip  |  float: set  |  value 0|1",  temperature: "hot" }],
    outlets: [{ index: 0, type: "float", label: "state (0 or 1)" }],
    defaultWidth: 64,
    defaultHeight: 80,
  },

  slider: {
    description: "Horizontal slider that outputs a float in [0.0, 1.0].",
    category: "ui",
    args: [
      { name: "value", type: "float", default: "0", min: 0, max: 1, step: 0.001,
        description: "Current value (0.0–1.0)." },
    ],
    messages: [
      { inlet: 0, selector: "float", description: "set value, update thumb, and output" },
      { inlet: 0, selector: "value", description: "set value via attribute: value <float>" },
      { inlet: 1, selector: "bang",  description: "output current value without changing it" },
    ],
    inlets: [
      { index: 0, type: "float", label: "set value (0.0–1.0)",        temperature: "hot" },
      { index: 1, type: "bang",  label: "bang: output current value",  temperature: "hot" },
    ],
    outlets: [{ index: 0, type: "float", label: "value (0.0–1.0)" }],
    defaultWidth: 140,
    defaultHeight: 40,
  },

  message: {
    description: "Stores message content and outputs it on click or trigger.",
    category: "ui",
    args: [{ name: "content", type: "symbol", description: "Initial message content." }],
    messages: [
      { inlet: 0, selector: "bang",    description: "output stored content" },
      { inlet: 0, selector: "set",     description: "replace stored content without output" },
      { inlet: 0, selector: "append",  description: "append to stored content without output" },
      { inlet: 0, selector: "prepend", description: "prepend to stored content without output" },
      { inlet: 0, selector: "any",     description: "substitute $1–$9 from incoming args and output" },
      { inlet: 1, selector: "bang",    description: "set stored content to 'bang' without output" },
      { inlet: 1, selector: "any",     description: "store incoming value without output" },
    ],
    inlets: [
      { index: 0, type: "message", label: "bang → output | value → substitute $1–$9 and output | set/append/prepend → store", temperature: "hot" },
      { index: 1, type: "message", label: "value → store | bang → set content to 'bang'",                                      temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "message", label: "message out" }],
    defaultWidth: 120,
    defaultHeight: 36,
  },

  metro: {
    description: "Interval timer that emits bangs using setInterval.",
    category: "control",
    args: [
      { name: "interval", type: "float", default: "500", min: 1, max: 10000, step: 1,
        description: "Interval in milliseconds." },
      { name: "running", type: "int", default: "0", hidden: true,
        description: "Timer running state (1 = running, 0 = stopped)." },
    ],
    messages: [
      { inlet: 0, selector: "bang",     description: "toggle timer start/stop" },
      { inlet: 0, selector: "float",    description: "1 starts, 0 stops" },
      { inlet: 0, selector: "interval", description: "set interval ms: interval <float>" },
      { inlet: 1, selector: "float",    description: "set interval ms and restart if running" },
    ],
    inlets: [
      { index: 0, type: "any",   label: "bang: toggle  |  1/0: start/stop  |  interval <ms>", temperature: "hot"  },
      { index: 1, type: "float", label: "interval (ms)",                                       temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "bang", label: "bang (each tick)" }],
    defaultWidth: 100,
    defaultHeight: 40,
  },

  oscillateNumbers: {
    description: "Continuous sine-wave oscillator that outputs floats in [0.0, 1.0]. Requires a gate (float 1 to start, 0 to stop).",
    category: "control",
    args: [
      { name: "freq",    type: "float", default: "1", min: 0.01, max: 20, step: 0.01,
        description: "Oscillation frequency in Hz (cycles per second)." },
      { name: "running", type: "int",   default: "0", hidden: true,
        description: "Running state (1 = oscillating, 0 = stopped)." },
    ],
    messages: [
      { inlet: 0, selector: "bang",  description: "toggle running on/off" },
      { inlet: 0, selector: "float", description: "1 = start, 0 = stop" },
      { inlet: 0, selector: "freq",  description: "set frequency Hz: freq <float>" },
      { inlet: 1, selector: "float", description: "set frequency Hz (restarts phase if already running)" },
    ],
    inlets: [
      { index: 0, type: "any",   label: "1: start  |  0: stop  |  bang: toggle  |  freq <hz>", temperature: "hot"  },
      { index: 1, type: "float", label: "frequency (Hz)",                                       temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "float", label: "value (0.0–1.0)" }],
    defaultWidth:  160,
    defaultHeight: 40,
  },

  integer: {
    description: "Integer number box — drag vertically to change value. Max-style hot/cold inlets.",
    category: "control",
    args: [{ name: "value", type: "int", default: "0", description: "Current integer value." }],
    messages: [
      { inlet: 0, selector: "bang",  description: "output stored value" },
      { inlet: 0, selector: "int",   description: "store and output" },
      { inlet: 0, selector: "float", description: "truncate to int, store, and output" },
      { inlet: 0, selector: "set",   description: "store without outputting: set <n>" },
      { inlet: 1, selector: "int",   description: "store (cold) — no output" },
      { inlet: 1, selector: "float", description: "truncate to int and store (cold) — no output" },
    ],
    inlets: [
      { index: 0, type: "any", label: "set + output  |  bang: output  |  set <n>: store only", temperature: "hot"  },
      { index: 1, type: "any", label: "store value (no output)",                                 temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "float", label: "integer value" }],
    defaultWidth: 80,
    defaultHeight: 40,
  },

  float: {
    description: "Float number box — drag vertically to change value; click a digit to set drag increment. Max-style hot/cold inlets.",
    category: "control",
    args: [{ name: "value", type: "float", default: "0.0", description: "Current float value." }],
    messages: [
      { inlet: 0, selector: "bang",  description: "output stored value" },
      { inlet: 0, selector: "int",   description: "store and output" },
      { inlet: 0, selector: "float", description: "store and output" },
      { inlet: 0, selector: "set",   description: "store without outputting: set <n>" },
      { inlet: 1, selector: "int",   description: "store (cold) — no output" },
      { inlet: 1, selector: "float", description: "store (cold) — no output" },
    ],
    inlets: [
      { index: 0, type: "any", label: "set + output  |  bang: output  |  set <n>: store only", temperature: "hot"  },
      { index: 1, type: "any", label: "store value (no output)",                                 temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "float", label: "float value" }],
    defaultWidth: 80,
    defaultHeight: 40,
  },

  t: {
    description: "Trigger (abbreviated t). Distributes input to multiple outlets in right-to-left order, converting each to the type specified by its argument letter: i=int, f=float, b=bang, s=symbol, l=list. Default args: i i.",
    category: "control",
    args: [],
    messages: [
      { inlet: 0, selector: "bang",  description: "fire outlets right-to-left; b outlets emit bang, numeric outlets emit 0, symbol/list outlets emit empty" },
      { inlet: 0, selector: "float", description: "fire outlets right-to-left, converting the value per outlet type" },
      { inlet: 0, selector: "any",   description: "fire outlets right-to-left, converting the value per outlet type" },
    ],
    inlets:  [{ index: 0, type: "any", label: "any → fan out right-to-left", temperature: "hot" }],
    outlets: [
      { index: 0, type: "float", label: "int" },
      { index: 1, type: "float", label: "int" },
    ],
    defaultWidth:  80,
    defaultHeight: 40,
  },

  scale: {
    description: "Maps a number from one range to another (linear interpolation).",
    category: "control",
    args: [
      { name: "inLow",  type: "float", default: "0",   description: "Input range low." },
      { name: "inHigh", type: "float", default: "1",   description: "Input range high." },
      { name: "outLow", type: "float", default: "0",   description: "Output range low." },
      { name: "outHigh",type: "float", default: "127", description: "Output range high." },
    ],
    messages: [
      { inlet: 0, selector: "float", description: "map value and output result" },
      { inlet: 1, selector: "float", description: "set input low" },
      { inlet: 2, selector: "float", description: "set input high" },
      { inlet: 3, selector: "float", description: "set output low" },
      { inlet: 4, selector: "float", description: "set output high" },
    ],
    inlets: [
      { index: 0, type: "float", label: "value to scale",  temperature: "hot" },
      { index: 1, type: "float", label: "input low",       temperature: "cold" },
      { index: 2, type: "float", label: "input high",      temperature: "cold" },
      { index: 3, type: "float", label: "output low",      temperature: "cold" },
      { index: 4, type: "float", label: "output high",     temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "float", label: "scaled value" }],
    defaultWidth: 180,
    defaultHeight: 40,
  },

  timer: {
    description: "Measures elapsed milliseconds between successive bangs. First bang stores the clock; each subsequent bang outputs the delta and resets.",
    category: "control",
    args: [],
    messages: [
      { inlet: 0, selector: "bang",  description: "output ms since last bang (0 on first bang), then reset clock" },
    ],
    inlets:  [{ index: 0, type: "bang", label: "bang: output elapsed ms and reset" }],
    outlets: [{ index: 0, type: "float", label: "elapsed ms" }],
    defaultWidth: 80,
    defaultHeight: 40,
  },

  // ── Arithmetic operators ────────────────────────────────────────────────────
  "+":  mathOpDef("Add two numbers.",      "sum"),
  "-":  mathOpDef("Subtract two numbers.", "difference"),
  "*":  mathOpDef("Multiply two numbers.", "product"),
  "/":  mathOpDef("Divide two numbers.",   "quotient"),
  "%":  mathOpDef("Modulo of two numbers.", "remainder"),

  // ── Comparison operators ────────────────────────────────────────────────────
  "==": mathOpDef("Output 1 if left equals right, else 0.",          "0 or 1"),
  "!=": mathOpDef("Output 1 if left does not equal right, else 0.",  "0 or 1"),
  ">":  mathOpDef("Output 1 if left is greater than right, else 0.", "0 or 1"),
  "<":  mathOpDef("Output 1 if left is less than right, else 0.",    "0 or 1"),
  ">=": mathOpDef("Output 1 if left >= right, else 0.", "0 or 1"),
  "<=": mathOpDef("Output 1 if left <= right, else 0.", "0 or 1"),

  "click~": {
    description: "Triggerable click signal source.",
    category: "audio",
    args: [],
    messages: [{ inlet: 0, selector: "bang", description: "output click signal" }],
    inlets:  [{ index: 0, type: "bang",   label: "bang: trigger click" }],
    outlets: [{ index: 0, type: "signal", label: "click signal out" }],
    defaultWidth: 80,
    defaultHeight: 40,
  },

  "dac~": {
    description: "Audio output sink.",
    category: "audio",
    args: [],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [],
    defaultWidth: 80,
    defaultHeight: 64,
  },

  "fft~": {
    description: "FFT spectrum analyzer. Displays a spectrogram and outputs 4 band levels: low, low-mid, hi-mid, hi.",
    category: "audio",
    args: [],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [
      { index: 0, type: "float", label: "low (20–250 Hz)" },
      { index: 1, type: "float", label: "low-mid (250–2k Hz)" },
      { index: 2, type: "float", label: "hi-mid (2k–6k Hz)" },
      { index: 3, type: "float", label: "hi (6k–20k Hz)" },
    ],
    defaultWidth:  160,
    defaultHeight: 200,
  },

  "adc~": {
    description: "Audio input source. Captures from the selected input device.",
    category: "audio",
    args: [],
    messages: [],
    inlets: [],
    outlets: [
      { index: 0, type: "signal", label: "left channel out" },
      { index: 1, type: "signal", label: "right channel out" },
    ],
    defaultWidth: 80,
    defaultHeight: 64,
  },

  codebox: {
    description: "Scriptable object with dynamic ports derived from code.",
    category: "scripting",
    args: [
      { name: "language", type: "symbol", default: "js",
        description: "Active language (js only in Phase A)" },
      { name: "code", type: "symbol", default: "", hidden: true,
        description: "Base64-encoded source" },
    ],
    messages: [
      { inlet: 0, selector: "bang",   description: "execute with bang on inlet 0" },
      { inlet: 0, selector: "float",  description: "execute with a numeric value" },
      { inlet: 0, selector: "symbol", description: "execute with a string value" },
      { inlet: 0, selector: "set",    description: "replace code without executing" },
    ],
    inlets: [],
    outlets: [],
    defaultWidth: 260,
    defaultHeight: 120,
  },

  visualizer: {
    description: "Creates a named popup render window for compositing visual layers.",
    category: "visual",
    args: [
      { name: "name", type: "symbol", default: "world1",
        description: "Render context name used by layer objects to target this window." },
      { name: "float", type: "int", default: "0", min: 0, max: 1, step: 1,
        description: "Floating window: 1 = keep popup on top whenever patchNet is focused." },
      { name: "open", type: "int", default: "0", min: 0, max: 1, step: 1,
        description: "Console state: 1 = popup open, 0 = closed (persisted with the patch)." },
      { name: "screenX", type: "int", default: "100", min: -3840, max: 3840, step: 1,
        description: "Console position — screen X of the popup (pixels)." },
      { name: "screenY", type: "int", default: "100", min: -2160, max: 2160, step: 1,
        description: "Console position — screen Y of the popup (pixels)." },
      { name: "winW", type: "int", default: "640", min: 200, max: 3840, step: 1,
        description: "Console width — inner width of the popup (pixels); scales the render surface." },
      { name: "winH", type: "int", default: "480", min: 150, max: 2160, step: 1,
        description: "Console height — inner height of the popup (pixels); scales the render surface." },
    ],
    messages: [
      { inlet: 0, selector: "bang",       description: "toggle open/close" },
      { inlet: 0, selector: "open",       description: "open/close: open 1 = show, open 0 = hide" },
      { inlet: 0, selector: "close",      description: "hide the popup window" },
      { inlet: 0, selector: "fullscreen", description: "fullscreen 1 = fill screen (popup resized to screen.availWidth × availHeight, moved to 0,0); fullscreen 0 = restore pre-fullscreen size/position. For truly borderless fullscreen double-click the popup or press F inside it (Esc exits)." },
      { inlet: 0, selector: "size",       description: "resize window: size <w> <h>" },
      { inlet: 0, selector: "pos",        description: "move window: pos <x> <y>" },
      { inlet: 0, selector: "float",      description: "floating mode: float 0|1" },
      { inlet: 0, selector: "screenX",    description: "set window screen X position: screenX <px>" },
      { inlet: 0, selector: "screenY",    description: "set window screen Y position: screenY <px>" },
      { inlet: 0, selector: "winW",       description: "set window width: winW <px>" },
      { inlet: 0, selector: "winH",       description: "set window height: winH <px>" },
    ],
    inlets:  [{ index: 0, type: "any",  label: "1: open  |  0: close  |  bang: toggle  |  fullscreen 1  |  size w h  |  pos x y" }],
    outlets: [
      { index: 0, type: "bang", label: "bang: window opened" },
      { index: 1, type: "bang", label: "bang: window closed" },
    ],
    defaultWidth: 140,
    defaultHeight: 40,
  },

  imageFX: {
    description: "Image effect processor. Sits between mediaImage and layer. Double-click to edit.",
    category: "visual",
    args: [
      { name: "hue",        type: "float", default: "0",   min: -180, max: 180, step: 1,
        description: "Hue rotation in degrees (−180 to +180)." },
      { name: "saturation", type: "float", default: "1",   min: 0,    max: 3,   step: 0.01,
        description: "Saturation multiplier. 1 = original, 0 = grayscale." },
      { name: "brightness", type: "float", default: "1",   min: 0,    max: 3,   step: 0.01,
        description: "Brightness multiplier. 1 = original." },
      { name: "contrast",   type: "float", default: "1",   min: 0,    max: 3,   step: 0.01,
        description: "Contrast multiplier. 1 = original." },
      { name: "blur",       type: "float", default: "0",   min: 0,    max: 20,  step: 0.5,
        description: "Gaussian blur radius in pixels." },
      { name: "invert",     type: "float", default: "0",   min: 0,    max: 1,   step: 0.01,
        description: "Color inversion amount (0–1)." },
      { name: "bgData",     type: "symbol", default: "", hidden: true,
        description: "localStorage key reference for persisted bg-removal PNG ('bg:<stableId>')." },
    ],
    messages: [
      { inlet: 0, selector: "hue",        description: "set hue rotation: hue <deg>" },
      { inlet: 0, selector: "saturation", description: "set saturation: saturation <f>" },
      { inlet: 0, selector: "brightness", description: "set brightness: brightness <f>" },
      { inlet: 0, selector: "contrast",   description: "set contrast: contrast <f>" },
      { inlet: 0, selector: "blur",       description: "set blur radius: blur <px>" },
      { inlet: 0, selector: "invert",     description: "set invert amount: invert <f>" },
      { inlet: 0, selector: "removeBg",   description: "remove background: removeBg [tolerance]" },
      { inlet: 0, selector: "clearBg",    description: "clear background removal" },
    ],
    inlets:  [{ index: 0, type: "media", label: "image in (← mediaImage)" }],
    outlets: [{ index: 0, type: "media", label: "processed image out (→ layer)" }],
    defaultWidth:  140,
    defaultHeight: 40,
  },

  mediaVideo: {
    description: "Video media source. Double-click to load a file.",
    category: "visual",
    args: [
      { name: "file",     type: "symbol", default: "", hidden: true,
        description: "IndexedDB reference key ('idb:<nodeId>') or remote URL." },
      { name: "filename", type: "symbol", default: "", hidden: true,
        description: "Original filename, shown in the text panel." },
      { name: "transport", type: "symbol", default: "stop",
        description: "Playback state mirrored in the text panel: play | pause | stop (stop = paused at time 0)." },
    ],
    messages: [
      { inlet: 0, selector: "bang",      description: "toggle play / pause" },
      { inlet: 0, selector: "play",      description: "start playback" },
      { inlet: 0, selector: "stop",      description: "pause playback" },
      { inlet: 0, selector: "seek",      description: "seek to normalized position (0.0–1.0)" },
      { inlet: 0, selector: "open",      description: "open file picker" },
      { inlet: 0, selector: "loop",      description: "set loop: loop <0|1>" },
      { inlet: 0, selector: "transport", description: "set transport state: transport play|pause|stop" },
    ],
    inlets:  [{ index: 0, type: "any",   label: "bang | play | stop | seek f | open | loop 0/1" }],
    outlets: [
      { index: 0, type: "media", label: "video media out (→ layer)" },
      { index: 1, type: "float", label: "playback position (0.0–1.0)" },
    ],
    defaultWidth: 120,
    defaultHeight: 40,
  },

  mediaImage: {
    description: "Still image media source. Double-click to load a file.",
    category: "visual",
    args: [
      { name: "file",     type: "symbol", default: "", hidden: true,
        description: "Image data URL." },
      { name: "filename", type: "symbol", default: "", hidden: true,
        description: "Original filename, shown in the polaroid caption." },
    ],
    messages: [
      { inlet: 0, selector: "bang", description: "output image reference" },
      { inlet: 0, selector: "open", description: "open file picker" },
    ],
    inlets:  [{ index: 0, type: "any",   label: "bang | open" }],
    outlets: [{ index: 0, type: "media", label: "image media out (→ layer)" }],
    defaultWidth: 120,
    defaultHeight: 150,
  },

  layer: {
    description: "Composites a media source into a named visualizer at a given draw priority.",
    category: "visual",
    args: [
      { name: "context",  type: "symbol", default: "world1",
        description: "Target visualizer context name." },
      { name: "priority", type: "int",    default: "0", min: 0, max: 20, step: 1,
        description: "Draw priority. 0 = bottom (drawn first). Higher = on top (drawn last)." },
      { name: "scaleX",   type: "float",  default: "1",  min: 0,    max: 5,   step: 0.01,
        description: "Horizontal scale factor. 1.0 = fill window width." },
      { name: "scaleY",   type: "float",  default: "1",  min: 0,    max: 5,   step: 0.01,
        description: "Vertical scale factor. 1.0 = fill window height." },
      { name: "posX",     type: "float",  default: "0",  min: -1,   max: 1,   step: 0.01,
        description: "Horizontal position offset as a fraction of canvas width. 0 = centered." },
      { name: "posY",     type: "float",  default: "0",  min: -1,   max: 1,   step: 0.01,
        description: "Vertical position offset as a fraction of canvas height. 0 = centered." },
    ],
    messages: [
      { inlet: 0, selector: "scaleX",   description: "set horizontal scale: scaleX <float>" },
      { inlet: 0, selector: "scaleY",   description: "set vertical scale: scaleY <float>" },
      { inlet: 0, selector: "scale",    description: "set both axes equally: scale <float>" },
      { inlet: 0, selector: "posX",     description: "set horizontal position offset: posX <float>" },
      { inlet: 0, selector: "posY",     description: "set vertical position offset: posY <float>" },
      { inlet: 0, selector: "pos",      description: "set both position axes: pos <x> <y>" },
      { inlet: 0, selector: "priority", description: "set draw priority: priority <int>" },
      { inlet: 0, selector: "context",  description: "set target visualizer: context <name>" },
    ],
    inlets:  [{ index: 0, type: "any", label: "media in  |  scaleX f  |  scaleY f  |  posX f  |  posY f  |  priority n  |  context name" }],
    outlets: [],
    defaultWidth: 120,
    defaultHeight: 40,
  },

  s: {
    description: "Send — broadcasts incoming bangs/values to all r objects on the same channel.",
    category: "control",
    args: [
      { name: "channel", type: "symbol", default: "",
        description: "Channel name to send on." },
    ],
    messages: [
      { inlet: 0, selector: "bang",  description: "broadcast bang to all r <channel>" },
      { inlet: 0, selector: "float", description: "broadcast float to all r <channel>" },
    ],
    inlets:  [{ index: 0, type: "any", label: "bang | float | message → broadcast" }],
    outlets: [],
    defaultWidth:  80,
    defaultHeight: 30,
  },

  r: {
    description: "Receive — fires its outlet whenever a matching s object broadcasts on the same channel.",
    category: "control",
    args: [
      { name: "channel", type: "symbol", default: "",
        description: "Channel name to receive on." },
    ],
    messages: [],
    inlets:  [],
    outlets: [{ index: 0, type: "any", label: "output (bang | float | message)" }],
    defaultWidth:  80,
    defaultHeight: 30,
  },

  vfxCRT: {
    description: "CRT video effect. Sits between mediaVideo and layer. Adds scanlines, vignette, and chromatic aberration.",
    category: "visual",
    args: [
      { name: "scanlines",  type: "float", default: "0.35", min: 0,   max: 1,   step: 0.01,
        description: "Scanline darkness (0 = off, 1 = maximum)." },
      { name: "vignette",   type: "float", default: "0.45", min: 0,   max: 1.5, step: 0.01,
        description: "Edge vignette strength (0 = off, 1.5 = very heavy)." },
      { name: "rgbShift",   type: "float", default: "1.5",  min: 0,   max: 40,  step: 0.5,
        description: "Chromatic aberration offset in pixels." },
      { name: "curvature",  type: "float", default: "0.15", min: 0,   max: 1,   step: 0.01,
        description: "Screen edge curvature / corner darkening." },
      { name: "brightness", type: "float", default: "1",    min: 0.5, max: 2,   step: 0.01,
        description: "Overall brightness multiplier." },
    ],
    messages: [
      { inlet: 0, selector: "scanlines",  description: "set scanline intensity (0–1)" },
      { inlet: 0, selector: "vignette",   description: "set vignette strength (0–1)" },
      { inlet: 0, selector: "rgbShift",   description: "set chromatic aberration offset (0–10 px)" },
      { inlet: 0, selector: "curvature",  description: "set screen curvature (0–1)" },
      { inlet: 0, selector: "brightness", description: "set brightness multiplier (0.5–2)" },
    ],
    inlets:  [{ index: 0, type: "media", label: "video in (← mediaVideo)" }],
    outlets: [{ index: 0, type: "media", label: "CRT-processed video out (→ layer)" }],
    defaultWidth:  120,
    defaultHeight: 40,
  },

  shaderToy: {
    description: "GLSL fragment-shader media source. Accepts ShaderToy-style `mainImage()` source and emits a render surface. Connect its outlet to a layer, then route that layer into a visualizer or patchViz.",
    category: "visual",
    args: [
      { name: "preset",  type: "symbol", default: "default",
        description: "Built-in preset name (default | plasma | warp | grid). Overridden by `code` when present." },
      { name: "code",    type: "symbol", default: "", hidden: true,
        description: "Base64-encoded GLSL fragment source (ShaderToy-style mainImage)." },
      { name: "width",   type: "int",    default: "512", min: 64, max: 2048, step: 1,
        description: "Render surface width in pixels." },
      { name: "height",  type: "int",    default: "512", min: 64, max: 2048, step: 1,
        description: "Render surface height in pixels." },
      { name: "mouseX",  type: "float",  default: "0.5", hidden: true,
        description: "Normalized iMouse.x (0–1)." },
      { name: "mouseY",  type: "float",  default: "0.5", hidden: true,
        description: "Normalized iMouse.y (0–1)." },
    ],
    messages: [
      { inlet: 0, selector: "preset", description: "switch to a built-in preset: preset <default|plasma|warp|grid>" },
      { inlet: 0, selector: "code",   description: "set fragment source (base64-encoded): code <base64>" },
      { inlet: 0, selector: "glsl",   description: "set fragment source (raw GLSL, rest of line): glsl void mainImage(...) { ... }" },
      { inlet: 0, selector: "mouse",  description: "set normalized mouse: mouse <x> <y>" },
      { inlet: 0, selector: "size",   description: "resize render surface: size <w> <h>" },
      { inlet: 0, selector: "reset",  description: "reset iTime to 0" },
    ],
    inlets:  [{ index: 0, type: "any",   label: "preset <name>  |  code <base64>  |  glsl <src>  |  mouse x y  |  size w h  |  reset" }],
    outlets: [{ index: 0, type: "media", label: "shader out (→ layer)" }],
    defaultWidth:  140,
    defaultHeight: 40,
  },

  vfxBlur: {
    description: "Gaussian blur video effect. Sits between mediaVideo and layer.",
    category: "visual",
    args: [
      { name: "radius",     type: "float", default: "2",   min: 0,   max: 30, step: 0.5,
        description: "Gaussian blur radius in pixels." },
      { name: "saturation", type: "float", default: "1",   min: 0,   max: 3,  step: 0.01,
        description: "Saturation multiplier. 1 = original, 0 = grayscale." },
      { name: "brightness", type: "float", default: "1",   min: 0.5, max: 2,  step: 0.01,
        description: "Brightness multiplier." },
    ],
    messages: [
      { inlet: 0, selector: "radius",     description: "set blur radius (0–30 px)" },
      { inlet: 0, selector: "saturation", description: "set saturation (0–3)" },
      { inlet: 0, selector: "brightness", description: "set brightness (0.5–2)" },
    ],
    inlets:  [{ index: 0, type: "media", label: "video in (← mediaVideo)" }],
    outlets: [{ index: 0, type: "media", label: "blurred video out (→ layer)" }],
    defaultWidth:  100,
    defaultHeight: 40,
  },

  attribute: {
    description: "Inspector panel. Cable its outlet to any object's inlet to reveal sliders for every controllable arg.",
    category: "ui",
    args: [],
    messages: [],
    inlets:  [],
    outlets: [{ index: 0, type: "any", label: "→ connect to target object" }],
    defaultWidth:  240,
    defaultHeight: 160,
  },

  patchViz: {
    description: "Inline render context — layers targeting this context name composite directly into the patch canvas.",
    category: "visual",
    args: [
      { name: "context", type: "symbol", default: "world1",
        description: "Render context name (layers targeting this name will render into this object)." },
      { name: "enabled", type: "int", default: "1", min: 0, max: 1, step: 1,
        description: "1 = rendering active, 0 = canvas dark." },
    ],
    messages: [
      { inlet: 0, selector: "bang",    description: "toggle enabled state" },
      { inlet: 0, selector: "context", description: "set context name: context <name>" },
    ],
    inlets:  [
      { index: 0, type: "any", label: "1: enable  |  0: disable  |  bang: toggle", temperature: "hot" },
    ],
    outlets: [],
    defaultWidth:  320,
    defaultHeight: 240,
  },

  inlet: {
    description: "Subpatch inlet — fires its outlet when the parent patch triggers it.",
    category: "control",
    args: [
      { name: "index", type: "int", default: "0", min: 0, max: 31, step: 1,
        description: "Inlet index on the parent subPatch object (0-based)." },
    ],
    messages: [],
    inlets:  [],
    outlets: [{ index: 0, type: "any", label: "data from parent" }],
    defaultWidth:  40,
    defaultHeight: 30,
  },

  outlet: {
    description: "Subpatch outlet — forwards data out through the parent patch.",
    category: "control",
    args: [
      { name: "index", type: "int", default: "0", min: 0, max: 31, step: 1,
        description: "Outlet index on the parent subPatch object (0-based)." },
    ],
    messages: [
      { inlet: 0, selector: "bang",  description: "forward bang to parent outlet" },
      { inlet: 0, selector: "float", description: "forward value to parent outlet" },
    ],
    inlets:  [{ index: 0, type: "any", label: "data → parent", temperature: "hot" }],
    outlets: [],
    defaultWidth:  40,
    defaultHeight: 30,
  },

  sequencer: {
    description: "Step sequencer. Bang advances the playhead by one column; each row outputs its active-column value through its own outlet. Rows define outlet count.",
    category: "control",
    args: [
      { name: "rows", type: "int", default: "4", min: 1, max: 32, step: 1,
        description: "Number of rows (= outlet count)." },
      { name: "cols", type: "int", default: "8", min: 1, max: 64, step: 1,
        description: "Number of columns (= step count)." },
      { name: "playhead", type: "int", default: "0", hidden: true,
        description: "Current column index (0-based)." },
      { name: "cells",    type: "symbol", default: "", hidden: true,
        description: "Base64-encoded JSON matrix of cell values." },
      { name: "locked",   type: "int", default: "1", min: 0, max: 1, step: 1, hidden: true,
        description: "1 = locked (cells read-only), 0 = unlocked (cells editable)." },
    ],
    messages: [
      { inlet: 0, selector: "bang", description: "advance playhead by one column, wrapping at end; fire each row outlet" },
    ],
    inlets:  [{ index: 0, type: "bang", label: "bang → advance playhead", temperature: "hot" }],
    outlets: [], // derived from rows
    defaultWidth:  240,
    defaultHeight: 120,
  },

  dmx: {
    description: "DMX512 output via an ENTTEC DMXUSB PRO (Web Serial). Maintains a 512-channel universe and streams frames continuously while connected.",
    category: "control",
    args: [
      { name: "rate",  type: "float",  default: "40", min: 10, max: 44, step: 1,
        description: "Frame refresh rate in Hz (10–44)." },
      { name: "baud",  type: "int",    default: "250000", min: 9600, max: 250000, step: 1,
        description: "Serial baud rate passed to the ENTTEC widget. 250000 matches the widget's internal DMX clock; 57600/115200 are fallbacks for older firmware." },
      { name: "open",  type: "int",    default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "1 = connected at last save; attempts silent reacquire on load." },
      { name: "vid",   type: "int",    default: "0", hidden: true,
        description: "Persisted USB vendor id of the last-used port (decimal, 0 if unknown)." },
      { name: "pid",   type: "int",    default: "0", hidden: true,
        description: "Persisted USB product id of the last-used port (decimal, 0 if unknown)." },
      { name: "label", type: "symbol", default: "", hidden: true,
        description: "Human-readable label of the last-used port." },
      { name: "userProfiles", type: "symbol", default: "", hidden: true,
        description: "Base64-encoded JSON array of user-imported fixture profiles." },
      { name: "patches", type: "symbol", default: "", hidden: true,
        description: "Base64-encoded JSON array of patched fixture instances." },
      { name: "locked", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "0 = panel interactive (default); 1 = locked so the object can be dragged." },
    ],
    messages: [
      { inlet: 0, selector: "connect",    description: "open or reacquire the serial port and begin streaming" },
      { inlet: 0, selector: "disconnect", description: "stop streaming and close the serial port" },
      { inlet: 0, selector: "dmx",        description: "set channels starting at address: dmx <addr> <v1> [<v2> ...]" },
      { inlet: 0, selector: "blackout",   description: "zero the entire universe, or one fixture: blackout [<name>]" },
      { inlet: 0, selector: "defaults",   description: "restore profile defaults on one fixture: defaults <name>" },
      { inlet: 0, selector: "rate",       description: "set refresh rate (Hz): rate <10..44>" },
      { inlet: 0, selector: "status",     description: "emit current connection state through outlet 1" },
      { inlet: 0, selector: "patch",      description: "create fixture instance: patch <name> <profileId> <startAddress>" },
      { inlet: 0, selector: "unpatch",    description: "remove fixture instance: unpatch <name>" },
      { inlet: 0, selector: "rename",     description: "rename fixture: rename <oldName> <newName>" },
      { inlet: 0, selector: "repoint",    description: "change fixture's profile: repoint <name> <newProfileId>" },
      { inlet: 0, selector: "mute",       description: "mute/unmute a fixture: mute <name> 0|1" },
      { inlet: 0, selector: "set",        description: "set fixture attribute(s): set <name> <attr> <value> [<attr> <value> ...]" },
      { inlet: 0, selector: "setall",     description: "set <attr> on every fixture that has it: setall <attr> <value>" },
      { inlet: 0, selector: "profile",    description: "profile import <base64-json> | profile remove <id> | profile list" },
    ],
    inlets:  [{ index: 0, type: "any", label: "connect | disconnect | dmx <addr> <v...> | blackout | rate <hz> | status | set <name> <attr> <v> | setall <attr> <v> | patch | unpatch | profile …", temperature: "hot" }],
    outlets: [
      { index: 0, type: "bang",    label: "bang on state change" },
      { index: 1, type: "message", label: "status / error messages" },
    ],
    defaultWidth:  560,
    defaultHeight: 520,
  },

  subPatch: {
    description: "Embedded subpatch. Double-click to open and edit in a new tab.",
    category: "control",
    args: [
      { name: "inlets",  type: "int",    default: "0", hidden: true,
        description: "Number of inlets (derived from inlet objects inside)." },
      { name: "outlets", type: "int",    default: "0", hidden: true,
        description: "Number of outlets (derived from outlet objects inside)." },
      { name: "content", type: "symbol", default: "", hidden: true,
        description: "Base64-encoded subpatch content." },
      { name: "locked",  type: "int",    default: "1", min: 0, max: 1, step: 1, hidden: true,
        description: "1 = locked (interact with GUI), 0 = unlocked (reposition GUI objects)." },
    ],
    messages: [],
    inlets:  [],
    outlets: [],
    defaultWidth:  120,
    defaultHeight: 40,
  },
};

/**
 * Canonicalize object-type aliases (e.g. `trigger` → `t`). Called at node
 * creation, parse, and type-rename boundaries so the graph always stores
 * the canonical form that Max itself displays.
 */
const TYPE_ALIASES: Record<string, string> = {
  trigger: "t",
};
export function canonicalizeType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

// Make `trigger` discoverable via autocomplete while sharing t's spec.
OBJECT_DEFS.trigger = OBJECT_DEFS.t;

/**
 * Ensure all sequencer arg slots are present. The serializer spreads
 * `node.args` into a space-joined line; sparse arrays (`args[4] = "0"` with
 * `args[0..3]` undefined) would produce `"undefined"` tokens and break the
 * round-trip. Mutates and returns the input array.
 */
export function ensureSequencerArgs(args: string[]): string[] {
  if (args[0] === undefined) args[0] = "4";
  if (args[1] === undefined) args[1] = "8";
  if (args[2] === undefined) args[2] = "0";
  if (args[3] === undefined) args[3] = "W10="; // btoa("[]")
  if (args[4] === undefined) args[4] = "1";
  return args;
}

/**
 * Sequencer: one outlet per row. Inlet is a fixed bang inlet that advances
 * the playhead. Row count is clamped to the arg range.
 */
export function deriveSequencerPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const rows = Math.max(1, Math.min(32, Math.trunc(Number.parseFloat(args[0] ?? "4")) || 4));
  const inlets: PortDef[] = [
    { index: 0, type: "bang", label: "bang → advance playhead", temperature: "hot" },
  ];
  const outlets: PortDef[] = Array.from({ length: rows }, (_, i) => ({
    index: i,
    type: "any" as PortType,
    label: `row ${i}`,
    side: "right" as const,
  }));
  return { inlets, outlets };
}

/** Clamped row count for a sequencer node. */
export function sequencerRows(node: PatchNode): number {
  return Math.max(1, Math.min(32, Math.trunc(Number.parseFloat(node.args[0] ?? "4")) || 4));
}

/** Clamped column count for a sequencer node. */
export function sequencerCols(node: PatchNode): number {
  return Math.max(1, Math.min(64, Math.trunc(Number.parseFloat(node.args[1] ?? "8")) || 8));
}

/** Decode base64-encoded sequencer cells into a possibly-ragged string matrix. */
function decodeSequencerCellsRaw(b64: string): string[][] {
  if (!b64) return [];
  try {
    const json = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(r => Array.isArray(r) ? r.map(v => String(v ?? "")) : []);
  } catch {
    return [];
  }
}

/** Returns the cell matrix resized to rows × cols, padding missing slots with "". */
export function getSequencerCells(node: PatchNode): string[][] {
  const rows = sequencerRows(node);
  const cols = sequencerCols(node);
  const stored = decodeSequencerCellsRaw(node.args[3] ?? "");
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => stored[r]?.[c] ?? ""),
  );
}

/** Encode a cell matrix back into the node's args[3]. */
export function setSequencerCells(node: PatchNode, cells: string[][]): void {
  const json = JSON.stringify(cells);
  node.args[3] = btoa(unescape(encodeURIComponent(json)));
}

/**
 * Trigger: outlets are derived from arg letters (i/f/b/s/l). With no args,
 * default to `i i` (two ints) to match Max's behavior.
 */
export function deriveTriggerPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const letters = args.length > 0 ? args : ["i", "i"];
  const inlets: PortDef[] = [
    { index: 0, type: "any", label: "any → fan out right-to-left", temperature: "hot" },
  ];
  const outlets: PortDef[] = letters.map((raw, i) => {
    const letter = raw.toLowerCase();
    switch (letter) {
      case "i": return { index: i, type: "float"   as PortType, label: "int" };
      case "f": return { index: i, type: "float"   as PortType, label: "float" };
      case "b": return { index: i, type: "bang"    as PortType, label: "bang" };
      case "s": return { index: i, type: "message" as PortType, label: "symbol" };
      case "l": return { index: i, type: "message" as PortType, label: "list" };
      default:  return { index: i, type: "any"     as PortType, label: raw };
    }
  });
  return { inlets, outlets };
}

export function getObjectDef(type: string): ObjectSpec {
  const def = OBJECT_DEFS[type];

  if (!def) {
    throw new Error(`Unknown object type: ${type}`);
  }

  const result: ObjectSpec = {
    ...def,
    args: def.args.map((arg) => ({ ...arg })),
    messages: def.messages.map((message) => ({ ...message, args: message.args ? [...message.args] : undefined })),
    inlets: def.inlets.map((port) => ({ ...port })),
    outlets: def.outlets.map((port) => ({ ...port })),
  };

  // Any object with configurable args needs at least one inlet so the
  // attribute inspector can connect to it. Codebox is excluded because its
  // inlets are derived from the code at parse time, not from the spec.
  if (result.args.length > 0 && result.inlets.length === 0 && type !== "codebox" && type !== "inlet" && type !== "subPatch") {
    result.inlets.push({ index: 0, type: "any", label: "attr" });
  }

  // User may have overridden the built-in default size via right-click.
  const userSize = getUserDefaultSize(type);
  if (userSize) {
    result.defaultWidth  = userSize.width;
    result.defaultHeight = userSize.height;
  }

  return result;
}

// ── Attribute panel helpers ───────────────────────────────────────────────────

/** Args visible in the attribute panel (non-hidden only). */
export function getVisibleArgs(spec: ObjectSpec): ArgDef[] {
  return spec.args.filter(a => !a.hidden);
}

/**
 * Called when an attribute node's outlet 0 is connected to a target.
 * Writes the discovered type into args[0] and seeds per-arg values from
 * the target spec's defaults (preserving any values already set).
 * Does NOT emit a change event — caller is responsible.
 */
export function syncAttributeNode(node: PatchNode, targetType: string): void {
  const def = OBJECT_DEFS[targetType];
  node.args[0] = targetType;

  if (!def) {
    node.args.length = 1;
    node.inlets = [];
    return;
  }

  const visible = getVisibleArgs(def);
  visible.forEach((arg, i) => {
    if (node.args[i + 1] === undefined) {
      node.args[i + 1] = arg.default ?? "0";
    }
  });
  // Trim stale values from a previous target type
  node.args.length = visible.length + 1;

  // Rebuild inlets: one left-side inlet per visible arg for direct value patching
  node.inlets = visible.map((arg, i) => ({
    index: i,
    type: "any" as PortType,
    label: arg.name,
    side: "left" as const,
  }));

  // Auto-size height to fit exactly the header + one row per arg
  node.height = ATTR_SIDE_INLET_HEADER_H + visible.length * ATTR_SIDE_INLET_ROW_H;
}

/**
 * Resets an attribute node to its blank, unconnected state.
 * Does NOT emit a change event — caller is responsible.
 */
export function resetAttributeNode(node: PatchNode): void {
  node.args = [];
  node.inlets = [];
  node.height = undefined; // restore default height when disconnected
}

/**
 * Builds the message string that the attribute object should send through its
 * outlet when visible arg[argIndex] changes to `value`.
 *
 * If the target's objectDef lists a named message selector matching the arg
 * name on inlet 0, returns "argName value".
 * Otherwise returns the raw value string (positional float handling).
 */
export function buildArgMessage(targetType: string, argIndex: number, value: string): string {
  const def = OBJECT_DEFS[targetType];
  if (!def) return value;

  const visible = getVisibleArgs(def);
  const arg = visible[argIndex];
  if (!arg) return value;

  const hasNamedSelector = def.messages.some(
    m => m.inlet === 0 && m.selector === arg.name,
  );

  return hasNamedSelector ? `${arg.name} ${value}` : value;
}
