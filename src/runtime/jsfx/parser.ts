/**
 * JSFX parser — REAPER-tolerant header/section splitter.
 *
 * Splits a JSFX source file into:
 *   - `desc:` title
 *   - `sliderN:` declarations (numeric, named, enum, and file-slider forms)
 *   - `@init`, `@slider`, `@block`, `@sample` section bodies (raw EEL2 text)
 *
 * The parser is deliberately loose in the header area. Real-world JSFX
 * libraries include extensionless files, duplicated metadata, named sliders,
 * file-backed sliders, one-choice enum sliders, and a few legacy enum quirks.
 * Section bodies are kept raw and left to the EEL2 translator.
 */

export interface SliderDecl {
  /** 1-based index parsed from `sliderN:`. */
  index: number;
  /** Optional variable alias from `sliderN:name=default<...>Label`. */
  variableName: string | undefined;
  defaultValue: number;
  min: number;
  max: number;
  /** Undefined if no step was specified (EEL2 treats these as continuous). */
  step: number | undefined;
  /** Enum labels for discrete-value sliders. Empty when the slider is
   *  continuous. When populated, the slider's value is the index of the
   *  selected label and the readout shows the label text. */
  enumLabels: string[];
  label: string;
  /** File-backed slider (`sliderN:/path:default:Label`). PatchNet cannot
   *  browse these yet, but parsing them keeps the rest of the effect loadable. */
  isFile: boolean;
  filePath: string | undefined;
  fileDefault: string | undefined;
}

export interface JsfxProgram {
  desc: string;
  sliders: SliderDecl[];
  initBody: string;
  sliderBody: string;
  /** @block body — runs once per audio render block (every `process()`
   *  call in the worklet). Useful for expensive per-block calcs that
   *  don't need per-sample precision (tempo sync, UI-driven state
   *  updates). */
  blockBody: string;
  sampleBody: string;
}

export interface JsfxParseError {
  line: number;
  message: string;
}

export type JsfxParseResult =
  | { ok: true; program: JsfxProgram }
  | { ok: false; error: JsfxParseError };

const MAX_JSFX_SLIDERS = 256;

const NUMBER_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const NUMBER_SCAN_RE = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
const SLIDER_PREFIX_RE = /^slider(\d+)\s*:\s*(.*)$/i;

const DESC_LINE_RE = /^desc\s*:\s*(.*)$/;

// Extra header declarations we silently ignore (in_pin/out_pin/tags/author/
// options/filename/import). Match a line whose first token is one of these.
const IGNORED_HEADER_RE = /^(in_pin|out_pin|tags|author|options|filename|import|provides|version|about|noindex|@gmem)\b\s*:?/i;

type SectionKey = "init" | "slider" | "block" | "sample";

const SECTION_HEADER_RE = /^@(init|slider|sample|block|serialize|gfx)\b.*$/;

export function parseJsfx(source: string): JsfxParseResult {
  const lines = source.split(/\r?\n/);
  let desc = "";
  const sliders: SliderDecl[] = [];
  const sections: Record<SectionKey, string[]> = { init: [], slider: [], block: [], sample: [] };
  let currentSection: SectionKey | null = null;
  // Non-recognised sections (e.g. @block) are swallowed so their bodies don't
  // leak into @sample if they come earlier in the file. Phase B can lift this.
  let inIgnoredSection = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const lineNo = i + 1;

    // Comments: JSFX uses `//` line comments and `/* ... */` block comments.
    // Phase A handles `//` only; block comments are rare in the wild and the
    // translator would need them stripped anyway. We preserve them in body
    // text and let the translator deal with them (it supports `//`).
    if (!trimmed) {
      if (currentSection) sections[currentSection].push(raw);
      continue;
    }

    // Section header?
    const sectionMatch = trimmed.match(SECTION_HEADER_RE);
    if (sectionMatch) {
      const name = sectionMatch[1];
      if (name === "init" || name === "slider" || name === "block" || name === "sample") {
        currentSection = name;
        inIgnoredSection = false;
      } else {
        currentSection = null;
        inIgnoredSection = true;
      }
      continue;
    }

    // Inside a recognised section body? Collect raw text.
    if (currentSection) {
      sections[currentSection].push(raw);
      continue;
    }

    if (inIgnoredSection) continue;

    // Header area (before any @section): desc + slider declarations.
    const descMatch = trimmed.match(DESC_LINE_RE);
    if (descMatch) {
      desc = descMatch[1].trim();
      continue;
    }

    const sliderPrefix = trimmed.match(SLIDER_PREFIX_RE);
    if (sliderPrefix) {
      const parsedSlider = parseSliderLine(sliderPrefix[1], sliderPrefix[2]);
      if ("message" in parsedSlider) {
        return {
          ok: false,
          error: {
            line: lineNo,
            message: parsedSlider.message,
          },
        };
      }
      sliders.push(parsedSlider.slider);
      continue;
    }

    if (IGNORED_HEADER_RE.test(trimmed)) continue;

    // Anything else in the header area (comment lines, blank, unknown
    // extensions) — silently ignored. JSFX's header has a lot of optional
    // declarations that don't affect DSP.
  }

  // Sort sliders by index so the GUI reflects declaration order regardless
  // of whether a file declares slider1 before slider2.
  sliders.sort((a, b) => a.index - b.index);

  return {
    ok: true,
    program: {
      desc,
      sliders,
      initBody:   sections.init.join("\n"),
      sliderBody: sections.slider.join("\n"),
      blockBody:  sections.block.join("\n"),
      sampleBody: sections.sample.join("\n"),
    },
  };
}

