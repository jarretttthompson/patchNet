/**
 * REAPER video-processor parser — Phase A.
 *
 * Splits a video-processor source file into:
 *   - `//@param` declarations (one per line)
 *   - One flat body (everything else), with `//@param` lines blanked so
 *     error offsets/line numbers line up with the user's source.
 *
 * There are no sections in the video processor — the whole script runs once
 * per rendered frame.
 *
 * Parameter syntax (tolerant):
 *   //@param [N:]<name> "<label>" <default> <min> <max> [<mid>] [<step>]
 *
 *   - `N:` index prefix is optional; if absent, assign sequentially (1-based).
 *   - `<name>` may contain dots (namespace syntax, e.g. `r.x`). It is stored
 *     verbatim; the translator sanitizes `.` → `_` when emitting.
 *   - `<label>` is double-quoted. Unescaped embedded quotes not supported.
 *   - Numeric fields: 4–6 trailing numbers. We accept any of those shapes
 *     and store whatever is there; the UI reads default/min/max/step.
 */

export interface ParamDecl {
  index: number;        // 1-based
  name: string;         // verbatim EEL2 ident (may contain dots)
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  /** Knob-center point in REAPER's 5/6-number form; 0 in 4-number form. */
  mid: number;
  /** Step size; undefined when not specified (treat as continuous). */
  step: number | undefined;
}

export interface RVideoProgram {
  params: ParamDecl[];
  body: string;
}

export interface RVideoParseError {
  line: number;
  message: string;
}

export type RVideoParseResult =
  | { ok: true; program: RVideoProgram }
  | { ok: false; error: RVideoParseError };

// Match the @param line starting from `//@param`. Everything else is either
// the numeric trailing fields or the quoted label.
// `\s*` after `@param` (not `\s+`): REAPER accepts `//@param1:name …` with no
// space between `@param` and the index prefix.
const PARAM_LINE_RE = /^\/\/\s*@param\s*(.+)$/;

// Breaks the rest of a @param line into tokens, picking out the quoted label
// and accumulating the remaining space-separated tokens.
function splitParamTokens(rest: string): { name: string; label: string; nums: string[] } | null {
  // Optional leading "N:" index
  // `name` allowed chars: ident chars + dots (namespace syntax)
  const prefixMatch = /^(?:(\d+)\s*:\s*)?([A-Za-z_][A-Za-z0-9_.]*)\s*(.*)$/.exec(rest);
  if (!prefixMatch) return null;

  const idxStr = prefixMatch[1];   // may be undefined
  const name   = prefixMatch[2];
  const tail   = prefixMatch[3];

  // Quoted label comes next — REAPER accepts both "double" and 'single' quotes
  // (stock video presets use both styles). Match either, but the quote style
  // must be consistent on both ends of the label.
  const labelMatch = /^(?:"([^"]*)"|'([^']*)')\s*(.*)$/.exec(tail);
  if (!labelMatch) return null;
  const label = labelMatch[1] ?? labelMatch[2] ?? "";
  const numsPart = labelMatch[3].trim();

  const nums = numsPart.length === 0 ? [] : numsPart.split(/\s+/);

  return {
    name: idxStr !== undefined ? `@${idxStr}:${name}` : name,
    label,
    nums,
  };
}

export function parseRVideo(source: string): RVideoParseResult {
  const lines = source.split(/\r?\n/);
  const params: ParamDecl[] = [];
  const usedIndices = new Set<number>();
  let autoIdx = 0;

  const bodyLines: string[] = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const lineNo = i + 1;

    const m = trimmed.match(PARAM_LINE_RE);
    if (m) {
      const rest = m[1];
      const parts = splitParamTokens(rest);
      if (!parts) {
        return {
          ok: false,
          error: {
            line: lineNo,
            message: `malformed //@param: "${trimmed}". expected: //@param [N:]name "label" default min max [mid] [step]`,
          },
        };
      }

      const label = parts.label;

      // Unpack prefixed name (may be "@<idx>:<actualName>")
      let idx: number;
      let name: string;
      const prefixed = parts.name.match(/^@(\d+):(.+)$/);
      if (prefixed) {
        idx  = parseInt(prefixed[1], 10);
        name = prefixed[2];
      } else {
        autoIdx += 1;
        idx  = autoIdx;
        name = parts.name;
      }
      if (prefixed) autoIdx = Math.max(autoIdx, idx);

      if (usedIndices.has(idx)) {
        return {
          ok: false,
          error: { line: lineNo, message: `duplicate @param index ${idx}` },
        };
      }
      if (idx < 1 || idx > 64) {
        return {
          ok: false,
          error: { line: lineNo, message: `@param index ${idx} out of range (1..64)` },
        };
      }

      const nums = parts.nums.map(s => parseFloat(s));
      if (nums.length < 3 || nums.some(v => !Number.isFinite(v))) {
        return {
          ok: false,
          error: {
            line: lineNo,
            message: `@param "${name}" needs at least default, min, max (got ${nums.length} numbers)`,
          },
        };
      }

      // Layouts (REAPER accepts multiple):
      //   default min max                      (3)
      //   default min max step                 (4)
      //   default min max mid step             (5)
      //   default min max mid step shape?      (6; shape ignored)
      const defaultValue = nums[0];
      const min          = nums[1];
      const max          = nums[2];
      let mid = 0;
      let step: number | undefined;
      if (nums.length === 4) {
        step = nums[3];
      } else if (nums.length >= 5) {
        mid  = nums[3];
        step = nums[4];
      }

      if (min >= max) {
        return {
          ok: false,
          error: { line: lineNo, message: `@param "${name}": min must be less than max` },
        };
      }

      usedIndices.add(idx);
      params.push({
        index: idx,
        name,
        label,
        defaultValue,
        min,
        max,
        mid,
        step,
      });

      // Blank the line so body line numbers match source line numbers.
      bodyLines[i] = "";
      continue;
    }

    bodyLines[i] = raw;
  }

  params.sort((a, b) => a.index - b.index);

  return {
    ok: true,
    program: {
      params,
      body: bodyLines.join("\n"),
    },
  };
}
