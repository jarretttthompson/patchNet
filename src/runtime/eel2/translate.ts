/**
 * EEL2 → JavaScript translator — shared core.
 *
 * The JSFX audio path and the REAPER video-processor path both speak EEL2.
 * They differ only in which identifiers/functions resolve to what host code.
 * This module owns the parser + emitter; callers inject resolvers that map
 * EEL2 names to JS expressions.
 *
 * See `jsfx/translate.ts` for the audio stdlib bindings and
 * `rvideo/translate.ts` for the video-processor bindings.
 */

import {
  sanitizeIdent,
  tokenize,
  type Token,
  type TokenizeOptions,
} from "./tokenize";

// ── Public types ─────────────────────────────────────────────────────────

export interface TranslateError {
  message: string;
  offset: number;
}

export type TranslateResult =
  | { ok: true; js: string; userVars: string[] }
  | { ok: false; error: TranslateError };

export interface ResolvedIdent {
  /** Emitted JS expression (or lvalue when `assignable`). */
  js: string;
  assignable: boolean;
  /** True if this identifier can act as a base for `name[index]`. User vars
   *  are pointer-ish by convention; read-only constants like `pi` are not. */
  pointerish: boolean;
}

export interface ResolvedCall {
  /** Emitted JS for a standard function call with already-parsed args. */
  js: string;
  /** Some JSFX builtins such as `spl(n)` are valid assignment targets. */
  assignable?: boolean;
}

export interface TranslatorResolvers {
  /** Resolve a bare identifier. Return null to fall through to user-var
   *  handling (which emits `state.u_<sanitizedName>`). */
  resolveIdent?: (name: string) => ResolvedIdent | null;
  /** Resolve a function call with already-translated args. Return null if
   *  the function name is unknown (caller gets a standard "unknown function"
   *  error). Called AFTER standard argument parsing. */
  resolveCall?: (name: string, args: string[]) => ResolvedCall | null;
  /** Intercept a function call BEFORE arg parsing. When non-null, the
   *  handler owns parsing up to and including the closing ')'. Use for
   *  EEL2 functions with unusual arg semantics (e.g. `input_info` takes
   *  bare ident names as output-parameter args). The parser argument
   *  exposes just enough to consume tokens manually. */
  interceptCall?: (name: string, api: SpecialCallApi) => EmitResult | null;
  /** When true, EEL2 string literals are available via `resolveStringLiteral`. */
  allowStrings?: boolean;
  /** Handle a string-literal expression. Called only when `allowStrings` is
   *  set. Return null to reject (unsupported context). */
  resolveStringLiteral?: (value: string) => EmitResult | null;
}

export interface SpecialCallApi {
  /** Current token (peek). */
  peek(): Token;
  /** Advance to next token, returning the one just consumed. */
  next(): Token;
  /** Parse a full EEL2 expression at the current position. */
  parseExpression(): EmitResult;
}

export interface EmitOk {
  js: string;
  assignable: boolean;
}
export type EmitResult = EmitOk | TranslateError;

export function isEmitError(r: EmitResult): r is TranslateError {
  return "message" in r;
}

// ── Entry point ──────────────────────────────────────────────────────────

export function translateBody(
  source: string,
  resolvers: TranslatorResolvers = {},
): TranslateResult {
  if (!source.trim()) {
    return { ok: true, js: "", userVars: [] };
  }
  const tokOpts: TokenizeOptions = { allowStrings: resolvers.allowStrings };
  const tokens = tokenize(source, tokOpts);
  if ("message" in tokens) return { ok: false, error: tokens };
  const result = new Translator(tokens, resolvers).translate();
  if ("message" in result) return { ok: false, error: result };
  return { ok: true, js: result.js, userVars: result.userVars };
}

// ── Translator class ─────────────────────────────────────────────────────

export class Translator implements SpecialCallApi {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly resolvers: TranslatorResolvers;
  private readonly userVars = new Set<string>();

  /** Names of EEL2 functions defined in this program. Populated as `function`
   *  statements are encountered. A call to an unknown name is resolved here
   *  when the standard resolver returns null, so forward references are
   *  rejected — the def must precede the first call. Matches REAPER. */
  private readonly userFunctions = new Set<string>();

