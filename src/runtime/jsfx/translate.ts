/**
 * EEL2 → JavaScript translator — Phase D subset.
 *
 * Scope:
 *   - Statements separated by `;`, optionally trailing.
 *   - Assignment: `=`, compound `+= -= *= /=`.
 *   - Arithmetic: `+ - * / %`, unary `- + ! ~`, parens.
 *   - Power: `a ^ b` (EEL2 `^` = pow, NOT XOR), right-associative, above `*`.
 *   - Comparison: `== != < <= > >=`.
 *   - Bitwise: `|` `&` (between comparison and logical); unary `~`.
 *   - Logical: `&& ||` (short-circuit).
 *   - Ternary: `a ? b : c`, plus `a ? b` (no else → returns 0 on false).
 *   - Parens-as-blocks: `(s1; s2; ... ; last)` → JS comma expression.
 *   - Array access: `name[expr]` reads/writes `mem[(name | 0) + (expr | 0)]`.
 *     `name` is a pointer-offset, usually a user var set in @init.
 *   - Loops: `loop(n, body)`, `while (cond) body` — IIFE-wrapped.
 *   - Identifiers:
 *       spl0, spl1     → L, R (R/W sample values)
 *       sliderN        → sliders[N-1]
 *       srate          → sample rate constant
 *       true, false    → 1, 0 literals
 *       tempo, beat_position, play_position, play_state, num_ch,
 *       tsnum, tsdenom → 0 (host globals not wired into patchNet yet)
 *       mem, gmem      → 0 offset (bare `mem[i]` becomes `mem[0 + i]`)
 *       anything else  → user variable as `state.u_<name>`
 *   - Function calls: math builtins (Math.*) + `rand(x)` → random in [0,x).
 *   - Numeric literals; `//` line + block comments.
 *
 * Output:
 *   @sample → wrapped `(L, R, state, sliders, srate, mem) => { body; return [L, R]; }`
 *   @init / @slider / @block → wrapped `(state, sliders, srate, mem) => { body; }`
 */

export interface JsfxTranslateError {
  message: string;
  offset: number;
}

export type JsfxTranslateResult =
  | { ok: true; js: string; userVars: string[] }
  | { ok: false; error: JsfxTranslateError };

// ── Tokeniser ───────────────────────────────────────────────────────────

type TokenKind =
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
  | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  offset: number;
}

