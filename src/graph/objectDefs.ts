import type { PortDef, PortType } from "./PatchNode";
import type { PatchNode } from "./PatchNode";
import { getUserDefaultSize } from "./userObjectDefaults";
import { parseJsfx } from "../runtime/jsfx/parser";
import { parseRVideo } from "../runtime/rvideo/parser";
import { getLocalPluginSpecs } from "./localPlugins";

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

export type PlatformTarget = "browser" | "native";

export interface ObjectSpec {
  description: string;
  category: "ui" | "control" | "audio" | "scripting" | "visual";
  args: ArgDef[];
  messages: MessageDef[];
  inlets: PortDef[];
  outlets: PortDef[];
  defaultWidth: number;
  defaultHeight: number;
  /**
   * Which platforms this object is available on.
   * Omit (or set to both) for objects that work everywhere.
   * Objects tagged ["native"] only are hidden in the browser build's palette,
   * autocomplete, and terminal — and render as a placeholder if loaded.
   */
  platforms?: PlatformTarget[];
  /**
   * Alternative type keywords (e.g. "trigger" for "t").
   * These are auto-registered in TYPE_ALIASES at module init.
   */
  keywords?: string[];
  /**
   * Derive dynamic ports from creation arguments.
   * Set on objects whose port count/types depend on args
   * (sequencer, adc~, dac~, mixer~, fft~, js~, buffer~,
   *  reaperVideo*, pack, unpack, route, t, subPatch).
   * Called with the node's creation args; overrides static inlets/outlets.
   */
  derivePorts?: (args: string[]) => { inlets: PortDef[]; outlets: PortDef[] };
  /**
   * Fill missing positional creation args with defaults.
   * Set on objects with sparse args that must be contiguous for
   * serialization (sequencer, buffer~).
   */
  ensureArgs?: (args: string[]) => string[];
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

  f: {
    description: "Float storage box (Max-style). Cold inlet stores a value; bang on the hot inlet outputs the stored value.",
    category: "control",
    args: [{ name: "value", type: "float", default: "0", description: "Stored float value." }],
    messages: [
      { inlet: 0, selector: "bang",  description: "output stored value" },
      { inlet: 0, selector: "float", description: "store and output" },
      { inlet: 0, selector: "int",   description: "store and output" },
      { inlet: 1, selector: "float", description: "store value (cold — no output)" },
      { inlet: 1, selector: "int",   description: "store value (cold — no output)" },
    ],
    inlets: [
      { index: 0, type: "bang",  label: "bang: output  |  float: store + output", temperature: "hot"  },
      { index: 1, type: "float", label: "store value (no output)",                 temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "float", label: "stored float value" }],
    defaultWidth:  40,
    defaultHeight: 28,
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
        derivePorts: deriveTriggerPorts,
        keywords: ["trigger"],
  },

  prepend: {
    description: "Prepends its creation args to any incoming message. e.g. `prepend range` + input `0.0 1.0` → emits `range 0.0 1.0`. `set <atoms>` replaces the stored list silently.",
    category: "control",
    args: [{ name: "atoms", type: "list", description: "Atoms to prepend to incoming messages." }],
    messages: [
      { inlet: 0, selector: "bang", description: "emit stored list followed by 'bang'" },
      { inlet: 0, selector: "any",  description: "emit stored list followed by incoming atoms" },
      { inlet: 0, selector: "set",  description: "replace stored list without output: set <atoms>" },
    ],
    inlets:  [{ index: 0, type: "message", label: "message in (set <…> updates silently)", temperature: "hot" }],
    outlets: [{ index: 0, type: "message", label: "stored + input" }],
    defaultWidth:  100,
    defaultHeight: 28,
  },

  append: {
    description: "Appends its creation args to any incoming message. e.g. `append done` + input `5` → emits `5 done`. `set <atoms>` replaces the stored list silently.",
    category: "control",
    args: [{ name: "atoms", type: "list", description: "Atoms to append to incoming messages." }],
    messages: [
      { inlet: 0, selector: "bang", description: "emit stored list" },
      { inlet: 0, selector: "any",  description: "emit incoming atoms followed by stored list" },
      { inlet: 0, selector: "set",  description: "replace stored list without output: set <atoms>" },
    ],
    inlets:  [{ index: 0, type: "message", label: "message in (set <…> updates silently)", temperature: "hot" }],
    outlets: [{ index: 0, type: "message", label: "input + stored" }],
    defaultWidth:  100,
    defaultHeight: 28,
  },

  pack: {
    description: "Pack values from N inlets into a single space-separated message. Args define slot count and initial values: letters i/f → init 0, s/l → init empty, any literal becomes the initial slot value. Inlet 0 is hot (triggers output); inlets 1..N-1 are cold (store only). Default args: f f.",
    category: "control",
    args: [{ name: "slots", type: "list", description: "Per-slot type letter (i/f/s/l) or literal initial value." }],
    messages: [
      { inlet: 0, selector: "bang", description: "emit current slot values" },
      { inlet: 0, selector: "any",  description: "store in slot 0 and emit all slots" },
    ],
    inlets:  [
      { index: 0, type: "any", label: "slot 0 (hot)",  temperature: "hot" },
      { index: 1, type: "any", label: "slot 1 (cold)", temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "message", label: "packed list" }],
    defaultWidth:  80,
    defaultHeight: 40,
        derivePorts: derivePackPorts,
  },

  unpack: {
    description: "Distribute atoms from an incoming list to N outlets — atom i emits from outlet i, in right-to-left order (Max convention). Args define slot count, output type, and initial stored value: i/f → 0, s/l → empty, any literal becomes the initial value. `bang` re-emits stored values; `set <atoms>` updates stored values silently. Default args: f f.",
    category: "control",
    args: [{ name: "slots", type: "list", description: "Per-slot type letter (i/f/s/l) or literal initial value." }],
    messages: [
      { inlet: 0, selector: "bang", description: "emit stored slot values right-to-left" },
      { inlet: 0, selector: "any",  description: "store atoms positionally and emit each from its outlet (right-to-left)" },
      { inlet: 0, selector: "set",  description: "replace stored values without output: set <atoms>" },
    ],
    inlets:  [{ index: 0, type: "any", label: "list in (hot)", temperature: "hot" }],
    outlets: [
      { index: 0, type: "float", label: "slot 0" },
      { index: 1, type: "float", label: "slot 1" },
    ],
    defaultWidth:  80,
    defaultHeight: 40,
        derivePorts: deriveUnpackPorts,
  },

  route: {
    description: "Route messages by matching the first atom against creation args. N args produce N+1 outlets; the rightmost is the reject outlet for unmatched input. On a literal match (symbol or number) the matched atom is stripped — single-atom matches emit `bang`, multi-atom matches emit the remainder. Type-keyword args (`int`, `float`, `symbol`, `list`, `bang`) match by message type and pass the value through unchanged. `set <atoms>` replaces the matchers silently. Default args: 1 2.",
    category: "control",
    args: [{ name: "matchers", type: "list", description: "Selectors to match. Type keywords (int/float/symbol/list/bang) match by type; everything else is a literal symbol/numeric match." }],
    messages: [
      { inlet: 0, selector: "any",  description: "match first atom against args; emit remainder from matching outlet (or full input from reject outlet)" },
      { inlet: 0, selector: "bang", description: "match against `bang` arg if present; otherwise emit bang from reject outlet" },
      { inlet: 0, selector: "set",  description: "replace stored matchers without output: set <atoms>" },
    ],
    inlets:  [{ index: 0, type: "any", label: "message in (hot)", temperature: "hot" }],
    outlets: [
      { index: 0, type: "message", label: "match: 1" },
      { index: 1, type: "message", label: "match: 2" },
      { index: 2, type: "message", label: "rejected (no match)" },
    ],
    defaultWidth:  100,
    defaultHeight: 40,
        derivePorts: deriveRoutePorts,
  },

