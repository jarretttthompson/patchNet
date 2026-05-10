/**
 * Shared EEL2 tokenizer — used by both the JSFX audio path (`jsfx/translate.ts`)
 * and the REAPER video-processor path (`rvideo/translate.ts`).
 *
 * Grammar extensions over the original JSFX-only tokenizer:
 *   - Hex integer literals (`0x1A`, `0xFF`) — required by video-processor
 *     gfx_mode bitfield constants like `0xfa`.
 *   - Dotted namespace identifiers (`r.x`, `foo.bar.baz`) — real EEL2 feature
 *     used by the video processor for grouped params. The `.` is part of the
 *     ident iff both neighbouring characters are ident-continue.
 */

export type TokenKind =
  | "num"
  | "ident"
  | "op"
  | "assign"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "semi"
  | "comma"
  | "question"
  | "colon"
  | "string"   // single-quoted string literal (rvideo uses it for colorspace)
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  offset: number;
}

export interface TokenizeError {
  message: string;
  offset: number;
}

/** EEL2 `$`-prefixed named constants. Emitted as numeric literals. */
export const NAMED_CONSTANTS: Record<string, string> = {
  pi:  String(Math.PI),
  e:   String(Math.E),
  phi: "1.618033988749895",
};

export function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isHexDigit(c: string | undefined): boolean {
  return c !== undefined &&
    ((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"));
}
export function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "#";
}
export function isIdentContinue(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

export interface TokenizeOptions {
  /** When true, single-quoted strings tokenize as `string`. When false
   *  (default, matches JSFX semantics), they behave as EEL2 packed-char
   *  numeric literals (`$'abcd'` style). */
  allowStrings?: boolean;
}

export function tokenize(source: string, opts: TokenizeOptions = {}): Token[] | TokenizeError {
  const tokens: Token[] = [];
  const allowStrings = opts.allowStrings ?? false;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }

    if (c === "/" && c2 === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i < n) i += 2;
      continue;
    }

    // Hex integer: 0x... / 0X...
    if (c === "0" && (c2 === "x" || c2 === "X") && isHexDigit(source[i + 2])) {
      const start = i;
      i += 2;
      while (i < n && isHexDigit(source[i])) i++;
      const hex = source.slice(start + 2, i);
      tokens.push({ kind: "num", value: String(parseInt(hex, 16)), offset: start });
      continue;
    }

    if ((c >= "0" && c <= "9") || (c === "." && isDigit(c2))) {
      const start = i;
      while (i < n && isDigit(source[i])) i++;
      if (source[i] === ".") { i++; while (i < n && isDigit(source[i])) i++; }
      if (source[i] === "e" || source[i] === "E") {
        i++;
        if (source[i] === "+" || source[i] === "-") i++;
        while (i < n && isDigit(source[i])) i++;
      }
      tokens.push({ kind: "num", value: source.slice(start, i), offset: start });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < n) {
        const ch = source[i];
        if (isIdentContinue(ch)) { i++; continue; }
        // Dotted namespace: `.` joins two ident-continue chars.
        if (ch === "." && i + 1 < n && isIdentContinue(source[i + 1])) { i++; continue; }
        break;
      }
      tokens.push({ kind: "ident", value: source.slice(start, i), offset: start });
      continue;
    }

    // Two-char operators first (== != <= >= && || << >>).
    if ((c === "=" && c2 === "=") ||
        (c === "!" && c2 === "=") ||
        (c === "<" && c2 === "=") ||
        (c === ">" && c2 === "=") ||
        (c === "&" && c2 === "&") ||
        (c === "|" && c2 === "|") ||
        (c === "<" && c2 === "<") ||
        (c === ">" && c2 === ">")) {
      tokens.push({ kind: "op", value: c + c2, offset: i });
      i += 2;
      continue;
    }

    if ((c === "+" || c === "-" || c === "*" || c === "/" ||
         c === "%" || c === "|" || c === "&") && c2 === "=") {
      tokens.push({ kind: "assign", value: c + "=", offset: i });
      i += 2;
      continue;
    }

    // Single-char punctuation.
    if (c === "(") { tokens.push({ kind: "lparen",   value: c, offset: i }); i++; continue; }
    if (c === ")") { tokens.push({ kind: "rparen",   value: c, offset: i }); i++; continue; }
    if (c === "[") { tokens.push({ kind: "lbracket", value: c, offset: i }); i++; continue; }
    if (c === "]") { tokens.push({ kind: "rbracket", value: c, offset: i }); i++; continue; }
    if (c === ";") { tokens.push({ kind: "semi",     value: c, offset: i }); i++; continue; }
    if (c === ",") { tokens.push({ kind: "comma",    value: c, offset: i }); i++; continue; }
    if (c === "?") { tokens.push({ kind: "question", value: c, offset: i }); i++; continue; }
    if (c === ":") { tokens.push({ kind: "colon",    value: c, offset: i }); i++; continue; }
    if (c === "=") { tokens.push({ kind: "assign",   value: "=", offset: i }); i++; continue; }

    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%" || c === "^" ||
        c === "<" || c === ">" || c === "!" ||
        c === "|" || c === "&" || c === "~") {
      tokens.push({ kind: "op", value: c, offset: i });
      i++;
      continue;
    }

    // REAPER accepts both 'single' and "double" quoted strings; body literals
    // for gfx_evalrect are typically double-quoted and span multiple lines.
    if (allowStrings && (c === "'" || c === '"')) {
      const quote = c;
      const start = i;
      i++;
      const strStart = i;
      while (i < n && source[i] !== quote) i++;
      if (i >= n) return { offset: start, message: "unterminated string literal" };
      tokens.push({ kind: "string", value: source.slice(strStart, i), offset: start });
      i++;
      continue;
    }

    // EEL2 $-literals: $pi, $e, $phi as named constants; $'c' or $'abcd'
    // as ASCII char literals (packed big-endian int).
    if (c === "$") {
      const start = i;
      i++;
      if ((source[i] === "x" || source[i] === "X") && isHexDigit(source[i + 1])) {
        i++;
        const hexStart = i;
        while (i < n && isHexDigit(source[i])) i++;
        tokens.push({ kind: "num", value: String(parseInt(source.slice(hexStart, i), 16)), offset: start });
        continue;
      }
      if (source[i] === "'") {
        i++;
        let val = 0;
        let count = 0;
        while (i < n && source[i] !== "'" && count < 4) {
          val = (val << 8) | source.charCodeAt(i);
          i++;
          count++;
        }
        if (source[i] !== "'") {
          return { offset: start, message: "unterminated $'...' char literal" };
        }
        i++;
        tokens.push({ kind: "num", value: String(val), offset: start });
        continue;
      }
      const nameStart = i;
      while (i < n && isIdentContinue(source[i])) i++;
      const name = source.slice(nameStart, i);
      const lit = NAMED_CONSTANTS[name];
      if (lit === undefined) {
        return {
          offset: start,
          message: `unknown $-constant '$${name}'. Supported: $pi, $e, $phi, and $'c' char literals.`,
        };
      }
      tokens.push({ kind: "num", value: lit, offset: start });
      continue;
    }

    return {
      offset: i,
      message: `unsupported character '${c}'.`,
    };
  }

  tokens.push({ kind: "eof", value: "", offset: n });
  return tokens;
}

/** JS reserved words + shared runtime locals used by translator output. Any
 *  EEL2 user-var name that would collide with these must be rejected or
 *  renamed by callers. */
export const JS_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends",
  "finally", "for", "function", "if", "import", "in", "instanceof", "let",
  "new", "null", "return", "super", "switch", "this", "throw", "try",
  "typeof", "var", "void", "with", "yield",
  // Names the JSFX worklet frame uses
  "L", "R", "sliders", "srate", "state", "mem",
  // Names the rvideo frame uses
  "params", "host",
]);

/** Convert a (possibly dotted) EEL2 identifier into a JS-safe suffix. `r.x`
 *  → `r_x`. Callers typically prefix with `state.u_`. */
export function sanitizeIdent(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
