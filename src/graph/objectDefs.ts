import type { PortDef, PortType } from "./PatchNode";
import type { PatchNode } from "./PatchNode";

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
    description: "Horizontal slider that stores and outputs a value in the configured range.",
    category: "ui",
    args: [
      { name: "value", type: "float", default: "0",   min: 0, max: 127, step: 1,
        description: "Current value." },
      { name: "min",   type: "float", default: "0",   description: "Output minimum." },
      { name: "max",   type: "float", default: "127", description: "Output maximum." },
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
      { inlet: 0, selector: "bang",    description: "output stored content unchanged" },
      { inlet: 0, selector: "set",     description: "replace stored content without output" },
      { inlet: 1, selector: "append",  description: "append to stored content without output" },
      { inlet: 1, selector: "prepend", description: "prepend to stored content without output" },
    ],
    inlets: [
      { index: 0, type: "message", label: "hot: bang/value → store & send", temperature: "hot" },
      { index: 1, type: "message", label: "cold: value → store only",        temperature: "cold" },
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
      { index: 0, type: "any",   label: "bang: toggle  |  1/0: start/stop  |  interval <ms>" },
      { index: 1, type: "float", label: "interval (ms)" },
    ],
    outlets: [{ index: 0, type: "bang", label: "bang (each tick)" }],
    defaultWidth: 100,
    defaultHeight: 40,
  },

  integer: {
    description: "Integer number box — drag vertically to change value.",
    category: "control",
    args: [{ name: "value", type: "int", default: "0", description: "Current integer value." }],
    messages: [
      { inlet: 0, selector: "bang",  description: "output current value" },
      { inlet: 0, selector: "float", description: "set value (truncates to int) and output" },
    ],
    inlets:  [{ index: 0, type: "any",   label: "set value  |  bang: output", temperature: "hot" }],
    outlets: [{ index: 0, type: "float", label: "integer value" }],
    defaultWidth: 60,
    defaultHeight: 40,
  },

  float: {
    description: "Float number box — drag vertically to change value; click a digit to set drag increment.",
    category: "control",
    args: [{ name: "value", type: "float", default: "0.0", description: "Current float value." }],
    messages: [
      { inlet: 0, selector: "bang",  description: "output current value" },
      { inlet: 0, selector: "float", description: "set value and output" },
    ],
    inlets:  [{ index: 0, type: "any",   label: "set value  |  bang: output", temperature: "hot" }],
    outlets: [{ index: 0, type: "float", label: "float value" }],
    defaultWidth: 80,
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
      { inlet: 0, selector: "bang",    description: "toggle open/close" },
      { inlet: 0, selector: "open",    description: "open/close: open 1 = show, open 0 = hide" },
      { inlet: 0, selector: "close",   description: "hide the popup window" },
      { inlet: 0, selector: "size",    description: "resize window: size <w> <h>" },
      { inlet: 0, selector: "pos",     description: "move window: pos <x> <y>" },
      { inlet: 0, selector: "float",   description: "floating mode: float 0|1" },
      { inlet: 0, selector: "screenX", description: "set window screen X position: screenX <px>" },
      { inlet: 0, selector: "screenY", description: "set window screen Y position: screenY <px>" },
      { inlet: 0, selector: "winW",    description: "set window width: winW <px>" },
      { inlet: 0, selector: "winH",    description: "set window height: winH <px>" },
    ],
    inlets:  [{ index: 0, type: "any",  label: "1: open  |  0: close  |  bang: toggle  |  size w h  |  pos x y" }],
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
};

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
  if (result.args.length > 0 && result.inlets.length === 0 && type !== "codebox") {
    result.inlets.push({ index: 0, type: "any", label: "attr" });
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