function tokenise(source: string): Token[] | JsfxTranslateError {
  const tokens: Token[] = [];
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
      while (i < n && isIdentContinue(source[i])) i++;
      tokens.push({ kind: "ident", value: source.slice(start, i), offset: start });
      continue;
    }

    // Two-char operators first (== != <= >= && ||).
    if ((c === "=" && c2 === "=") ||
        (c === "!" && c2 === "=") ||
        (c === "<" && c2 === "=") ||
        (c === ">" && c2 === "=") ||
        (c === "&" && c2 === "&") ||
        (c === "|" && c2 === "|")) {
      tokens.push({ kind: "op", value: c + c2, offset: i });
      i += 2;
      continue;
    }

    if ((c === "+" || c === "-" || c === "*" || c === "/" ||
         c === "%" || c === "|" || c === "&") && c2 === "=") {
      // Compound assignment. JS supports all of these directly with the
      // same semantics EEL2 uses (arithmetic / bitwise). `|=` and `&=`
      // are tokenised AFTER `||` and `&&` above, so no ambiguity.
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

    // EEL2 $-literals: $pi, $e, $phi as named constants; $'c' or $'abcd'
    // as ASCII char literals (packed big-endian int).
    if (c === "$") {
      const start = i;
      i++;
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
      message: `unsupported character '${c}'. String literals and user-defined 'function' declarations aren't supported in Phase D.`,
    };
  }

  tokens.push({ kind: "eof", value: "", offset: n });
  return tokens;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isIdentContinue(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

// ── Built-ins + reserved-ident resolution ───────────────────────────────

/** EEL2 `$`-prefixed named constants. Emitted as numeric literals. */
const NAMED_CONSTANTS: Record<string, string> = {
  pi:  String(Math.PI),
  e:   String(Math.E),
  phi: "1.618033988749895",
};

const BUILTINS: Record<string, string> = {
  sin: "Math.sin", cos: "Math.cos", tan: "Math.tan",
  asin: "Math.asin", acos: "Math.acos", atan: "Math.atan", atan2: "Math.atan2",
  exp: "Math.exp", log: "Math.log", log10: "Math.log10", log2: "Math.log2",
  sqrt: "Math.sqrt", abs: "Math.abs",
  min: "Math.min", max: "Math.max",
  floor: "Math.floor", ceil: "Math.ceil", round: "Math.round",
  pow: "Math.pow", sign: "Math.sign",
};

/** Identifiers resolved into host-provided references. Returns either an
 *  object with `ref` (r/w lvalue), or `literal` (read-only constant), or
 *  null if the name is a normal user var. */
interface ResolvedIdent {
  js: string;
  /** True if this resolves to a readable AND writable slot. */
  assignable: boolean;
  /** True if this identifier acts as a pointer offset for `name[i]`
   *  indexing. User vars are pointer offsets by convention; reserved
   *  read-only literals (tempo, true, etc.) are not — indexing through
   *  them is meaningless. */
  pointerish: boolean;
}

function resolveIdent(name: string): ResolvedIdent | null {
  if (name === "spl0") return { js: "L", assignable: true, pointerish: false };
  if (name === "spl1") return { js: "R", assignable: true, pointerish: false };
  if (name === "srate") return { js: "srate", assignable: false, pointerish: false };

  const sliderMatch = /^slider(\d+)$/.exec(name);
  if (sliderMatch) {
    const idx = parseInt(sliderMatch[1], 10);
    if (idx >= 1 && idx <= 64) return { js: `sliders[${idx - 1}]`, assignable: true, pointerish: false };
  }

  // Literals.
  if (name === "true")  return { js: "1", assignable: false, pointerish: false };
  if (name === "false") return { js: "0", assignable: false, pointerish: false };

  // Host globals stubbed to 0 — patchNet has no DAW transport yet. Scripts
  // that check `tempo > 0` or `slider11 > 0 && tempo > 0` will take their
  // free-running path, which is the safe default.
  if (name === "tempo"         || name === "beat_position" ||
      name === "play_position" || name === "play_state"    ||
      name === "num_ch"        || name === "tsnum"         || name === "tsdenom" ||
      name === "ts_num"        || name === "ts_denom") {
    return { js: "0", assignable: false, pointerish: false };
  }

  // `mem` / `gmem` act as pointer-offset 0 — so `mem[i]` indexes the shared
  // buffer directly. Not assignable as a scalar.
  if (name === "mem" || name === "gmem") {
    return { js: "0", assignable: false, pointerish: true };
  }

  return null;
}

// ── Parser / emitter ────────────────────────────────────────────────────

class Translator {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly userVars = new Set<string>();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  translate(): { js: string; userVars: string[] } | JsfxTranslateError {
    const parts: string[] = [];
    while (this.peek().kind !== "eof") {
      if (this.peek().kind === "semi") { this.pos++; continue; }
      const stmt = this.parseExpression();
      if ("message" in stmt) return stmt;
      parts.push(stmt.js + ";");
      if (this.peek().kind === "semi") this.pos++;
    }
    return { js: parts.join("\n"), userVars: Array.from(this.userVars) };
  }

  // Precedence (high → low):
  //   primary → array-index (postfix) → unary → pow → multi → add →
  //   compare → bit-and → bit-or → logAnd → logOr → ternary → assign

  private parseExpression(): EmitResult {
    return this.parseAssignment();
  }

  private parseAssignment(): EmitResult {
    const left = this.parseTernary();
    if ("message" in left) return left;
    const tok = this.peek();
    if (tok.kind === "assign") {
      this.pos++;
      const right = this.parseAssignment();
      if ("message" in right) return right;
      if (!left.assignable) {
        return { message: `left-hand side of '${tok.value}' is not assignable`, offset: tok.offset };
      }
      return { js: `(${left.js} ${tok.value} ${right.js})`, assignable: false };
    }
    return left;
  }

  private parseTernary(): EmitResult {
    const cond = this.parseLogicalOr();
    if ("message" in cond) return cond;
    const tok = this.peek();
    if (tok.kind === "question") {
      this.pos++;
      const trueBranch = this.parseAssignment();
      if ("message" in trueBranch) return trueBranch;
      const next = this.peek();
      if (next.kind === "colon") {
        this.pos++;
        const falseBranch = this.parseAssignment();
        if ("message" in falseBranch) return falseBranch;
        return { js: `(${cond.js} ? ${trueBranch.js} : ${falseBranch.js})`, assignable: false };
      }
      return { js: `(${cond.js} ? ${trueBranch.js} : 0)`, assignable: false };
    }
    return cond;
  }

  private parseLogicalOr(): EmitResult {
    let left = this.parseLogicalAnd();
    if ("message" in left) return left;
    while (this.peek().kind === "op" && this.peek().value === "||") {
      this.pos++;
      const right = this.parseLogicalAnd();
      if ("message" in right) return right;
      left = { js: `(${left.js} || ${right.js})`, assignable: false };
    }
    return left;
  }

  private parseLogicalAnd(): EmitResult {
    let left = this.parseBitOr();
    if ("message" in left) return left;
    while (this.peek().kind === "op" && this.peek().value === "&&") {
      this.pos++;
      const right = this.parseBitOr();
      if ("message" in right) return right;
      left = { js: `(${left.js} && ${right.js})`, assignable: false };
    }
    return left;
  }

  private parseBitOr(): EmitResult {
    let left = this.parseBitAnd();
    if ("message" in left) return left;
    while (this.peek().kind === "op" && this.peek().value === "|") {
      this.pos++;
      const right = this.parseBitAnd();
      if ("message" in right) return right;
      left = { js: `(${left.js} | ${right.js})`, assignable: false };
    }
    return left;
  }

  private parseBitAnd(): EmitResult {
    let left = this.parseComparison();
    if ("message" in left) return left;
    while (this.peek().kind === "op" && this.peek().value === "&") {
      this.pos++;
      const right = this.parseComparison();
      if ("message" in right) return right;
      left = { js: `(${left.js} & ${right.js})`, assignable: false };
    }
    return left;
  }

  private parseComparison(): EmitResult {
    let left = this.parseAdditive();
    if ("message" in left) return left;
    while (true) {
      const tok = this.peek();
      if (tok.kind === "op" &&
          (tok.value === "==" || tok.value === "!=" ||
           tok.value === "<"  || tok.value === "<=" ||
           tok.value === ">"  || tok.value === ">=")) {
        this.pos++;
        const right = this.parseAdditive();
        if ("message" in right) return right;
        const op = tok.value === "==" ? "===" : tok.value === "!=" ? "!==" : tok.value;
        left = { js: `(${left.js} ${op} ${right.js})`, assignable: false };
      } else break;
    }
    return left;
  }

  private parseAdditive(): EmitResult {
    let left = this.parseMultiplicative();
    if ("message" in left) return left;
    while (true) {
      const tok = this.peek();
      if (tok.kind === "op" && (tok.value === "+" || tok.value === "-")) {
        this.pos++;
        const right = this.parseMultiplicative();
        if ("message" in right) return right;
        left = { js: `(${left.js} ${tok.value} ${right.js})`, assignable: false };
      } else break;
    }
    return left;
  }

  private parseMultiplicative(): EmitResult {
    let left = this.parsePow();
    if ("message" in left) return left;
    while (true) {
      const tok = this.peek();
      if (tok.kind === "op" && (tok.value === "*" || tok.value === "/" || tok.value === "%")) {
        this.pos++;
        const right = this.parsePow();
        if ("message" in right) return right;
        left = { js: `(${left.js} ${tok.value} ${right.js})`, assignable: false };
      } else break;
    }
    return left;
  }

  private parsePow(): EmitResult {
    const left = this.parseUnary();
    if ("message" in left) return left;
    const tok = this.peek();
    if (tok.kind === "op" && tok.value === "^") {
      this.pos++;
      const right = this.parsePow();
      if ("message" in right) return right;
      return { js: `((${left.js}) ** (${right.js}))`, assignable: false };
    }
    return left;
  }

  private parseUnary(): EmitResult {
    const tok = this.peek();
    if (tok.kind === "op" && (tok.value === "-" || tok.value === "+" ||
                              tok.value === "!" || tok.value === "~")) {
      this.pos++;
      const inner = this.parseUnary();
      if ("message" in inner) return inner;
      if (tok.value === "!") {
        return { js: `(!${inner.js} ? 1 : 0)`, assignable: false };
      }
      if (tok.value === "~") {
        // Bitwise NOT. JS's `~` operates on int32, matching EEL2 semantics.
        return { js: `(~${inner.js})`, assignable: false };
      }
      return { js: `(${tok.value}${inner.js})`, assignable: false };
    }
    return this.parsePostfix();
  }

  /** After a primary expression, consume any `[index]` array accesses to
   *  build up a mem[] reference. Multiple indices aren't valid in EEL2
   *  (`a[b][c]` has no defined meaning), but we support the chain for
   *  completeness. */
  private parsePostfix(): EmitResult {
    const { result: initial, pointerish } = this.parsePrimary();
    if ("message" in initial) return initial;
    let node = initial;
    let currentPointerish = pointerish;
    while (this.peek().kind === "lbracket") {
      const lb = this.peek();
      if (!currentPointerish) {
        return {
          message: `'${node.js}' can't be used as an array base — 'name[index]' requires a pointer-offset (user variable, mem, or gmem)`,
          offset: lb.offset,
        };
      }
      this.pos++;
      const idx = this.parseExpression();
      if ("message" in idx) return idx;
      if (this.peek().kind !== "rbracket") {
        return { message: "expected ']' closing array index", offset: lb.offset };
      }
      this.pos++;
      // `mem[(base | 0) + ((idx) | 0)]` — cast both base and offset to int32
      // so negative or fractional values don't explode the typed-array
      // bounds. JS's `|` is a 32-bit cast which matches EEL2's memory
      // addressing.
      node = {
        js: `mem[((${node.js}) | 0) + ((${idx.js}) | 0)]`,
        assignable: true,
      };
      currentPointerish = false;  // chaining `a[b][c]` isn't a pointer; result is scalar
    }
    return node;
  }

  /** Parse a single primary expression. Returns the result along with a
   *  `pointerish` flag that the postfix layer uses to decide whether
   *  `[index]` is allowed on this base. */
  private parsePrimary(): { result: EmitResult; pointerish: boolean } {
    const tok = this.peek();

    if (tok.kind === "num") {
      this.pos++;
      return { result: { js: tok.value, assignable: false }, pointerish: false };
    }

    if (tok.kind === "ident") {
      if (tok.value === "loop")  return { result: this.parseLoop(),  pointerish: false };
      if (tok.value === "while") return { result: this.parseWhile(), pointerish: false };

      // Function call: ident immediately followed by `(`.
      if (this.tokens[this.pos + 1]?.kind === "lparen") {
        this.pos++;
        return { result: this.parseCall(tok), pointerish: false };
      }

      this.pos++;
      const resolved = resolveIdent(tok.value);
      if (resolved !== null) {
        return {
          result: { js: resolved.js, assignable: resolved.assignable },
          pointerish: resolved.pointerish,
        };
      }
      if (!isSafeJsIdent(tok.value)) {
        return {
          result: {
            message: `identifier '${tok.value}' collides with a JavaScript reserved word; rename it`,
            offset: tok.offset,
          },
          pointerish: false,
        };
      }
      this.userVars.add(tok.value);
      // User vars are always pointer-ish — EEL2's convention is that any
      // variable can hold a pointer offset for `name[i]` access.
      return {
        result: { js: `state.u_${tok.value}`, assignable: true },
        pointerish: true,
      };
    }

    if (tok.kind === "lparen") {
      return { result: this.parseParenBlock(), pointerish: false };
    }

    return {
      result: { message: `unexpected '${tok.value || tok.kind}'`, offset: tok.offset },
      pointerish: false,
    };
  }

  private parseParenBlock(): EmitResult {
    const lparen = this.peek();
    this.pos++;
    const stmts: string[] = [];
    while (this.peek().kind !== "rparen" && this.peek().kind !== "eof") {
      if (this.peek().kind === "semi") { this.pos++; continue; }
      const r = this.parseExpression();
      if ("message" in r) return r;
      stmts.push(r.js);
      if (this.peek().kind === "semi") this.pos++;
    }
    if (this.peek().kind !== "rparen") {
      return { message: "expected ')'", offset: lparen.offset };
    }
    this.pos++;
    if (stmts.length === 0) return { js: "(0)", assignable: false };
    if (stmts.length === 1) return { js: `(${stmts[0]})`, assignable: false };
    return { js: `(${stmts.join(", ")})`, assignable: false };
  }

  private parseCall(identTok: Token): EmitResult {
    // Special-case rand — not a Math.* pass-through; returns a value in
    // [0, x). Handle inline so callers see a clean emit.
    if (identTok.value === "rand") {
      this.pos++;  // '('
      const arg = this.parseExpression();
      if ("message" in arg) return arg;
      if (this.peek().kind !== "rparen") {
        return { message: "expected ')' closing rand(...)", offset: identTok.offset };
      }
      this.pos++;
      return { js: `(Math.random() * (${arg.js}))`, assignable: false };
    }

    const builtin = BUILTINS[identTok.value];
    if (!builtin) {
      return {
        message: `unknown function '${identTok.value}' — supported: ${Object.keys(BUILTINS).concat(["rand"]).join(", ")}. User-defined 'function' declarations aren't supported.`,
        offset: identTok.offset,
      };
    }
    this.pos++;  // '('
    const args: string[] = [];
    while (this.peek().kind !== "rparen" && this.peek().kind !== "eof") {
      const a = this.parseExpression();
      if ("message" in a) return a;
      args.push(a.js);
      if (this.peek().kind === "comma") { this.pos++; continue; }
      break;
    }
    if (this.peek().kind !== "rparen") {
      return { message: `expected ')' closing call to ${identTok.value}`, offset: identTok.offset };
    }
    this.pos++;
    return { js: `${builtin}(${args.join(", ")})`, assignable: false };
  }

  private parseLoop(): EmitResult {
    const startTok = this.peek();
    this.pos++;
    if (this.peek().kind !== "lparen") {
      return { message: "expected '(' after 'loop'", offset: startTok.offset };
    }
    this.pos++;
    const count = this.parseExpression();
    if ("message" in count) return count;
    if (this.peek().kind !== "comma") {
      return { message: "expected ',' between loop count and body", offset: this.peek().offset };
    }
    this.pos++;
    const bodyStmts: string[] = [];
    while (this.peek().kind !== "rparen" && this.peek().kind !== "eof") {
      if (this.peek().kind === "semi") { this.pos++; continue; }
      const r = this.parseExpression();
      if ("message" in r) return r;
      bodyStmts.push(r.js);
      if (this.peek().kind === "semi") this.pos++;
    }
    if (this.peek().kind !== "rparen") {
      return { message: "expected ')' closing loop()", offset: startTok.offset };
    }
    this.pos++;
    const bodyJs = bodyStmts.length === 0
      ? "0"
      : bodyStmts.length === 1 ? bodyStmts[0] : `(${bodyStmts.join(", ")})`;
    return {
      js: `((_n) => { for (let _i = 0; _i < _n; _i++) { ${bodyJs}; } return 0; })(${count.js})`,
      assignable: false,
    };
  }

  private parseWhile(): EmitResult {
    const startTok = this.peek();
    this.pos++;
    if (this.peek().kind !== "lparen") {
      return { message: "expected '(' after 'while'", offset: startTok.offset };
    }
    this.pos++;
    const cond = this.parseExpression();
    if ("message" in cond) return cond;
    if (this.peek().kind === "semi") {
      return {
        message: "while(...) body with inline condition (last-stmt form) not supported; use explicit `while (cond) body`",
        offset: this.peek().offset,
      };
    }
    if (this.peek().kind !== "rparen") {
      return { message: "expected ')' closing while condition", offset: this.peek().offset };
    }
    this.pos++;
    const body = this.parseExpression();
    if ("message" in body) return body;
    return {
      js: `(() => { while (${cond.js}) { ${body.js}; } return 0; })()`,
      assignable: false,
    };
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
}

interface EmitOk {
  js: string;
  assignable: boolean;
}
type EmitResult = EmitOk | JsfxTranslateError;

const JS_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends",
  "finally", "for", "function", "if", "import", "in", "instanceof", "let",
  "new", "null", "return", "super", "switch", "this", "throw", "try",
  "typeof", "var", "void", "with", "yield",
  // Names we use in the worklet frame + our emit layer
  "L", "R", "sliders", "srate", "state", "mem",
]);

function isSafeJsIdent(name: string): boolean {
  return !JS_RESERVED.has(name);
}

// ── Public entry ────────────────────────────────────────────────────────

export function translateJsfxBody(body: string): JsfxTranslateResult {
  if (!body.trim()) {
    return { ok: true, js: "", userVars: [] };
  }
  const tokens = tokenise(body);
  if ("message" in tokens) return { ok: false, error: tokens };
  const result = new Translator(tokens).translate();
  if ("message" in result) return { ok: false, error: result };
  return { ok: true, js: result.js, userVars: result.userVars };
}