  /** Stack of local name → JS-expr maps. Top is the innermost scope. An
   *  entry here shadows any global/host ident resolution for that name. Only
   *  function arguments currently push a scope; EEL2 semantics otherwise
   *  treat all user vars as global. */
  private readonly localStack: Map<string, string>[] = [];

  constructor(tokens: Token[], resolvers: TranslatorResolvers) {
    this.tokens = tokens;
    this.resolvers = resolvers;
  }

  translate(): { js: string; userVars: string[] } | TranslateError {
    const fnDecls: string[] = [];
    const parts: string[] = [];
    while (this.peek().kind !== "eof") {
      if (this.peek().kind === "semi") { this.pos++; continue; }

      // Statement-level `function NAME(args) (body)` — hoist to top of emit.
      if (this.peek().kind === "ident" && this.peek().value === "function") {
        const fn = this.parseFunctionDef();
        if ("message" in fn) return fn;
        fnDecls.push(fn.js);
        if (this.peek().kind === "semi") this.pos++;
        continue;
      }

      const stmt = this.parseExpression();
      if ("message" in stmt) return stmt;
      parts.push(stmt.js + ";");
      if (this.peek().kind === "semi") this.pos++;
    }

    // Function decls first (JS hoists them anyway, but emitting them up top
    // is clearer when reading the generated source for debugging).
    const js = fnDecls.length > 0
      ? fnDecls.join("\n") + "\n" + parts.join("\n")
      : parts.join("\n");

    return { js, userVars: Array.from(this.userVars) };
  }

  /** Parse `function NAME(arg1 arg2 ...) (body)`. Called with `function`
   *  still at `peek()`. REAPER's arg list is space-separated (no commas);
   *  the tokenizer drops whitespace so we just consume consecutive idents. */
  private parseFunctionDef(): EmitResult {
    const fnTok = this.next();   // consume 'function'

    const nameTok = this.peek();
    if (nameTok.kind !== "ident") {
      return { message: "expected function name after 'function'", offset: nameTok.offset };
    }
    this.pos++;
    const fnName = nameTok.value;
    if (this.userFunctions.has(fnName)) {
      return { message: `function '${fnName}' redefined`, offset: nameTok.offset };
    }

    if (this.peek().kind !== "lparen") {
      return { message: "expected '(' after function name", offset: this.peek().offset };
    }
    this.pos++;

    const argNames: string[] = [];
    while (this.peek().kind === "ident") {
      const argTok = this.next();
      argNames.push(argTok.value);
      // REAPER allows comma OR whitespace between args. We consumed any
      // whitespace already via the tokenizer, so consume an optional comma.
      if (this.peek().kind === "comma") this.pos++;
    }

    if (this.peek().kind !== "rparen") {
      return {
        message: "expected ')' closing function arg list (args must be bare identifiers)",
        offset: this.peek().offset,
      };
    }
    this.pos++;

    const localNames: string[] = [];
    while (this.peek().kind === "ident" &&
           (this.peek().value === "local" || this.peek().value === "instance") &&
           this.tokens[this.pos + 1]?.kind === "lparen") {
      const declKind = this.next().value;
      const decl = this.parseFunctionNameList(declKind);
      if ("message" in decl) return decl;
      if (declKind === "local") localNames.push(...decl.names);
      // `instance(...)` names are consumed so object-style JSFX declarations
      // compile. Exact per-call namespace binding is a later compatibility
      // layer; unresolved instance names still map to persistent state vars.
    }

    if (this.peek().kind !== "lparen") {
      return { message: "expected '(' opening function body", offset: this.peek().offset };
    }
    const bodyOpen = this.peek();
    this.pos++;

    // Register the function name BEFORE translating the body, so recursive
    // calls resolve. (JS hoisting would still handle it at runtime, but our
    // resolver needs the name in hand.)
    this.userFunctions.add(fnName);

    // Push a local scope with args → JS parameter names.
    const locals = new Map<string, string>();
    const sanitizedArgs = argNames.map(a => {
      const s = sanitizeIdent(a);
      locals.set(a, `u_${s}`);
      return `u_${s}`;
    });
    const sanitizedLocals = localNames.map(a => {
      const s = sanitizeIdent(a);
      locals.set(a, `u_${s}`);
      return `u_${s}`;
    });
    this.localStack.push(locals);

    const bodyStmts: string[] = [];
    while (this.peek().kind !== "rparen" && this.peek().kind !== "eof") {
      if (this.peek().kind === "semi") { this.pos++; continue; }
      const r = this.parseExpression();
      if ("message" in r) {
        this.localStack.pop();
        return r;
      }
      bodyStmts.push(r.js);
      if (this.peek().kind === "semi") this.pos++;
    }

    this.localStack.pop();

    if (this.peek().kind !== "rparen") {
      return { message: "expected ')' closing function body", offset: bodyOpen.offset };
    }
    this.pos++;

    // EEL2 functions return the value of their last expression. If the body
    // is empty, return 0 so callers never see `undefined`.
    const head = bodyStmts.slice(0, -1).map(s => `${s};`).join("\n  ");
    const tail = bodyStmts.length > 0 ? bodyStmts[bodyStmts.length - 1] : "0";
    const localDecl = sanitizedLocals.length > 0
      ? `let ${sanitizedLocals.map(n => `${n} = 0`).join(", ")};\n  `
      : "";
    const bodyJs = head
      ? `${localDecl}${head}\n  return ${tail};`
      : `${localDecl}return ${tail};`;

    void fnTok; // suppress unused
    return {
      js: `function u_${sanitizeIdent(fnName)}(${sanitizedArgs.join(", ")}) {\n  ${bodyJs}\n}`,
      assignable: false,
    };
  }