type SliderParseResult =
  | { ok: true; slider: SliderDecl }
  | { ok: false; message: string };

function parseSliderLine(indexText: string, rest: string): SliderParseResult {
  const index = parseInt(indexText, 10);
  if (!Number.isFinite(index) || index < 1 || index > MAX_JSFX_SLIDERS) {
    return { ok: false, message: `slider index ${indexText} out of range (1..${MAX_JSFX_SLIDERS})` };
  }

  const rangeStart = rest.indexOf("<");
  if (rangeStart < 0) return parseFileSlider(index, rest);

  const left = rest.slice(0, rangeStart).trim();
  const rangeAndLabel = rest.slice(rangeStart + 1);
  const rangeEnd = rangeAndLabel.indexOf(">");
  if (rangeEnd < 0) {
    return { ok: false, message: `malformed slider${index}: missing closing '>'` };
  }

  let variableName: string | undefined;
  let defaultText = left;
  const aliasEq = left.lastIndexOf("=");
  if (aliasEq >= 0) {
    variableName = left.slice(0, aliasEq).replace(/=+$/g, "").trim() || undefined;
    defaultText = left.slice(aliasEq + 1).trim();
  }

  const rangeBody = rangeAndLabel.slice(0, rangeEnd).trim();
  const label = rangeAndLabel.slice(rangeEnd + 1).trim() || `slider${index}`;
  const enumStart = rangeBody.indexOf("{");
  const numericBody = enumStart >= 0 ? rangeBody.slice(0, enumStart).trim() : rangeBody;
  let enumBody = enumStart >= 0 ? rangeBody.slice(enumStart + 1).trim() : "";
  if (enumBody.endsWith("}")) enumBody = enumBody.slice(0, -1).trim();

  const parts = numericBody.match(NUMBER_SCAN_RE) ?? [];
  if (parts.length < 2) {
    return { ok: false, message: `malformed slider${index}: expected numeric <min,max[,step]> range` };
  }

  const min = parseFloat(parts[0]!);
  const max = parseFloat(parts.length > 3 ? parts[parts.length - 2]! : parts[1]!);
  const step = parts.length >= 3 ? parseFloat(parts[parts.length - 1]!) : undefined;
  if (!isNumberText(defaultText)) {
    if (!variableName && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(defaultText)) variableName = defaultText;
    defaultText = String(min);
  }
  const defaultValue = parseFloat(defaultText);
  const enumLabels = enumBody
    ? enumBody.split(",").map(s => s.trim()).filter(s => s.length > 0)
    : [];

  return {
    ok: true,
    slider: {
      index,
      variableName,
      defaultValue,
      min,
      max,
      step,
      enumLabels,
      label,
      isFile: false,
      filePath: undefined,
      fileDefault: undefined,
    },
  };
}

function parseFileSlider(index: number, rest: string): SliderParseResult {
  const firstColon = rest.indexOf(":");
  const secondColon = firstColon >= 0 ? rest.indexOf(":", firstColon + 1) : -1;
  const filePath = firstColon >= 0 ? rest.slice(0, firstColon).trim() : rest.trim();
  const fileDefault = firstColon >= 0
    ? secondColon >= 0 ? rest.slice(firstColon + 1, secondColon).trim() : rest.slice(firstColon + 1).trim()
    : "";
  const label = secondColon >= 0 ? rest.slice(secondColon + 1).trim() : `slider${index}`;
  return {
    ok: true,
    slider: {
      index,
      variableName: undefined,
      defaultValue: 0,
      min: 0,
      max: 1,
      step: 1,
      enumLabels: [],
      label: label || `slider${index}`,
      isFile: true,
      filePath: filePath || undefined,
      fileDefault: fileDefault || undefined,
    },
  };
}

function isNumberText(text: string): boolean {
  return NUMBER_RE.test(text.trim());
}