  scale: {
    description: "Maps a number from one range to another (linear interpolation). If both output bounds are written without a decimal point (e.g. 0 and 127), the output is rounded to an integer; if either has a dot (e.g. 0. or 1.0), the output is float.",
    category: "control",
    args: [
      { name: "inLow",  type: "float", default: "0",   description: "Input range low." },
      { name: "inHigh", type: "float", default: "1",   description: "Input range high." },
      { name: "outLow", type: "float", default: "0",   description: "Output range low. Int-form (no dot) makes output integer." },
      { name: "outHigh",type: "float", default: "127", description: "Output range high. Int-form (no dot) makes output integer." },
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

  ezScale: {
    description: "GUI scale object: type input/output bounds in the four fields, then drag the dual-handle range slider to pinch the active output sub-range. Input/output mapping is linear. Int-form output bounds (no dot) round the output to integers. The [~] toolbar button cycles a smoothing curve (off/linear/exponential/logarithmic/s-curve); ms field sets the smoothing time.",
    category: "ui",
    args: [
      { name: "inMin",  type: "float", default: "0",   description: "Input range low." },
      { name: "inMax",  type: "float", default: "1",   description: "Input range high." },
      { name: "outMin", type: "float", default: "0",   description: "Output bound low. Int-form (no dot) rounds output to int." },
      { name: "outMax", type: "float", default: "127", description: "Output bound high. Int-form (no dot) rounds output to int." },
      { name: "outLo",  type: "float", default: "0",   hidden: true, description: "Active output range low (slider lo handle)." },
      { name: "outHi",  type: "float", default: "127", hidden: true, description: "Active output range high (slider hi handle)." },
      { name: "auto",   type: "int",   default: "1",   hidden: true, description: "1 = auto-detect input bounds from incoming values and auto-set output bounds from connected target arg's min/max. Toggle with the [auto] button." },
      { name: "mult",   type: "float", default: "1",   hidden: true, description: "Pre-scale multiplier — incoming values are multiplied by this before being mapped through inMin..inMax." },
      { name: "collapsed",      type: "int", default: "0", hidden: true, description: "1 = body collapsed to toolbar + slider; field controls hidden." },
      { name: "expandedHeight", type: "int", default: "0", hidden: true, description: "Saved body height (px) so re-expanding restores the user's previous size." },
      { name: "inverted",       type: "int", default: "0", hidden: true, description: "1 = output bounds inverted (low maps to outMax, high maps to outMin). Auto-output respects this." },
      { name: "smooth",         type: "int", default: "0", hidden: true, description: "Smoothing curve: 0=none (instant), 1=linear slew, 2=exponential one-pole, 3=logarithmic, 4=s-curve (smoothstep)." },
      { name: "smoothMs",       type: "float", default: "100", hidden: true, description: "Smoothing time (ms). For exponential this is the time constant τ (output reaches ~63% in τ ms, ~99% in 5τ). For linear/log/s-curve it is the full traversal time." },
    ],
    messages: [
      { inlet: 0, selector: "float", description: "map value (using active slider sub-range) and output result" },
      { inlet: 1, selector: "float", description: "set input min" },
      { inlet: 2, selector: "float", description: "set input max" },
      { inlet: 3, selector: "float", description: "set output bound min (clamps active range)" },
      { inlet: 4, selector: "float", description: "set output bound max (clamps active range)" },
      { inlet: 5, selector: "float", description: "set active sub-range low (lo slider handle); clamps to bounds" },
      { inlet: 6, selector: "float", description: "set active sub-range high (hi slider handle); clamps to bounds" },
      { inlet: 7, selector: "int",   description: "set smoothing curve: 0=none, 1=linear, 2=exponential, 3=logarithmic, 4=s-curve" },
      { inlet: 8, selector: "float", description: "set smoothing time in ms (must be > 0; treated as 0 = instant when ≤ 0)" },
      { inlet: 9, selector: "float", description: "set pre-scale multiplier (incoming values are multiplied by this before mapping)" },
    ],
    inlets: [
      { index: 0, type: "float", label: "value to scale",   temperature: "hot" },
      { index: 1, type: "float", label: "input min",        temperature: "cold" },
      { index: 2, type: "float", label: "input max",        temperature: "cold" },
      { index: 3, type: "float", label: "output bound min", temperature: "cold" },
      { index: 4, type: "float", label: "output bound max", temperature: "cold" },
      { index: 5, type: "float", label: "active range lo (slider lo handle)", temperature: "cold" },
      { index: 6, type: "float", label: "active range hi (slider hi handle)", temperature: "cold" },
      { index: 7, type: "float", label: "smoothing mode (0=off, 1=lin, 2=exp, 3=log, 4=s)", temperature: "cold" },
      { index: 8, type: "float", label: "smoothing time (ms)",                              temperature: "cold" },
      { index: 9, type: "float", label: "pre-scale multiplier",                             temperature: "cold" },
    ],
    outlets: [
      { index: 0, type: "float", label: "scaled value (active sub-range)" },
      { index: 1, type: "message",  label: "range [lo hi]" },
    ],
    defaultWidth: 220,
    defaultHeight: 142,
  },

  ezSlider: {
    description: "Slider with named endpoints: type lo/hi values above each end, drag the thumb to interpolate. Int-form bounds (no dot) round output to integers.",
    category: "ui",
    args: [
      { name: "lo",    type: "float", default: "0",   description: "Left-end value." },
      { name: "hi",    type: "float", default: "1",   description: "Right-end value." },
      { name: "value", type: "float", default: "0.5", hidden: true, description: "Thumb position (0–1)." },
    ],
    messages: [
      { inlet: 0, selector: "float", description: "set slider value (in [lo, hi]) and output it; values outside the range clamp to lo/hi" },
      { inlet: 1, selector: "float", description: "set lo bound" },
      { inlet: 2, selector: "float", description: "set hi bound" },
    ],
    inlets: [
      { index: 0, type: "float", label: "value in [lo, hi]",     temperature: "hot"  },
      { index: 1, type: "float", label: "lo bound",              temperature: "cold" },
      { index: 2, type: "float", label: "hi bound",              temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "float", label: "interpolated value" }],
    defaultWidth: 180,
    defaultHeight: 60,
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

  drunk: {
    description: "Random walk (drunk walk) — each bang steps ±step from current, clamped to [0, max).",
    category: "control",
    args: [
      { name: "max",     type: "int", default: "128", min: 1, max: 32767, step: 1, description: "Upper bound (exclusive); output range 0 to max−1." },
      { name: "step",    type: "int", default: "10",  min: 1, max: 1000,  step: 1, description: "Maximum step size per bang." },
      { name: "current", type: "int", default: "0",   hidden: true,                description: "Current walk position." },
    ],
    messages: [
      { inlet: 0, selector: "bang",  description: "step and output" },
      { inlet: 0, selector: "int",   description: "set current value and output" },
      { inlet: 0, selector: "float", description: "set current value (truncated) and output" },
      { inlet: 0, selector: "set",   description: "store without outputting: set <n>" },
      { inlet: 1, selector: "int",   description: "set step size" },
      { inlet: 1, selector: "float", description: "set step size (truncated to int)" },
    ],
    inlets: [
      { index: 0, type: "any",   label: "bang: step | int: set + output | set <n>: store only", temperature: "hot"  },
      { index: 1, type: "any",   label: "step size",                                              temperature: "cold" },
    ],
    outlets: [{ index: 0, type: "float", label: "current walk value" }],
    defaultWidth: 100,
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

  "noise~": {
    description: "Continuous procedural noise source. Outputs white, pink, or brown noise at audio rate.",
    category: "audio",
    args: [
      { name: "color", type: "symbol", default: "white",
        description: "Noise color: white, pink, or brown." },
      { name: "level", type: "float", default: "0.25", min: 0, max: 1, step: 0.001,
        description: "Output level (linear 0..1)." },
    ],
    messages: [
      { inlet: 0, selector: "color", description: "color white|pink|brown — choose the noise spectrum" },
      { inlet: 0, selector: "level", description: "level <0..1> — set output level" },
    ],
    inlets: [
      { index: 0, type: "any", label: "color white|pink|brown | level <0..1>" },
    ],
    outlets: [
      { index: 0, type: "signal", label: "noise signal out" },
    ],
    defaultWidth: 140,
    defaultHeight: 110,
  },

  "adsr~": {
    description: "ADSR envelope generator. Multiplies the input signal by an attack/decay/sustain-hold/release envelope. Bang to one-shot fire; float 1/0 for gate mode. Drag the handles in the body to shape the envelope.",
    category: "audio",
    args: [
      { name: "attack", type: "float", default: "50", min: 0, max: 10000, step: 0.1,
        description: "Attack time in ms (0 → peak)." },
      { name: "decay", type: "float", default: "100", min: 0, max: 10000, step: 0.1,
        description: "Decay time in ms (peak → sustain level)." },
      { name: "sustain", type: "float", default: "0.7", min: 0, max: 1, step: 0.001,
        description: "Sustain level 0..1." },
      { name: "release", type: "float", default: "200", min: 0, max: 10000, step: 0.1,
        description: "Release time in ms (sustain → 0)." },
      { name: "sustainTime", type: "float", default: "200", min: 0, max: 10000, step: 0.1,
        description: "Sustain hold time in ms (length of the sustain plateau before release begins, in one-shot mode)." },
      { name: "locked", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Lock state: 1 = handles inert and body draggable from anywhere; 0 = handles interactive." },
    ],
    messages: [
      { inlet: 1, selector: "bang",        description: "fire envelope one-shot: A → D → hold sustain → R" },
      { inlet: 1, selector: "float",       description: "1 = gate-on (A → D → sustain held until 0); 0 = gate-off (release from current)" },
      { inlet: 1, selector: "attack",      description: "attack <ms>  — set attack time" },
      { inlet: 1, selector: "decay",       description: "decay <ms>   — set decay time" },
      { inlet: 1, selector: "sustain",     description: "sustain <0..1> — set sustain level" },
      { inlet: 1, selector: "release",     description: "release <ms> — set release time" },
      { inlet: 1, selector: "sustainTime", description: "sustainTime <ms> — set sustain hold duration (one-shot mode)" },
    ],
    inlets: [
      { index: 0, type: "signal", label: "audio in" },
      { index: 1, type: "any",    label: "bang = one-shot | float 1/0 = gate | attack/decay/sustain/sustainTime/release <v>" },
    ],
    outlets: [
      { index: 0, type: "signal", label: "audio × envelope out" },
      { index: 1, type: "bang",   label: "fires when one-shot envelope completes (for chaining)" },
    ],
    defaultWidth: 180,
    defaultHeight: 120,
  },

  "transientFollower~": {
    description: "Envelope follower + VCA. Uses the amplitude envelope of one signal (e.g. adc~) to shape the gain of another (e.g. wave~). Drop-in replacement for an adsr~ → *~ chain when the envelope should come from a real-world sound. The face shows a scrolling trace of the detected envelope.",
    category: "audio",
    args: [
      { name: "attack",      type: "float", default: "5",   min: 0.05, max: 10000, step: 0.01,
        description: "Envelope rise time in ms. Smaller = punchier transients." },
      { name: "release",     type: "float", default: "80",  min: 0.05, max: 10000, step: 0.1,
        description: "Envelope fall time in ms. Larger = sustained sounds bleed through." },
      { name: "sensitivity", type: "float", default: "1",   min: 0,    max: 64,    step: 0.01,
        description: "Pre-detection input gain. Boost a quiet mic so transients register." },
      { name: "floor",       type: "float", default: "0",   min: 0,    max: 1,     step: 0.001,
        description: "Envelope clamps to 0 below this threshold. Cuts room noise." },
    ],
    messages: [
      { inlet: 0, selector: "attack",      description: "attack <ms>     — set envelope rise time-constant" },
      { inlet: 0, selector: "release",     description: "release <ms>    — set envelope fall time-constant" },
      { inlet: 0, selector: "sensitivity", description: "sensitivity <v> — set pre-detection input gain (0..64)" },
      { inlet: 0, selector: "floor",       description: "floor <0..1>    — set noise-gate threshold" },
    ],
    inlets: [
      { index: 0, type: "signal", label: "source signal (carrier to be shaped)" },
      { index: 1, type: "signal", label: "shape source (envelope detection input)" },
    ],
    outlets: [
      { index: 0, type: "signal", label: "shaped audio out (source × envelope)" },
      { index: 1, type: "signal", label: "envelope signal out (audio-rate)" },
    ],
    defaultWidth: 200,
    defaultHeight: 140,
  },

  "wave~": {
    description: "Morphing wave generator. Crossfades sine → triangle → saw → square via the morph knob/CV. Gated: silent until inlet 2 receives a 1. Built-in scope shows a still preview of the output shape.",
    category: "audio",
    args: [
      { name: "freq", type: "float", default: "220", min: 0, max: 20000, step: 0.01,
        description: "Base frequency in Hz." },
      { name: "morph", type: "float", default: "0", min: 0, max: 1, step: 0.001,
        description: "Wave-shape morph position. 0 = sine, 0.333 = triangle, 0.666 = saw, 1 = square (crossfaded)." },
      { name: "level", type: "float", default: "0.5", min: 0, max: 1, step: 0.001,
        description: "Output level (linear 0..1) when the gate is open." },
      { name: "locked", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Lock state: 1 = controls inert and object draggable from anywhere; 0 = knobs interactive." },
    ],
    messages: [
      { inlet: 0, selector: "freq",  description: "freq <hz>     — set base frequency in Hz" },
      { inlet: 0, selector: "morph", description: "morph <0..1>  — set wave-shape morph position" },
      { inlet: 0, selector: "level", description: "level <0..1>  — set output level (linear)" },
      { inlet: 0, selector: "gate",  description: "gate <0|1>    — close (mute) or open the audio gate" },
      { inlet: 2, selector: "float", description: "1 = open the gate (sound on), 0 = close (mute)" },
      { inlet: 2, selector: "gate",  description: "gate <0|1>    — same as bare float" },
    ],
    inlets: [
      { index: 0, type: "signal", label: "freq CV (Hz, summed onto base)" },
      { index: 1, type: "signal", label: "morph CV (added to morph, clamped 0..1)" },
      { index: 2, type: "any",    label: "gate (1 = on, 0 = off) — silent until opened" },
    ],
    outlets: [
      { index: 0, type: "signal", label: "wave out" },
    ],
    defaultWidth: 160,
    defaultHeight: 200,
  },

  "lfo~": {
    description: "Low-frequency oscillator for modulation. Outputs a slow wave signal (0.01–20 Hz) used to modulate frequency, amplitude, or other parameters. Connect outlet 0 to wave~ inlet 0 (FM), wave~ inlet 1 (morph), or adsr~ inlet 0 (tremolo).",
    category: "audio",
    args: [
      { name: "rate",   type: "float", default: "1",   min: 0.01, max: 20,   step: 0.01,  description: "LFO rate in Hz (0.01–20)." },
      { name: "depth",  type: "float", default: "100", min: 0,    max: 1000, step: 0.1,   description: "Peak output amplitude (dimensionless scale). For FM into wave~ freq CV: keep < base_freq to avoid negative frequencies (e.g. 100 at 220 Hz). For morph CV: use ≤ 1.0." },
      { name: "shape",  type: "float", default: "0",   min: 0,    max: 1,    step: 0.001, description: "Wave shape: 0 = sine, 0.333 = triangle, 0.667 = saw, 1 = square (crossfaded)." },
      { name: "locked", type: "int",   default: "0",   min: 0,    max: 1,    step: 1, hidden: true,
        description: "Lock state: 1 = controls inert and object draggable from anywhere; 0 = knobs interactive." },
    ],
    messages: [
      { inlet: 0, selector: "rate",  description: "rate <hz>     — set LFO rate (0.01–20 Hz)" },
      { inlet: 0, selector: "depth", description: "depth <v>    — set peak output amplitude (≤ base_freq for FM; ≤ 1.0 for morph CV)" },
      { inlet: 0, selector: "shape", description: "shape <0..1>  — set wave shape (0=sine, 0.333=tri, 0.667=saw, 1=square)" },
    ],
    inlets: [
      { index: 0, type: "any",    label: "rate <hz> | depth <v> | shape <0..1>" },
      { index: 1, type: "signal", label: "rate CV (Hz, summed onto base rate)" },
    ],
    outlets: [
      { index: 0, type: "signal", label: "LFO signal out (peak ≈ ±depth)" },
    ],
    defaultWidth: 160,
    defaultHeight: 180,
  },

  "dac~": {
    description: "Audio output sink. Optional arg sets channel count (1–32) — defaults to stereo. Right-click → 'Rebuild from device' to match the system output device. Double-click to open the audio configuration panel.",
    category: "audio",
    args: [
      { name: "channels", type: "int", default: "2", min: 1, max: 32, step: 1,
        description: "Output channel count (1–32). One inlet per channel; channel N maps to physical output N." },
    ],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [],
    defaultWidth: 80,
    defaultHeight: 64,
        derivePorts: deriveDacPorts,
  },

  "fft~": {
    description: "FFT spectrum analyzer. Displays a spectrogram and outputs N band levels. Arg: band count (4, 8, or 16 — default 4).",
    category: "audio",
    args: [
      { name: "bands", type: "int", default: "4",
        description: "Number of frequency bands to output: 4, 8, or 16." },
    ],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [
      { index: 0, type: "float", label: "low (20–250 Hz) · level 0–1, useful ~0.0–0.5 (set ezScale in max ~0.4)" },
      { index: 1, type: "float", label: "low-mid (250–2k Hz) · level 0–1, useful ~0.0–0.5" },
      { index: 2, type: "float", label: "hi-mid (2k–6k Hz) · level 0–1, useful ~0.0–0.4" },
      { index: 3, type: "float", label: "hi (6k–20k Hz) · level 0–1, useful ~0.0–0.3" },
    ],
    defaultWidth:  160,
    defaultHeight: 200,
        derivePorts: deriveFftPorts,
  },

  "spectral~": {
    description: "Spectral feature analyzer. Extracts audio descriptors from the live spectrum for mapping to video effects. Outlet 0 = overall level (more descriptors added in later build steps).",
    category: "audio",
    args: [],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [
      { index: 0, type: "float", label: "level — overall energy · range 0–1, useful ~0.0–0.3 (set ezScale in max ~0.25)" },
      { index: 1, type: "float", label: "centroid — brightness (log-normalized) · range 0–1, useful ~0.2–0.7 for voice (set ezScale in 0.2–0.7)" },
      { index: 2, type: "float", label: "flux — spectral change / onsets · range 0–1, peaks ~0.02–0.15 (set ezScale in max ~0.1)" },
      { index: 3, type: "float", label: "flatness — tonal↔noisy · range 0–1, useful ~0.0–0.5 (tone≈0, hiss/noise→high; set ezScale in max ~0.4)" },
      { index: 4, type: "float", label: "rolloff — 85% energy freq (dark↔bright, log) · range 0–1, useful ~0.2–0.8 (set ezScale in 0.2–0.8)" },
      { index: 5, type: "float", label: "crest — peakiness (pure tone→high, noise→low) · range 0–1, useful ~0.2–0.9 (set ezScale in 0.2–0.9)" },
      { index: 6, type: "float", label: "loudness — A-weighted (perceived level) · range 0–1, useful ~0.0–0.3 (set ezScale in max ~0.25)" },
    ],
    defaultWidth:  160,
    defaultHeight: 220,
  },

  "env~": {
    description: "Envelope follower. Outputs a smoothed RMS amplitude of the input with tunable attack/release ballistics — a clean VU-style control signal for driving video params. Args: attack ms, release ms.",
    category: "audio",
    args: [
      { name: "attack",  type: "float", default: "10",  min: 0, max: 1000, step: 1,
        description: "Attack time (ms) — how fast the envelope rises toward louder input." },
      { name: "release", type: "float", default: "200", min: 0, max: 5000, step: 1,
        description: "Release time (ms) — how slowly the envelope falls after the input drops." },
    ],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [
      { index: 0, type: "float", label: "envelope — smoothed RMS · range 0–1, useful ~0.0–0.4 (set ezScale in max ~0.3)" },
    ],
    defaultWidth:  120,
    defaultHeight: 64,
  },

  "beat~": {
    description: "Beat / tempo tracker. SuperFlux onset envelope → autocorrelation tempo with a decaying histogram lock → onset-locked beat-phase PLL. Outputs BPM, beat phase, a beat bang, and a confidence value. Works best on steady rhythmic material.",
    category: "audio",
    args: [
      { name: "tightness", type: "float", default: "1", min: 0.1, max: 8, step: 0.05,
        description: "Tempo rigidity. Higher = bangs lock rigidly to the estimated tempo; lower = phase chases onsets more (more reactive but looser)." },
      { name: "division", type: "int", default: "2", hidden: true,
        description: "Output note value (set via the body button): 0=whole, 1=half, 2=quarter (beat), 3=eighth, 4=sixteenth." },
    ],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [
      { index: 0, type: "float", label: "tempo (BPM) · ~60–180, locked/held (ezScale to taste)" },
      { index: 1, type: "float", label: "beat phase · 0–1 ramp, resets to 0 on each beat (drive pulsing/easing)" },
      { index: 2, type: "bang",  label: "beat · bang on each beat (→ trigger flashes / scene cuts)" },
      { index: 3, type: "float", label: "confidence · 0–1 dominance of the locked tempo (gate visuals with > when low)" },
    ],
    defaultWidth:  130,
    defaultHeight: 76,
  },

  "chroma~": {
    description: "Chroma analyzer. Folds the spectrum into the 12 pitch classes (C..B), octave-wrapped, for harmonic / chord-aware visuals. Each outlet is one pitch class (0–1, per-frame normalized); the last outlet is the dominant pitch-class index (0–11, −1 when silent).",
    category: "audio",
    args: [],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [
      { index: 0,  type: "float", label: "C — pitch-class energy · 0–1 (per-frame, strongest class = 1)" },
      { index: 1,  type: "float", label: "C# — pitch-class energy · 0–1" },
      { index: 2,  type: "float", label: "D — pitch-class energy · 0–1" },
      { index: 3,  type: "float", label: "D# — pitch-class energy · 0–1" },
      { index: 4,  type: "float", label: "E — pitch-class energy · 0–1" },
      { index: 5,  type: "float", label: "F — pitch-class energy · 0–1" },
      { index: 6,  type: "float", label: "F# — pitch-class energy · 0–1" },
      { index: 7,  type: "float", label: "G — pitch-class energy · 0–1" },
      { index: 8,  type: "float", label: "G# — pitch-class energy · 0–1" },
      { index: 9,  type: "float", label: "A — pitch-class energy · 0–1" },
      { index: 10, type: "float", label: "A# — pitch-class energy · 0–1" },
      { index: 11, type: "float", label: "B — pitch-class energy · 0–1" },
      { index: 12, type: "float", label: "dominant pitch class · 0–11 (C=0…B=11), −1 when silent (×30 for hue°)" },
    ],
    defaultWidth:  200,
    defaultHeight: 120,
  },

  "pitch~": {
    description: "Pitch detector. Estimates the fundamental frequency (Hz) of the input via autocorrelation, plus a confidence value. Best on monophonic / clearly-pitched material (voice, single instrument).",
    category: "audio",
    args: [],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [
      { index: 0, type: "float", label: "frequency — fundamental pitch (Hz) · voice ~80–1000 Hz; held when unvoiced (ezScale to taste, e.g. in 80–800)" },
      { index: 1, type: "float", label: "confidence — pitch clarity · range 0–1, clear pitch ~0.7–1.0 (gate downstream with > when low)" },
    ],
    defaultWidth:  130,
    defaultHeight: 76,
  },

  "adc~": {
    description: "Audio input source. Captures from the selected input device. Optional arg sets channel count (1–32) — defaults to stereo. Right-click → 'Rebuild from device' to match the system input device. Double-click to open the audio configuration panel.",
    category: "audio",
    args: [
      { name: "channels", type: "int", default: "2", min: 1, max: 32, step: 1,
        description: "Input channel count (1–32). One outlet per channel; channel N maps to physical input N." },
    ],
    messages: [],
    inlets: [],
    outlets: [
      { index: 0, type: "signal", label: "left channel out" },
      { index: 1, type: "signal", label: "right channel out" },
    ],
    defaultWidth: 80,
    defaultHeight: 64,
        derivePorts: deriveAdcPorts,
  },

  "browser~*": {
    description: "Live browser tab mirror. Click a site chip to open it in a new browser tab; pick that tab in the capture prompt to mirror it here and route its audio (L/R) + video to the patch.",
    category: "audio",
    args: [
      { name: "lastSite", type: "symbol", default: "", hidden: true,
        description: "Last site chip the user clicked. Persisted for future 'resume last' UX." },
      { name: "captureOnLoad", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Reserved: set when a capture was active at save time." },
    ],
    messages: [
      { inlet: 0, selector: "release", description: "stop mirroring" },
    ],
    inlets:  [{ index: 0, type: "any", label: "release" }],
    outlets: [
      { index: 0, type: "signal", label: "audio L" },
      { index: 1, type: "signal", label: "audio R" },
      { index: 2, type: "media",  label: "video out (→ layer / vFX)" },
    ],
    defaultWidth: 480,
    defaultHeight: 320,
  },

  "youtube~*": {
    description: "Embedded YouTube player. Paste a YouTube URL; the embed plays in the body. Outputs L/R audio + video to the patch via user-approved tab capture (getDisplayMedia). The in-panel iframe is preview-only — to route audio + video through the patch, click 'Open in tab' then 'Capture' and pick that tab.",
    category: "audio",
    args: [
      { name: "url", type: "symbol", default: "",
        description: "YouTube URL (watch / share / embed / shorts / mobile forms accepted)." },
      { name: "videoId", type: "symbol", default: "", hidden: true,
        description: "Parsed 11-char video id. Derived from url; persisted for fast reload." },
      { name: "startSeconds", type: "int", default: "0", min: 0, hidden: true,
        description: "Start offset in seconds (parsed from ?t= / ?start=)." },
      { name: "captureOnLoad", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Reserved: set when a capture was active at save time." },
      { name: "locked", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Lock state: 1 = panel inert and object draggable from anywhere; 0 = panel interactive (URL field + buttons clickable). Defaults unlocked because a fresh youtube~ needs a URL pasted into the field as its first interaction." },
    ],
    messages: [
      { inlet: 0, selector: "url",     description: "url <youtube-url> — load a different video" },
      { inlet: 0, selector: "release", description: "stop mirroring" },
    ],
    inlets:  [{ index: 0, type: "any", label: "url / release" }],
    outlets: [
      { index: 0, type: "signal", label: "audio L" },
      { index: 1, type: "signal", label: "audio R" },
      { index: 2, type: "media",  label: "video out (→ layer / vFX)" },
    ],
    defaultWidth: 480,
    defaultHeight: 360,
  },

  "mixer~": {
    description: "N-channel audio mixer. Sums N mono signal inlets to a stereo bus with per-channel gain and pan sliders.",
    category: "audio",
    args: [
      { name: "channels", type: "int", default: "4", min: 1, max: 32, step: 1,
        description: "Channel count (1–32). Sets the number of signal inlets and strips." },
      { name: "gains", type: "symbol", default: "", hidden: true,
        description: "Per-channel gain values, comma-separated floats 0..1." },
      { name: "pans", type: "symbol", default: "", hidden: true,
        description: "Per-channel pan values, comma-separated floats 0..1 (0.5 = center)." },
      { name: "locked", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Lock state: 1 = object draggable (controls disabled); 0 = controls interactive." },
      { name: "links", type: "symbol", default: "", hidden: true,
        description: "Per-channel link targets, comma-separated integers (-1 = unlinked). Linked pairs gang their gain faders." },
    ],
    messages: [
      { inlet: 0, selector: "gain",  description: "gain <ch> <float>  — set channel (1-indexed) gain 0..1" },
      { inlet: 0, selector: "pan",   description: "pan <ch> <float>   — set channel (1-indexed) pan 0..1" },
      { inlet: 0, selector: "reset", description: "reset all gains to 0.75 and pans to 0.5" },
    ],
    inlets: [
      { index: 0, type: "signal", label: "ch 1 in" },
      { index: 1, type: "signal", label: "ch 2 in" },
      { index: 2, type: "signal", label: "ch 3 in" },
      { index: 3, type: "signal", label: "ch 4 in" },
    ],
    outlets: [
      { index: 0, type: "signal", label: "sum L" },
      { index: 1, type: "signal", label: "sum R" },
    ],
    defaultWidth: 180,
    defaultHeight: 140,
        derivePorts: deriveMixerPorts,
  },

  "vbuf*": {
    description: "Video tape-recorder buffer. Records the upstream video source to a local OPFS file (WebM), plays it back at variable rate, with loop and a sub-range window. Same transport / range / loop / maxLen UX as buffer~.",
    category: "visual",
    args: [
      { name: "rate",   type: "float",  default: "1", min: 0.0625, max: 16, step: 0.01,
        description: "Playback rate. 1.0 = normal, 2.0 = double speed. Forward only for now. Browser-clamped to [0.0625, 16]." },
      { name: "loop",   type: "int",    default: "0", min: 0, max: 1, step: 1,
        description: "Loop mode: 1 = loop, 0 = stop at end." },
      { name: "maxLen", type: "float",  default: "60", min: 1, max: 600, step: 1,
        description: "Maximum recording length in seconds (1–600). Default 1 min, max 10 min." },
      { name: "transport", type: "symbol", default: "stop", hidden: true,
        description: "Persisted transport state: record | play | pause | stop." },
      { name: "position",  type: "float",  default: "0",  hidden: true,
        description: "Persisted playback position (0.0–1.0)." },
      { name: "thumb",     type: "symbol", default: "", hidden: true,
        description: "Base64 micro-thumbnail of the first frame (≤4 KB). Lets the panel paint something useful before OPFS is opened." },
      { name: "rangeStart", type: "float", default: "0", hidden: true,
        description: "Persistent playback window start (normalized 0–1)." },
      { name: "rangeEnd",   type: "float", default: "0", hidden: true,
        description: "Persistent playback window end (normalized 0–1). end ≤ start ⇒ no range." },
      { name: "storageKey", type: "symbol", default: "", hidden: true,
        description: "OPFS storage key (= node id) pointing to the persisted WebM. Empty ⇒ no recording." },
    ],
    messages: [
      { inlet:  0, selector: "rate",   description: "set playback rate: rate <float>" },
      { inlet:  0, selector: "loop",   description: "set loop mode: loop 0|1" },
      { inlet:  0, selector: "maxLen", description: "set max recording length in seconds (clears buffer)" },
      { inlet: -1, selector: "record", description: "begin recording from the upstream video source" },
      { inlet: -1, selector: "play",   description: "begin playback; play <pos> starts at norm position; play <start> <end> plays a sub-range" },
      { inlet: -1, selector: "pause",  description: "pause transport (preserves position)" },
      { inlet: -1, selector: "stop",   description: "stop and rewind position to 0" },
      { inlet: -1, selector: "clear",  description: "erase the recording" },
      { inlet: -1, selector: "seek",   description: "jump to normalized position: seek <0.0–1.0>" },
      { inlet: -1, selector: "range",     description: "restrict playback (and looping) to a window: range <start> <end> in 0.0–1.0. End < 1 → window shifts to fit, preserving length." },
      { inlet: -1, selector: "loopStart", description: "move the loop window to start here, preserving length: loopStart <0.0–1.0>. Shifts to fit if it overshoots." },
      { inlet: -1, selector: "loopLen",   description: "resize the loop window, preserving start: loopLen <ms>. Matches outlet 6 units, so `outlet 6 → loopLen` round-trips." },
      { inlet: -1, selector: "float",     description: "shorthand for rate: incoming float sets rate directly" },
    ],
    inlets: [
      { index: 0, type: "media", label: "video in (record source)" },
      { index: 1, type: "any",   label: "record | play | pause | stop | rate f | loop 0|1 | range s e | loopStart s | loopLen ms", temperature: "hot" },
    ],
    outlets: [
      { index: 0, type: "media", label: "video out (playback)" },
      { index: 1, type: "float", label: "position (0.0–1.0)" },
      { index: 2, type: "bang",  label: "bang at range/loop end" },
      { index: 3, type: "float", label: "loopstart (0.0–1.0)" },
      { index: 4, type: "float", label: "loopend (0.0–1.0)" },
      { index: 5, type: "float", label: "duration (ms int — total media length, rate-independent)" },
      { index: 6, type: "float", label: "loopLen (ms — active loop window length)" },
    ],
    defaultWidth:  280,
    defaultHeight: 220,
  },

  "buffer~": {
    description: "Audio tape-recorder buffer. Records incoming signal, plays back at variable rate (negative = reverse), with loop and mono/stereo switching. Transport controls live on the body and as messages on the control inlet.",
    category: "audio",
    args: [
      { name: "mode",     type: "symbol", default: "stereo",
        description: "Channel mode: stereo or mono. Switching sums or duplicates audio." },
      { name: "rate",     type: "float",  default: "1", min: -8, max: 8, step: 0.01,
        description: "Playback rate. 1.0 = normal, -1.0 = reverse, 2.0 = double speed." },
      { name: "loop",     type: "int",    default: "0", min: 0, max: 1, step: 1,
        description: "Loop mode: 1 = loop, 0 = stop at end (or start when reversing)." },
      { name: "maxLen",   type: "float",  default: "180", min: 1, max: 3600, step: 1,
        description: "Maximum recording length in seconds (1–3600). Default 3 min, max 60 min." },
      { name: "transport",   type: "symbol", default: "stop", hidden: true,
        description: "Persisted transport state: record | play | pause | stop." },
      { name: "position",    type: "float",  default: "0",  hidden: true,
        description: "Persisted playback/record position (0.0–1.0)." },
      { name: "bufferL",     type: "symbol", default: "", hidden: true,
        description: "Base64-encoded Float32 PCM — left (or mono) channel." },
      { name: "bufferR",     type: "symbol", default: "", hidden: true,
        description: "Base64-encoded Float32 PCM — right channel (empty in mono mode)." },
      { name: "bufferLStereo", type: "symbol", default: "", hidden: true,
        description: "Preserved stereo-L when in mono mode; allows lossless mono→stereo restore." },
      { name: "bufferRStereo", type: "symbol", default: "", hidden: true,
        description: "Preserved stereo-R when in mono mode; allows lossless mono→stereo restore." },
      { name: "rangeStart", type: "float", default: "0", hidden: true,
        description: "Persistent playback window start (normalized 0–1)." },
      { name: "rangeEnd", type: "float", default: "0", hidden: true,
        description: "Persistent playback window end (normalized 0–1). end ≤ start ⇒ no range." },
      { name: "storageKey", type: "symbol", default: "", hidden: true,
        description: "OPFS storage key (= node id) pointing to the persisted PCM. Empty ⇒ no recording." },
    ],
    messages: [
      // Parameter setters declared on inlet 0 so the attribute object's
      // auto-formatter (`buildArgMessage`) emits "<name> <value>". Routing for
      // these accepts any inlet — see ObjectInteractionController buffer~ case.
      { inlet:  0, selector: "rate",   description: "set playback rate: rate <float> (negative = reverse)" },
      { inlet:  0, selector: "loop",   description: "set loop mode: loop 0|1" },
      { inlet:  0, selector: "maxLen", description: "set max recording length in seconds (clears buffer)" },
      // Transport + mode-switch on the control inlet only — keeps audio-rate
      // signal noise on inlets 0/1 from accidentally re-triggering record/etc.
      { inlet: -1, selector: "record", description: "begin recording (overwrites from position 0)" },
      { inlet: -1, selector: "play",   description: "begin playback from current position; play <pos> starts at norm position; play <start> <end> plays a sub-range" },
      { inlet: -1, selector: "pause",  description: "pause transport (preserves position)" },
      { inlet: -1, selector: "stop",   description: "stop and rewind position to 0" },
      { inlet: -1, selector: "stereo", description: "switch to stereo mode (changes port count)" },
      { inlet: -1, selector: "mono",   description: "switch to mono mode — sums channels; preserves originals" },
      { inlet: -1, selector: "clear",  description: "erase the buffer contents" },
      { inlet: -1, selector: "seek",   description: "jump to normalized position: seek <0.0–1.0>" },
      { inlet: -1, selector: "range",  description: "restrict playback (and looping) to a window: range <start> <end> in 0.0–1.0" },
      { inlet: -1, selector: "float",  description: "shorthand for rate: incoming float sets rate directly" },
    ],
    inlets:  [],   // derived by deriveBufferPorts(args)
    outlets: [],   // derived by deriveBufferPorts(args)
    defaultWidth:  280,
    defaultHeight: 110,
        derivePorts: deriveBufferPorts,
        ensureArgs: ensureBufferArgs,
  },

  "js~": {
    description: "JSFX-style audio effect. Paste REAPER JS-effect code; sliders populate the GUI; audio is processed sample-by-sample in an AudioWorklet.",
    category: "audio",
    args: [
      { name: "code", type: "symbol", default: "", hidden: true,
        description: "JSFX source. Base64-encoded on disk; raw at runtime." },
      { name: "library", type: "symbol", default: "", hidden: true,
        description: "Per-patch saved-effects library (JSON array of {name, code}, base64 on disk)." },
      { name: "locked", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Lock state: 1 = drag anywhere on body (code/dropdown disabled, sliders stay live); 0 = unlocked (default)." },
      { name: "sliderValues", type: "symbol", default: "", hidden: true,
        description: "Persisted slider state (JSON {sliderIndex:value}, base64 on disk). One left-side inlet is added per slider for external control." },
    ],
    messages: [],
    inlets: [
      { index: 0, type: "signal", label: "left channel in" },
      { index: 1, type: "signal", label: "right channel in" },
    ],
    outlets: [
      { index: 0, type: "signal", label: "left channel out" },
      { index: 1, type: "signal", label: "right channel out" },
    ],
    defaultWidth: 560,
    defaultHeight: 280,
        derivePorts: deriveJsEffectPorts,
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

  "visualizer*": {
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

  "imageFX*": {
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

  "frame*": {
    description: "Tab-region capture. Drag and resize this object on the canvas; the pixels inside its bounds are streamed out as video, ready for vFX / reaperVideo / layer. Uses the Region Capture API (Chrome / Edge only) — one share prompt per frame~ instance.",
    category: "visual",
    args: [
      { name: "captureOnLoad", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Reserved: set when capture was active at save time." },
    ],
    messages: [
      { inlet: 0, selector: "capture", description: "start capturing this frame's region" },
      { inlet: 0, selector: "release", description: "stop capturing" },
    ],
    inlets:  [{ index: 0, type: "any",   label: "capture | release" }],
    outlets: [{ index: 0, type: "media", label: "video out (→ layer / vFX / reaperVideo)" }],
    defaultWidth:  320,
    defaultHeight: 240,
  },

  "cam*": {
    description: "Camera / capture-device source. Outputs the selected videoinput device as live video, ready for vFX / reaperVideo / layer / vbuf. Click the object body to start; double-click to pick a device. Granted via getUserMedia (one OS prompt per origin).",
    category: "visual",
    args: [
      { name: "deviceId",    type: "symbol", default: "", hidden: true,
        description: "videoinput deviceId (per-origin stable). Restored on reload before deviceLabel." },
      { name: "deviceLabel", type: "symbol", default: "",
        description: "Human-readable device name shown in the text panel. Used as a fallback match when deviceId is missing or has changed." },
      { name: "width",       type: "int",    default: "0", min: 0, max: 7680, step: 1,
        description: "Requested capture width in pixels. 0 = let the browser/device pick." },
      { name: "height",      type: "int",    default: "0", min: 0, max: 4320, step: 1,
        description: "Requested capture height in pixels. 0 = let the browser/device pick." },
      { name: "active",      type: "int",    default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Reserved: set when the cam was running at save time." },
    ],
    messages: [
      { inlet: 0, selector: "bang",   description: "toggle capture on/off" },
      { inlet: 0, selector: "start",  description: "start capturing the selected device" },
      { inlet: 0, selector: "stop",   description: "stop capturing and release the device" },
      { inlet: 0, selector: "device", description: "switch device: device <id-or-label>" },
      { inlet: 0, selector: "open",   description: "open the device picker" },
    ],
    inlets:  [{ index: 0, type: "any",   label: "bang | start | stop | device <id|label> | open" }],
    outlets: [{ index: 0, type: "media", label: "video out (→ layer / vFX / reaperVideo / vbuf)" }],
    defaultWidth:  240,
    defaultHeight: 180,
  },

  "mediaVideo*": {
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

  "mediaImage*": {
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

  "layer*": {
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
      { name: "opacity",  type: "float",  default: "1",  min: 0,        max: 1,        step: 0.01,
        description: "Layer opacity. 1 = fully opaque, 0 = fully transparent." },
      { name: "rotX",    type: "float",  default: "0",  min: -3.14159, max: 3.14159,  step: 0.01,
        description: "Rotation around the X axis (horizontal tilt), in radians. Simulated as vertical perspective squash." },
      { name: "rotY",    type: "float",  default: "0",  min: -3.14159, max: 3.14159,  step: 0.01,
        description: "Rotation around the Y axis (left/right tilt), in radians. Simulated as horizontal perspective squash." },
      { name: "rotZ",    type: "float",  default: "0",  min: -3.14159, max: 3.14159,  step: 0.01,
        description: "Rotation around the Z axis (in-plane spin), in radians. Exact." },
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
      { inlet: 0, selector: "opacity",  description: "set layer opacity: opacity <float 0-1>" },
      { inlet: 0, selector: "rotX",     description: "set X-axis rotation (horizontal tilt): rotX <radians>" },
      { inlet: 0, selector: "rotY",     description: "set Y-axis rotation (left/right tilt): rotY <radians>" },
      { inlet: 0, selector: "rotZ",     description: "set Z-axis rotation (in-plane spin): rotZ <radians>" },
      { inlet: 0, selector: "rot",      description: "set all rotation axes at once: rot <rotX> <rotY> <rotZ>" },
    ],
    inlets:  [{ index: 0, type: "any", label: "media in  |  scaleX f  |  scaleY f  |  posX f  |  posY f  |  opacity f  |  rotX f  |  rotY f  |  rotZ f  |  priority n  |  context name" }],
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

  "vfxCRT*": {
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

  "shaderToy*": {
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

  "reaperVideo*": {
    description: "REAPER video-processor effect. Paste code from REAPER's video processor; @param declarations populate a knob GUI; video is processed per-frame using Canvas2D.",
    category: "visual",
    args: [
      { name: "code", type: "symbol", default: "", hidden: true,
        description: "REAPER video-processor source. Base64-encoded on disk; raw at runtime." },
      { name: "library", type: "symbol", default: "", hidden: true,
        description: "Per-patch saved-effects library (JSON array of {name, code}, base64 on disk)." },
      { name: "locked", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Lock state: 1 = drag anywhere on body (code/knobs disabled); 0 = unlocked (default)." },
      { name: "paramValues", type: "symbol", default: "", hidden: true,
        description: "Persisted knob state (JSON {paramName:value}, base64 on disk). One left-side inlet is added per //@param for external control." },
      { name: "maxRenderDim", type: "int", default: "360", min: 128, max: 4096, step: 1,
        description: "Max render dimension (px) — sources larger than this are downscaled before the frame fn runs. Default 360 hits ~57fps on gfx_evalrect-heavy presets (blurs) at 1080p sources. Raise for more detail at the cost of framerate (540=25fps, 720=14fps, 1080=6fps). Min 128 so the output canvas stays visible to downstream consumers." },
      { name: "wet", type: "float", default: "1", min: 0, max: 1, step: 0.01,
        description: "Wet/dry mix. 1.0 = pure effect (default), 0.0 = pure input (bypass), in between is a crossfade. Applied after the user's frame fn — independent of any //@param the script declares." },
    ],
    messages: [
      { inlet: 0, selector: "maxRenderDim", description: "set render cap: maxRenderDim <px> (0 = native resolution)" },
      { inlet: 0, selector: "wet",          description: "set wet/dry mix: wet <0..1>" },
    ],
    inlets:  [{ index: 0, type: "media", label: "video in (← mediaVideo / vFX)" }],
    outlets: [{ index: 0, type: "media", label: "processed video out (→ layer / vFX)" }],
    defaultWidth:  560,
    defaultHeight: 320,
        derivePorts: deriveReaperVideoPorts,
  },

  "vfxBlur*": {
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

  "glBlur*": {
    description: "GPU Gaussian blur video effect (WebGL2). Drop-in replacement for the CPU blur — runs at full source resolution and the cost is independent of radius. Sits between a video source and a layer. Inlet 0 takes the video and also accepts a bare float (or `radius <n>`) to set blur strength — cable an ezScale/analysis object here for audio-reactive blur.",
    category: "visual",
    args: [
      { name: "radius", type: "float", default: "4", min: 0, max: 64, step: 0.5,
        description: "Blur strength (tap-offset multiplier). 0 = none." },
    ],
    messages: [
      { inlet: 0, selector: "radius", description: "set blur radius (bare float also accepted)" },
    ],
    inlets:  [{ index: 0, type: "media", label: "video in / radius (← source, ezScale)" }],
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
        derivePorts: deriveSequencerPorts,
        ensureArgs: ensureSequencerArgs,
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
        derivePorts: deriveSubPatchPorts,
  },

  peer: {
    description: "WebRTC session to a remote patchNet instance. Phase 7A: manual SDP copy/paste — toggle Offer/Answer in the panel and exchange the blobs with the other side. Hosts netsend / netreceive topic routing.",
    category: "control",
    args: [
      { name: "room",     type: "symbol", default: "", hidden: true,
        description: "Reserved for Phase 7B rendezvous. Phase 7A ignores this." },
      { name: "role",     type: "symbol", default: "offerer",
        description: "offerer | answerer — which side initiates the SDP exchange." },
      { name: "autoConnect", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
        description: "Reserved for Phase 7B. Phase 7A is always manual." },
    ],
    messages: [
      { inlet: 0, selector: "connect",    description: "create offer (offerer) or wait for offer (answerer)" },
      { inlet: 0, selector: "disconnect", description: "tear down the session" },
    ],
    inlets:  [{ index: 0, type: "any",     label: "connect | disconnect" }],
    outlets: [{ index: 0, type: "message", label: "status: connecting | connected | disconnected | failed" }],
    defaultWidth:  240,
    defaultHeight: 120,
  },

  netsend: {
    description: "Send a control-rate message to every netreceive with the same topic on the connected peer. Pd-style topic routing across the network.",
    category: "control",
    args: [
      { name: "topic", type: "symbol", default: "",
        description: "Routing key. Sender and receiver must agree." },
    ],
    messages: [
      { inlet: 0, selector: "bang",   description: "send a bang on this topic" },
      { inlet: 0, selector: "float",  description: "send a float on this topic" },
      { inlet: 0, selector: "symbol", description: "send a symbol on this topic" },
      { inlet: 0, selector: "list",   description: "send a list on this topic" },
    ],
    inlets:  [{ index: 0, type: "any",     label: "any (bang | float | symbol | list)" }],
    outlets: [{ index: 0, type: "message", label: "status: bound | unbound | dropped" }],
    defaultWidth:  120,
    defaultHeight: 40,
  },

  netreceive: {
    description: "Receive control-rate messages from every netsend with the same topic on the connected peer.",
    category: "control",
    args: [
      { name: "topic", type: "symbol", default: "",
        description: "Routing key. Must match the sender's topic." },
    ],
    messages: [],
    inlets:  [],
    outlets: [
      { index: 0, type: "any",     label: "received payload (bang | float | symbol | list)" },
      { index: 1, type: "message", label: "status: bound | unbound | disconnected" },
    ],
    defaultWidth:  120,
    defaultHeight: 40,
  },

  phoneTilt: {
    description: "Streams orientation from a phone's accelerometer/gyro into the patch. Renders a QR code; scan it with a phone on the same Wi-Fi, tap Start, and the phone's tilt drives the outlets in real time. Outputs pitch (β, ±180°), roll (γ, ±90°), yaw (α, 0–360°), and a 0/1 connected flag. Dev-only — relies on the Vite dev server's sensor relay.",
    category: "control",
    args: [
      { name: "room", type: "symbol", default: "", hidden: true,
        description: "Pairing key shared between this object and the phone page. Auto-generated on first creation." },
      { name: "smooth", type: "float", default: "0.2", min: 0, max: 0.99, step: 0.01,
        description: "Exponential smoothing factor (0 = raw incoming samples, 0.99 = nearly frozen)." },
      { name: "rate", type: "int", default: "60", min: 1, max: 240, step: 1,
        description: "Maximum output rate in Hz. Incoming samples above this are coalesced." },
      { name: "zeroPitch", type: "float", default: "0", hidden: true,
        description: "Calibration offset subtracted from pitch (set by the calibrate message)." },
      { name: "zeroRoll", type: "float", default: "0", hidden: true,
        description: "Calibration offset subtracted from roll (set by the calibrate message)." },
      { name: "zeroYaw", type: "float", default: "0", hidden: true,
        description: "Calibration offset subtracted from yaw (set by the calibrate message)." },
    ],
    messages: [
      { inlet: 0, selector: "bang",       description: "emit the last known pitch/roll/yaw on outlets 0/1/2" },
      { inlet: 0, selector: "calibrate",  description: "snapshot current orientation as the new zero point" },
      { inlet: 0, selector: "reset",      description: "clear calibration (zero* args back to 0)" },
      { inlet: 0, selector: "reconnect",  description: "drop and reopen the WebSocket to the dev-server relay" },
    ],
    inlets:  [{ index: 0, type: "any", label: "bang | calibrate | reset | reconnect", temperature: "hot" }],
    outlets: [
      { index: 0, type: "float", label: "pitch (β, degrees, ±180)" },
      { index: 1, type: "float", label: "roll (γ, degrees, ±90)" },
      { index: 2, type: "float", label: "yaw (α, degrees, 0–360)" },
      { index: 3, type: "float", label: "1 = phone connected, 0 = no phone" },
    ],
    defaultWidth:  220,
    defaultHeight: 240,
  },
};

/**
 * Canonicalize object-type aliases (e.g. `trigger` → `t`). Called at node
 * creation, parse, and type-rename boundaries so the graph always stores
 * the canonical form that Max itself displays.
 */
/**
 * Autobuilt from ObjectSpec.keywords fields.
 * Maps alternative type names to canonical keys for autocomplete and
 * type-rename boundaries. The `keywords` field on each spec is the
 * declarative source of truth.
 */
export function buildTypeAliases(defs: Record<string, ObjectSpec>): Record<string, string> {
  const aliases: Record<string, string> = {};
  // Legacy aliases: old video/image names (pre-`*` suffix) that shipped
  // before the naming convention was standardized. Old saved patches and
  // anyone typing the old names in autocomplete still resolve to the new keys.
  const legacy: Record<string, string> = {
    "frame~":      "frame*",
    mediaVideo:    "mediaVideo*",
    mediaImage:    "mediaImage*",
    shaderToy:     "shaderToy*",
    vfxCRT:        "vfxCRT*",
    vfxBlur:       "vfxBlur*",
    glBlur:        "glBlur*",
    reaperVideo:   "reaperVideo*",
    imageFX:       "imageFX*",
    layer:         "layer*",
    visualizer:    "visualizer*",
    "browser~":    "browser~*",
    "youtube~":    "youtube~*",
  };
  Object.assign(aliases, legacy);
  for (const [key, spec] of Object.entries(defs)) {
    if (spec.keywords) {
      for (const kw of spec.keywords) {
        aliases[kw] = key;
      }
    }
  }
  return aliases;
}

let TYPE_ALIASES = buildTypeAliases(OBJECT_DEFS);

export function canonicalizeType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

// Rebuild TYPE_ALIASES when local plugins are merged (they may introduce
// their own keywords or be discovered after OBJECT_DEFS is initially built).
function rebuildTypeAliases(): void {
  TYPE_ALIASES = buildTypeAliases(OBJECT_DEFS);
}

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
  const total = letters.length;
  const ordinal = (n: number) => {
    if (n === 1) return "1st";
    if (n === 2) return "2nd";
    if (n === 3) return "3rd";
    return `${n}th`;
  };
  const outlets: PortDef[] = letters.map((raw, i) => {
    const letter = raw.toLowerCase();
    // t fires right-to-left: rightmost outlet fires first
    const fireOrder = ordinal(total - i);
    const suffix = ` (fires ${fireOrder})`;
    switch (letter) {
      case "i": return { index: i, type: "float"   as PortType, label: `int${suffix}` };
      case "f": return { index: i, type: "float"   as PortType, label: `float${suffix}` };
      case "b": return { index: i, type: "bang"    as PortType, label: `bang${suffix}` };
      case "s": return { index: i, type: "message" as PortType, label: `symbol${suffix}` };
      case "l": return { index: i, type: "message" as PortType, label: `list${suffix}` };
      default:  return { index: i, type: "any"     as PortType, label: `${raw}${suffix}` };
    }
  });
  return { inlets, outlets };
}

/**
 * pack: one inlet per arg (min 2). Inlet 0 is hot, the rest are cold.
 * Single message outlet.
 */
export function derivePackPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const slots = args.length > 0 ? args : ["f", "f"];
  const inlets: PortDef[] = slots.map((raw, i) => ({
    index: i,
    type: "any" as PortType,
    label: i === 0 ? `slot 0 (hot): ${raw}` : `slot ${i} (cold): ${raw}`,
    temperature: i === 0 ? ("hot" as const) : ("cold" as const),
  }));
  const outlets: PortDef[] = [{ index: 0, type: "message" as PortType, label: "packed list" }];
  return { inlets, outlets };
}

/** Initial slot value for a `pack` arg: i/f → "0", s/l → "", anything else → the literal. */
export function packSlotInit(raw: string): string {
  const letter = raw.toLowerCase();
  if (letter === "i" || letter === "f") return "0";
  if (letter === "s" || letter === "l") return "";
  return raw;
}

/**
 * unpack: 1 hot inlet, one outlet per arg (min 2). Outlet types come from the
 * arg letter (i/f → float, s/l → message, literal → any). Atoms emit
 * right-to-left, matching Max.
 */
export function deriveUnpackPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const slots = args.length > 0 ? args : ["f", "f"];
  const total = slots.length;
  const ordinal = (n: number) => {
    if (n === 1) return "1st";
    if (n === 2) return "2nd";
    if (n === 3) return "3rd";
    return `${n}th`;
  };
  const inlets: PortDef[] = [
    { index: 0, type: "any" as PortType, label: "list in (hot)", temperature: "hot" as const },
  ];
  const outlets: PortDef[] = slots.map((raw, i) => {
    const letter = raw.toLowerCase();
    const fireOrder = ordinal(total - i);
    const suffix = ` (fires ${fireOrder})`;
    switch (letter) {
      case "i": return { index: i, type: "float"   as PortType, label: `int${suffix}` };
      case "f": return { index: i, type: "float"   as PortType, label: `float${suffix}` };
      case "s": return { index: i, type: "message" as PortType, label: `symbol${suffix}` };
      case "l": return { index: i, type: "message" as PortType, label: `list${suffix}` };
      default:  return { index: i, type: "any"     as PortType, label: `${raw}${suffix}` };
    }
  });
  return { inlets, outlets };
}

/**
 * route: 1 hot inlet, one outlet per matcher arg + a final "reject" outlet for
 * unmatched input. Default matchers `1 2` give three outlets total.
 */
export function deriveRoutePorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const matchers = args.length > 0 ? args : ["1", "2"];
  const inlets: PortDef[] = [
    { index: 0, type: "any" as PortType, label: "message in (hot)", temperature: "hot" as const },
  ];
  const outlets: PortDef[] = matchers.map((raw, i) => ({
    index: i,
    type: "message" as PortType,
    label: `match: ${raw}`,
  }));
  outlets.push({
    index: matchers.length,
    type: "message" as PortType,
    label: "rejected (no match)",
  });
  return { inlets, outlets };
}

/**
 * FFT spectrum analyzer: 2 signal inlets + N float outlets (one per band).
 * Band count comes from args[0]: 4, 8, or 16. Anything else → 4.
 */
const FFT_BAND_CHOICES = [4, 8, 16] as const;
export type FftBandCount = (typeof FFT_BAND_CHOICES)[number];

// ── mixer~ helpers ────────────────────────────────────────────────────────────

export function mixerChannelCount(args: string[]): number {
  const n = Math.trunc(Number.parseFloat(args[0] ?? "4"));
  return Math.max(1, Math.min(32, Number.isFinite(n) ? n : 4));
}

export function mixerDefaultWidth(n: number): number {
  return Math.max(180, n * 28 + 52);
}

// ── adc~ / dac~ helpers ───────────────────────────────────────────────────────

export function adcChannelCount(args: string[]): number {
  const n = Math.trunc(Number.parseFloat(args[0] ?? "2"));
  return Math.max(1, Math.min(32, Number.isFinite(n) && n > 0 ? n : 2));
}

export function dacChannelCount(args: string[]): number {
  const n = Math.trunc(Number.parseFloat(args[0] ?? "2"));
  return Math.max(1, Math.min(32, Number.isFinite(n) && n > 0 ? n : 2));
}

/** Width grows with channel count so 32 ports stay clickable. */
export function audioPortDefaultWidth(n: number): number {
  return Math.max(80, n * 14 + 24);
}

function audioPortLabel(channel: number, total: number, direction: "in" | "out"): string {
  if (total === 1) return direction === "in" ? "mono in" : "mono out";
  if (total === 2) return channel === 0
    ? (direction === "in" ? "left channel in"  : "left channel out")
    : (direction === "in" ? "right channel in" : "right channel out");
  return `ch ${channel + 1} ${direction}`;
}

export function deriveAdcPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const n = adcChannelCount(args);
  const outlets: PortDef[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    type: "signal" as PortType,
    label: audioPortLabel(i, n, "out"),
  }));
  return { inlets: [], outlets };
}

export function deriveDacPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const n = dacChannelCount(args);
  const inlets: PortDef[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    type: "signal" as PortType,
    label: audioPortLabel(i, n, "in"),
  }));
  return { inlets, outlets: [] };
}

export function deriveMixerPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const n = mixerChannelCount(args);
  const inlets: PortDef[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    type: "signal" as PortType,
    label: `ch ${i + 1} in`,
  }));
  const outlets: PortDef[] = [
    { index: 0, type: "signal" as PortType, label: "sum L" },
    { index: 1, type: "signal" as PortType, label: "sum R" },
  ];
  return { inlets, outlets };
}

export function fftBandCount(args: string[]): FftBandCount {
  const n = Math.trunc(Number.parseFloat(args[0] ?? "4"));
  return (FFT_BAND_CHOICES as readonly number[]).includes(n) ? (n as FftBandCount) : 4;
}

/** Hz range [lo, hi] for each of the N bands. 4 uses fixed perceptual bands;
 *  8 and 16 split 20 Hz – 20 kHz log-evenly. */
export function fftBandRanges(n: FftBandCount): Array<[number, number]> {
  if (n === 4) {
    return [[20, 250], [250, 2000], [2000, 6000], [6000, 20000]];
  }
  const logMin = Math.log10(20);
  const logMax = Math.log10(20000);
  const step = (logMax - logMin) / n;
  return Array.from({ length: n }, (_, i) => [
    Math.pow(10, logMin + i * step),
    Math.pow(10, logMin + (i + 1) * step),
  ]);
}

function fftBandLabel(n: FftBandCount, i: number): string {
  if (n === 4) return ["LO", "LM", "HM", "HI"][i] ?? `B${i + 1}`;
  return String(i + 1);
}

export function deriveFftPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const n = fftBandCount(args);
  const ranges = fftBandRanges(n);
  const inlets: PortDef[] = [
    { index: 0, type: "signal", label: "left channel in" },
    { index: 1, type: "signal", label: "right channel in" },
  ];
  const outlets: PortDef[] = ranges.map(([lo, hi], i) => ({
    index: i,
    type: "float" as PortType,
    label: `${fftBandLabel(n, i)} (${Math.round(lo)}–${Math.round(hi)} Hz)`,
  }));
  return { inlets, outlets };
}

/** First side-inlet index on js~ — after the two stereo signal inlets. */
export const JS_EFFECT_SIDE_INLET_START = 2;

/**
 * Derive js~ ports from args[0] (raw JSFX source). Stereo signal inlets are
 * always present on top; one left-side inlet is added per `sliderN:` declaration
 * in display order, so the user can patch into each slider directly.
 */
export function deriveJsEffectPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const source = args[0] ?? "";
  const inlets: PortDef[] = [
    { index: 0, type: "signal", label: "left channel in" },
    { index: 1, type: "signal", label: "right channel in" },
  ];
  const outlets: PortDef[] = [
    { index: 0, type: "signal", label: "left channel out" },
    { index: 1, type: "signal", label: "right channel out" },
  ];

  const sliders = extractJsEffectSliders(source);
  sliders.forEach((s, i) => {
    inlets.push({
      index: JS_EFFECT_SIDE_INLET_START + i,
      type: "any" as PortType,
      label: s.label,
      side: "left",
    });
  });

  return { inlets, outlets };
}

/** Parsed slider list in display order, tolerant of parse errors (returns []). */
export function extractJsEffectSliders(source: string): Array<{ sliderIndex: number; label: string; min: number; max: number }> {
  if (!source) return [];
  const parsed = parseJsfx(source);
  if (!parsed.ok) return [];
  return parsed.program.sliders.map(s => ({ sliderIndex: s.index, label: s.label, min: s.min, max: s.max }));
}

// ── buffer~ helpers ──────────────────────────────────────────────────

/** Ensure all buffer~ arg slots are present so serialization is positional. */
export function ensureBufferArgs(args: string[]): string[] {
  if (args[0] === undefined) args[0] = "stereo";
  if (args[1] === undefined) args[1] = "1";
  if (args[2] === undefined) args[2] = "0";
  if (args[3] === undefined) args[3] = "180";
  if (args[4] === undefined) args[4] = "stop";
  if (args[5] === undefined) args[5] = "0";
  if (args[6] === undefined) args[6] = "";
  if (args[7] === undefined) args[7] = "";
  if (args[8] === undefined) args[8] = "";
  if (args[9] === undefined) args[9] = "";
  if (args[10] === undefined) args[10] = "0";
  if (args[11] === undefined) args[11] = "0";
  if (args[12] === undefined) args[12] = "";
  return args;
}

/** Returns `[start, end]` normalized range, or `null` when no range is set
 *  (end ≤ start). */
export function bufferRange(args: string[]): [number, number] | null {
  const s = parseFloat(args[10] ?? "0");
  const e = parseFloat(args[11] ?? "0");
  if (!isFinite(s) || !isFinite(e) || e <= s) return null;
  return [Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, e))];
}

export function bufferMode(args: string[]): "stereo" | "mono" {
  return (args[0] ?? "stereo") === "mono" ? "mono" : "stereo";
}

export function bufferMaxLen(args: string[]): number {
  const n = parseFloat(args[3] ?? "180");
  if (!isFinite(n) || n <= 0) return 180;
  return Math.max(1, Math.min(3600, n));
}

export function deriveBufferPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  if (bufferMode(args) === "stereo") {
    return {
      inlets: [
        { index: 0, type: "signal", label: "left channel in (record)" },
        { index: 1, type: "signal", label: "right channel in (record)" },
        { index: 2, type: "any",    label: "record | play | pause | stop | rate f | loop 0|1 | stereo | mono", temperature: "hot" },
      ],
      outlets: [
        { index: 0, type: "signal", label: "left channel out (playback)" },
        { index: 1, type: "signal", label: "right channel out (playback)" },
        { index: 2, type: "float",  label: "position (0.0–1.0)" },
      ],
    };
  }
  return {
    inlets: [
      { index: 0, type: "signal", label: "mono in (record)" },
      { index: 1, type: "any",    label: "record | play | pause | stop | rate f | loop 0|1 | stereo | mono", temperature: "hot" },
    ],
    outlets: [
      { index: 0, type: "signal", label: "mono out (playback)" },
      { index: 1, type: "float",  label: "position (0.0–1.0)" },
    ],
  };
}

/** Inlet index used for control messages (depends on stereo/mono mode). */
export function bufferControlInlet(args: string[]): number {
  return bufferMode(args) === "stereo" ? 2 : 1;
}

// ── vbuf* helpers ──────────────────────────────────────────────────────

export function videoBufferRate(args: string[]): number {
  const r = parseFloat(args[0] ?? "1");
  return Number.isFinite(r) ? Math.max(0, r) : 1;
}

export function videoBufferLoop(args: string[]): boolean {
  return (args[1] ?? "0") !== "0";
}

export function videoBufferMaxLen(args: string[]): number {
  const n = parseFloat(args[2] ?? "60");
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.max(1, Math.min(600, n));
}

/** Returns `[start, end]` normalized range, or `null` when no range is set. */
export function videoBufferRange(args: string[]): [number, number] | null {
  const s = parseFloat(args[6] ?? "0");
  const e = parseFloat(args[7] ?? "0");
  if (!isFinite(s) || !isFinite(e) || e <= s) return null;
  return [Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, e))];
}

/** Control inlet for vbuf* (always 1 — inlet 0 is the media input). */
export const VBUF_CONTROL_INLET = 1;

/** Phase A constant kept as a legacy alias for single-input presets. Callers
 *  that depend on the real side-inlet start should use
 *  `getReaperVideoSideInletStart(source)` — the value shifts when the source
 *  references additional media inputs via `input_info(N>0, …)`. */
export const REAPER_VIDEO_SIDE_INLET_START = 1;

/** Parse literal integer args to `input_info(N, …)` with N > 0. Phase C
 *  auto-derives one additional media inlet per unique N. Dynamic args
 *  (e.g. `input_info(in, …)`) don't match and are assumed to reference
 *  input 0 — which is the common case for single-input presets. */
export function extractExtraMediaInputs(source: string): number[] {
  if (!source) return [];
  const re = /\binput_info\s*\(\s*(\d+)\s*,/g;
  const seen = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 32) seen.add(n);  // arbitrary sanity cap
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/** First param side-inlet index for a given source. Equals 1 when the preset
 *  only references input 0; grows by the number of extra media inputs. */
export function getReaperVideoSideInletStart(source: string | undefined): number {
  return 1 + extractExtraMediaInputs(source ?? "").length;
}

/**
 * Derive reaperVideo ports from args[0] (raw video-processor source).
 *
 *  - Inlet 0 = primary media input (always).
 *  - Inlets 1..K = secondary media inputs, one per unique `input_info(N>0, …)`
 *    reference. Their `sourceIndex` matches the N that code refers to.
 *  - Inlets K+1..K+P = left-side param inlets, one per `//@param`.
 *  - Inlet K+P+1 = left-side wet/dry inlet (always present). Pinned last so
 *    its nub lands on the wet/dry row, which the panel renders directly
 *    below the param knobs at grid slot P.
 */
export function deriveReaperVideoPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const source = args[0] ?? "";
  const inlets: PortDef[] = [
    { index: 0, type: "media", label: "video in 0 (← mediaVideo / vFX)" },
  ];
  const outlets: PortDef[] = [
    { index: 0, type: "media", label: "processed video out (→ layer / vFX)" },
  ];

  const extras = extractExtraMediaInputs(source);
  extras.forEach((n, i) => {
    inlets.push({
      index: 1 + i,
      type: "media",
      label: `video in ${n} (secondary)`,
    });
  });

  const sideInletStart = 1 + extras.length;
  const params = extractReaperVideoParams(source);
  params.forEach((p, i) => {
    inlets.push({
      index: sideInletStart + i,
      type: "any" as PortType,
      label: p.label,
      side: "left",
    });
  });

  // Host-level wet/dry inlet — always present, regardless of how many
  // //@params the script declares. Sits at the slot directly after the
  // params so its nub aligns with the panel's wet/dry row.
  inlets.push({
    index: sideInletStart + params.length,
    type: "any" as PortType,
    label: "wet/dry (0..1)",
    side: "left",
  });

  return { inlets, outlets };
}

/** Parsed param list in display order, tolerant of parse errors (returns []). */
export function extractReaperVideoParams(source: string): Array<{ name: string; label: string; min: number; max: number }> {
  if (!source) return [];
  const parsed = parseRVideo(source);
  if (!parsed.ok) return [];
  return parsed.program.params.map(p => ({ name: p.name, label: p.label || p.name, min: p.min, max: p.max }));
}

/**
 * Derive subPatch ports from args: args[0] = inlet count, args[1] = outlet count.
 */
function deriveSubPatchPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const ic = Math.max(0, parseInt(args[0] ?? "0", 10) || 0);
  const oc = Math.max(0, parseInt(args[1] ?? "0", 10) || 0);
  const inlets: PortDef[] = Array.from({ length: ic }, (_, i) => ({ index: i, type: "any" as PortType, label: `inlet ${i}` }));
  const outlets: PortDef[] = Array.from({ length: oc }, (_, i) => ({ index: i, type: "any" as PortType, label: `outlet ${i}` }));
  return { inlets, outlets };
}

/**
 * Validate an ObjectSpec at module init. Returns an array of error messages
 * (empty = valid). Called for every entry in OBJECT_DEFS at boot.
 */
export function validateObjectDef(type: string, spec: ObjectSpec): string[] {
  const errors: string[] = [];

  if (!spec.description) errors.push(`${type}: missing description`);
  if (!["ui", "control", "audio", "scripting", "visual"].includes(spec.category)) {
    errors.push(`${type}: invalid category "${spec.category}"`);
  }
  if (!Array.isArray(spec.args)) errors.push(`${type}: args must be an array`);
  if (!Array.isArray(spec.messages)) errors.push(`${type}: messages must be an array`);
  if (!Array.isArray(spec.inlets)) errors.push(`${type}: inlets must be an array`);
  if (!Array.isArray(spec.outlets)) errors.push(`${type}: outlets must be an array`);
  if (typeof spec.defaultWidth !== "number" || spec.defaultWidth <= 0) {
    errors.push(`${type}: defaultWidth must be a positive number`);
  }
  if (typeof spec.defaultHeight !== "number" || spec.defaultHeight <= 0) {
    errors.push(`${type}: defaultHeight must be a positive number`);
  }
  if (spec.platforms) {
    if (!Array.isArray(spec.platforms)) errors.push(`${type}: platforms must be an array`);
    else {
      for (const p of spec.platforms) {
        if (p !== "browser" && p !== "native") {
          errors.push(`${type}: invalid platform "${p}"`);
        }
      }
    }
  }

  // Validate args
  if (Array.isArray(spec.args)) {
    for (let i = 0; i < spec.args.length; i++) {
      const arg = spec.args[i];
      if (!arg || typeof arg.name !== "string") {
        errors.push(`${type}: args[${i}] missing name`);
      }
      if (arg && !["int", "float", "symbol", "list"].includes(arg.type)) {
        errors.push(`${type}: args[${i}].type "${arg.type}" invalid`);
      }
    }
  }

  // Validate messages reference valid inlet indices
  if (Array.isArray(spec.messages)) {
    const maxInlet = spec.inlets.length - 1;
    for (let i = 0; i < spec.messages.length; i++) {
      const msg = spec.messages[i];
      if (!msg || typeof msg.selector !== "string") {
        errors.push(`${type}: messages[${i}] missing selector`);
      }
      if (msg && msg.inlet > maxInlet && msg.inlet !== -1 && !spec.derivePorts && spec.inlets.length > 0) {
        // Only warn if inlets are static and the index is out of range
        errors.push(`${type}: messages[${i}] inlet ${msg.inlet} exceeds static inlet count ${spec.inlets.length}`);
      }
    }
  }

  // Validate inlets have valid types
  if (Array.isArray(spec.inlets)) {
    for (let i = 0; i < spec.inlets.length; i++) {
      const port = spec.inlets[i];
      if (!port || typeof port.type !== "string") {
        errors.push(`${type}: inlets[${i}] missing type`);
      }
      if (port && port.index !== i) {
        errors.push(`${type}: inlets[${i}] index mismatch: expected ${i}, got ${port.index}`);
      }
    }
  }

  // Validate outlets have valid types
  if (Array.isArray(spec.outlets)) {
    for (let i = 0; i < spec.outlets.length; i++) {
      const port = spec.outlets[i];
      if (!port || typeof port.type !== "string") {
        errors.push(`${type}: outlets[${i}] missing type`);
      }
      if (port && port.index !== i) {
        errors.push(`${type}: outlets[${i}] index mismatch: expected ${i}, got ${port.index}`);
      }
    }
  }

  return errors;
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

/** Fill missing creation args with their def defaults so the user can see
 *  what the defaults are without consulting the spec. Only fills positions
 *  up to and including the last *visible* arg — trailing hidden state args
 *  (drunk's `current`, vbuf*'s `transport`/`position`/`thumb`, etc.) are
 *  left alone so they don't surface in the patch text. Existing values are
 *  preserved; only undefined/empty slots are filled. */
export function fillCreationDefaults(spec: ObjectSpec, args: string[]): string[] {
  let lastVisibleIdx = -1;
  for (let i = 0; i < spec.args.length; i++) {
    if (!spec.args[i].hidden) lastVisibleIdx = i;
  }
  if (lastVisibleIdx < 0) return [...args];
  const out = [...args];
  for (let i = 0; i <= lastVisibleIdx; i++) {
    if (out[i] === undefined || out[i] === "") {
      out[i] = spec.args[i].default ?? "";
    }
  }
  return out;
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

// Merge gitignored local plugin specs into OBJECT_DEFS at module init so
// autocomplete (ObjectEntryBox) and renderer dispatch see them on first read.
for (const [type, spec] of getLocalPluginSpecs()) {
  OBJECT_DEFS[type] = spec;
}

// Rebuild TYPE_ALIASES after plugin merge (plugins may add keywords).
rebuildTypeAliases();

// Validate every ObjectSpec at module init (M1/1d). Non-fatal: the hard gate
// is tests/object-spec-validation.test.ts (fails CI). Here we surface a single
// consolidated, prominent report so a regression can't hide as one warn line
// scrolled away among unrelated console noise.
if (typeof console !== "undefined") {
  const offenders: Array<[string, string[]]> = [];
  for (const [type, spec] of Object.entries(OBJECT_DEFS)) {
    const errs = validateObjectDef(type, spec);
    if (errs.length > 0) offenders.push([type, errs]);
  }
  if (offenders.length > 0) {
    const report = offenders
      .map(([type, errs]) => `  ${type}:\n${errs.map((e) => `    - ${e}`).join("\n")}`)
      .join("\n");
    console.error(
      `[objectDefs] ObjectSpec contract violated by ${offenders.length}/` +
        `${Object.keys(OBJECT_DEFS).length} objects (see tests/object-spec-validation.test.ts):\n` +
        report,
    );
  }
}

// ─── Platform filtering ──────────────────────────────────────────────────────

/**
 * Returns true if the given ObjectSpec is available on the supplied platform.
 * An object with no `platforms` field is available everywhere.
 */
export function isAvailableOnPlatform(
  spec: ObjectSpec,
  platform: PlatformTarget,
): boolean {
  if (!spec.platforms || spec.platforms.length === 0) return true;
  return spec.platforms.includes(platform);
}

/**
 * Returns a filtered copy of OBJECT_DEFS containing only the objects that
 * are available on the given platform. Used by the palette, autocomplete,
 * and terminal to hide objects that can't run in the current environment.
 */
export function getAvailableObjectDefs(
  platform: PlatformTarget,
): Record<string, ObjectSpec> {
  return Object.fromEntries(
    Object.entries(OBJECT_DEFS).filter(([, spec]) =>
      isAvailableOnPlatform(spec, platform),
    ),
  );
}
