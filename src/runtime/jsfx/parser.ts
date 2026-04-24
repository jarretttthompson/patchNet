/**
 * JSFX parser — Phase A subset.
 *
 * Splits a JSFX source file into:
 *   - `desc:` title
 *   - `sliderN:` declarations (default, min, max, optional step, label)
 *   - `@init`, `@slider`, `@sample` section bodies (raw EEL2 text)
 *
 * Phase A only compiles `@sample` bodies; `@init` / `@slider` bodies are
 * parsed and preserved for Phase B. The parser itself is error-tolerant:
 * malformed slider lines produce a typed error with a 1-based line number
 * rather than throwing, so the panel can surface it inline without killing
 * the audio graph.
 */

export interface SliderDecl {
  /** 1-based index parsed from `sliderN:`. */
  index: number;
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

// slider forms we handle:
//   sliderN:default<min,max>label
//   sliderN:default<min,max,step>label
//   sliderN:default<min,max,step{a,b,c}>label   ← enum
//   sliderN:default<min,max{a,b,c}>label        ← enum without step (rare but valid)
// Captures: 1=index 2=default 3=min 4=max 5=step(optional) 6=enumBody(optional) 7=label
const SLIDER_LINE_RE =
  /^slider(\d+)\s*:\s*([-+]?\d*\.?\d+)\s*<\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)(?:\s*,\s*([-+]?\d*\.?\d+))?\s*(?:\{([^}]*)\})?\s*>\s*(.*)$/;

const DESC_LINE_RE = /^desc\s*:\s*(.*)$/;

// Extra header declarations we silently ignore (in_pin/out_pin/tags/author/
// options/filename/import). Match a line whose first token is one of these.
const IGNORED_HEADER_RE = /^(in_pin|out_pin|tags|author|options|filename|import|provides|version|about)\s*:/i;

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

    if (/^slider\d+\s*:/.test(trimmed)) {
      const m = trimmed.match(SLIDER_LINE_RE);
      if (!m) {
        return {
          ok: false,
          error: {
            line: lineNo,
            message: `malformed slider declaration: "${trimmed}". expected: sliderN:default<min,max[,step][{a,b,c}]>label`,
          },
        };
      }
      const index = parseInt(m[1], 10);
      const defaultValue = parseFloat(m[2]);
      const min = parseFloat(m[3]);
      const max = parseFloat(m[4]);
      const step = m[5] !== undefined ? parseFloat(m[5]) : undefined;
      const enumBody = m[6];
      const label = m[7].trim() || `slider${index}`;
      const enumLabels = enumBody !== undefined
        ? enumBody.split(",").map(s => s.trim()).filter(s => s.length > 0)
        : [];
      if (!Number.isFinite(index) || index < 1 || index > 64) {
        return {
          ok: false,
          error: { line: lineNo, message: `slider index ${m[1]} out of range (1..64)` },
        };
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        return {
          ok: false,
          error: { line: lineNo, message: `slider ${index}: min must be less than max` },
        };
      }
      sliders.push({ index, defaultValue, min, max, step, enumLabels, label });
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