  private parseFunctionNameList(kind: string): { names: string[] } | TranslateError {
    const start = this.peek();
    if (start.kind !== "lparen") {
      return { message: `expected '(' after ${kind}`, offset: start.offset };
    }
    this.pos++;
    const names: string[] = [];
    while (this.peek().kind !== "rparen" && this.peek().kind !== "eof") {
      const tok = this.peek();
      if (tok.kind !== "ident") {
        return { message: `${kind}(...) names must be bare identifiers`, offset: tok.offset };
      }
      names.push(tok.value);
      this.pos++;
      if (this.peek().kind === "comma") this.pos++;
    }
    if (this.peek().kind !== "rparen") {
      return { message: `expected ')' closing ${kind}(...)`, offset: start.offset };
    }
    this.pos++;
    return { names };
  }

  // SpecialCallApi ------------------------------------------------------------

  peek(): Token { return this.tokens[this.pos]; }
  next(): Token { return this.tokens[this.pos++]; }

  // Precedence (high → low):
  //   primary → postfix → unary → pow → multi → add → shift → compare →
  //   bit-and → bit-or → logAnd → logOr → ternary → assign

  parseExpression(): EmitResult { return this.parseAssignment(); }

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
    let left = this.parseShift();
    if ("message" in left) return left;
    while (true) {
      const tok = this.peek();
      if (tok.kind === "op" &&
          (tok.value === "==" || tok.value === "!=" ||
           tok.value === "<"  || tok.value === "<=" ||
           tok.value === ">"  || tok.value === ">=")) {
        this.pos++;
        const right = this.parseShift();
        if ("message" in right) return right;
        const op = tok.value === "==" ? "===" : tok.value === "!=" ? "!==" : tok.value;
        left = { js: `(${left.js} ${op} ${right.js})`, assignable: false };
      } else break;
    }
    return left;
  }

  private parseShift(): EmitResult {
    let left = this.parseAdditive();
    if ("message" in left) return left;
    while (true) {
      const tok = this.peek();
      if (tok.kind === "op" && (tok.value === "<<" || tok.value === ">>")) {
        this.pos++;
        const right = this.parseAdditive();
        if ("message" in right) return right;
        left = { js: `(${left.js} ${tok.value} ${right.js})`, assignable: false };
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
        return { js: `(~${inner.js})`, assignable: false };
      }
      return { js: `(${tok.value}${inner.js})`, assignable: false };
    }
    return this.parsePostfix();
  }

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
      node = {
        js: `mem[((${node.js}) | 0) + ((${idx.js}) | 0)]`,
        assignable: true,
      };
      currentPointerish = false;
    }
    return node;
  }

  private parsePrimary(): { result: EmitResult; pointerish: boolean } {
    const tok = this.peek();

    if (tok.kind === "num") {
      this.pos++;
      return { result: { js: tok.value, assignable: false }, pointerish: false };
    }

    if (tok.kind === "string") {
      this.pos++;
      const handler = this.resolvers.resolveStringLiteral;
      if (!handler) {
        return {
          result: { message: "string literals are not supported in this context", offset: tok.offset },
          pointerish: false,
        };
      }
      const r = handler(tok.value);
      if (r === null) {
        return {
          result: { message: "string literals are not supported in this context", offset: tok.offset },
          pointerish: false,
        };
      }
      return { result: r, pointerish: false };
    }

    if (tok.kind === "ident") {
      if (tok.value === "loop")  return { result: this.parseLoop(),  pointerish: false };
      if (tok.value === "while") return { result: this.parseWhile(), pointerish: false };

      if (this.tokens[this.pos + 1]?.kind === "lparen") {
        // Function call path — check interceptCall first (it owns arg parsing
        // when it returns non-null), otherwise fall through to standard arg
        // parsing + resolveCall.
        const name = tok.value;
        this.pos++;  // consume the ident
        const intercept = this.resolvers.interceptCall?.(name, this);
        if (intercept !== null && intercept !== undefined) {
          return { result: intercept, pointerish: false };
        }
        return { result: this.parseStandardCall(tok), pointerish: false };
      }

      this.pos++;

      // Local scope (function args) wins over everything else.
      for (let s = this.localStack.length - 1; s >= 0; s--) {
        const localJs = this.localStack[s].get(tok.value);
        if (localJs !== undefined) {
          return {
            result: { js: localJs, assignable: true },
            pointerish: false,  // function args aren't array bases
          };
        }
      }

      const resolved = this.resolvers.resolveIdent?.(tok.value) ?? null;
      if (resolved !== null) {
        return {
          result: { js: resolved.js, assignable: resolved.assignable },
          pointerish: resolved.pointerish,
        };
      }
      // User vars emit as `state.u_<sanitized>`, a property access. JS reserved
      // words are legal property keys, so EEL2 names like `in`, `case`,
      // `function` (as plain var usage) compile fine. No collision check
      // needed — REAPER presets regularly use these names.
      const sanitized = sanitizeIdent(tok.value);
      this.userVars.add(sanitized);
      return {
        result: { js: `state.u_${sanitized}`, assignable: true },
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

  /** Standard-form call: parse ( arg , arg , ... ) then hand off to the
   *  resolver. Expects the ident already consumed but `(` still present. */
  private parseStandardCall(identTok: Token): EmitResult {
    if (this.peek().kind !== "lparen") {
      return { message: `expected '(' after ${identTok.value}`, offset: identTok.offset };
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
    const call = this.resolvers.resolveCall?.(identTok.value, args) ?? null;
    if (call !== null) return { js: call.js, assignable: call.assignable ?? false };

    // Fall through to user-defined EEL2 functions before erroring.
    if (this.userFunctions.has(identTok.value)) {
      const jsName = `u_${sanitizeIdent(identTok.value)}`;
      return { js: `${jsName}(${args.join(", ")})`, assignable: false };
    }

    return {
      message: `unknown function '${identTok.value}'`,
      offset: identTok.offset,
    };
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
      const bodyStmts = [cond.js];
      while (this.peek().kind === "semi") this.pos++;
      while (this.peek().kind !== "rparen" && this.peek().kind !== "eof") {
        const r = this.parseExpression();
        if ("message" in r) return r;
        bodyStmts.push(r.js);
        while (this.peek().kind === "semi") this.pos++;
      }
      if (this.peek().kind !== "rparen") {
        return { message: "expected ')' closing while body", offset: startTok.offset };
      }
      this.pos++;
      const head = bodyStmts.slice(0, -1).map(s => `${s};`).join(" ");
      const tail = bodyStmts[bodyStmts.length - 1] ?? "0";
      return {
        js: `(() => { let _keep = 0; do { ${head} _keep = (${tail}); } while (_keep); return 0; })()`,
        assignable: false,
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
}

// Re-export types for convenience so callers import from one place.
export type { Token, TokenizeError } from "./tokenize";
