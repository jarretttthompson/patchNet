# patchNet Serialization Format

**The authoritative spec for the `.patchnet` text format.** Source of truth is
the code; this document mirrors it with `file:line` citations. If this doc and
the code disagree, the code wins — fix the doc.

- **Milestone:** M2 (Serialization Stability), task 2a.
- **Implemented by:** `src/serializer/serialize.ts` (write) and
  `src/serializer/parse.ts` (read).
- **Current format version:** **v1** (default — patches are saved headerless).
  M2/b added parser-side acceptance of an optional `#N patchnet vN;` header
  (`KNOWN_VERSIONS = {1, 2}`); M2/d wired a `migrate()` dispatcher that walks
  parsed patches up to `LATEST_VERSION` (currently `2`, identity step today).
  The serializer still writes v1 — write-side flip waits for a real format
  change. See §10.
- **Companion:** `docs/object-api.md` defines the `ObjectSpec` contract
  (arg order, defaults, lifecycle hooks) that this format relies on.

---

## 1. Overview

A `.patchnet` file is a plain-text, line-based, semicolon-terminated record of
a patch graph. It serializes the nodes, the edges between them, and a small set
of per-node metadata (id, name, size, panel position, group membership).

- **Write entry:** `serializePatch(graph)` (`src/serializer/serialize.ts:246`)
  — disk form, full base64 for blob args.
- **Display entry:** `serializePatchForDisplay(graph)`
  (`src/serializer/serialize.ts:250`) — same grammar, blob args replaced with
  `~b64:…~` placeholders so the text panel stays readable.
- **Read entry:** `parsePatch(text)` (`src/serializer/parse.ts:42`) — returns
  `{ nodes, edges }`. Throws `PatchParseError` (`parse.ts:8-16`) with a line
  number on grammar/range errors.

The format is intentionally close to Pure Data's `.pd` for visual familiarity,
but it is **not** a `.pd` file — semantics, statement set, and per-object
encodings differ. Do not assume `.pd` interop.

---

## 2. File grammar

```
file        := line*
line        := whitespace? (comment | statement) "\n"?
comment     := "//" any-text
statement   := ("#N" | "#X") SP statement-body SP* ";"
statement-body := canvas-header | obj-stmt | connect-stmt
              | id-stmt | name-stmt | size-stmt | panel-stmt | group-stmt
```

- **Tokens are whitespace-separated** — the parser does
  `statement.split(/\s+/)` (`parse.ts:88`). Any run of spaces or tabs separates
  tokens; multiple spaces collapse.
- **Every statement ends in `;`** (`parse.ts:83-85`). Lines without a trailing
  semicolon are an error.
- **Comments** start with `//` and run to end of line (`parse.ts:79`); they
  are ignored at parse time and never emitted at serialize time.
- **Empty input is valid** — an empty file (or whitespace-only) parses to
  `{ nodes: [], edges: [] }` (`parse.ts:45-47`). The text panel is the source
  of truth: clearing it must clear the canvas, not raise.
- **A `#N canvas;` line must appear** (anywhere — first by convention, but the
  check is order-agnostic). Missing it is a fatal `PatchParseError`
  (`parse.ts:427-429`).

---

## 3. Header

```
#N canvas;
```

The single mandatory non-`#X` line. Carries no payload today — it's a
file-type marker. **v1** patches consist of this header plus any number of
`#X` statements.

The serializer emits exactly one `#N canvas;` as the first line
(`serialize.ts:206`). The parser tolerates it appearing anywhere
(`parse.ts:134-137`).

> **Optional version line.** As of M2/b, the parser also accepts an optional
> `#N patchnet vN;` immediately before `#N canvas;` — see §10. Patches without
> this line are treated as **v1** (the historical default).

---

## 4. Object lines (`#X obj`)

```
#X obj <x> <y> <type> <arg0> <arg1> … ;
```

The core node-declaration line. Per-token contract:

| Token | Meaning | Constraints |
|---|---|---|
| `<x>` | Canvas X (px) | Finite number. Rounded to int on write (`serialize.ts:117`); read as `Number()` (`parse.ts:148`). |
| `<y>` | Canvas Y (px) | Same. |
| `<type>` | Object type | Passed through `canonicalizeType` (`parse.ts:155`) to resolve aliases (e.g. `trigger`→`t`). Must exist in `OBJECT_DEFS`. |
| `<args…>` | Positional creation args | Count + meaning defined by the object's `ObjectSpec.args` (see `docs/object-api.md §6`). Missing slots filled by `ensureArgs`. |

The post-parse pipeline for every object line (`parse.ts:293-307`):

1. **`ensureArgs(args)`** if defined on the spec — backfills sparse positional
   slots so the serialization layout is deterministic.
2. **`derivePorts(args)`** if defined on the spec — replaces the static
   inlets/outlets in the spec with dynamic ports computed from args.
3. **`codebox` special case** — ports derive from the code string itself
   (`parse.ts:305-307`), not via `derivePorts`.

This is the same `ensureArgs → derivePorts` order documented in
`docs/object-api.md §5`.

### Special-case encodings

Most objects encode args as plain whitespace-separated tokens. **Five types**
have special encoding handled in the serializer/parser:

| Type | Encoding | Code |
|---|---|---|
| `codebox`     | `<language> <base64-source>` (2 slots). Source is **always** base64-encoded; no `-` convention. | `serialize.ts:139-142`, `parse.ts:161-181` |
| `js~`         | `<base64-source> <base64-lib\|"-"> <locked 0\|1> <base64-vals\|"-">` (4 slots). | `serialize.ts:143-151`, `parse.ts:184-227` |
| `reaperVideo*`| `<base64-source> <base64-lib\|"-"> <locked 0\|1> <base64-vals\|"-">` (4 slots). | `serialize.ts:189-197`, `parse.ts:230-273` |
| `buffer~`     | 13 positional slots; PCM args 6-9 are pre-encoded base64 at runtime + emit `-` when empty; storageKey arg 12 emits `-` when empty. | `serialize.ts:163-188`, `parse.ts:276-282` |
| `youtube~*`   | `<url\|"-"> <videoId\|"-"> <startSeconds> <captureOnLoad 0\|1> <locked 0\|1>` (5 slots). | `serialize.ts:152-162`, `parse.ts:285-291` |

All other 68 object types fall through to the generic
`parts.push(...node.args)` path (`serialize.ts:198-200`) — tokens written and
read verbatim.

---

## 5. Edges (`#X connect`)

```
#X connect <srcIdx> <srcOutlet> <tgtIdx> <tgtInlet>;
```

All four values are integers. Indices reference the position of the source /
target node in declaration order — the *Nth* `#X obj` in the file is node `N-1`
(0-indexed). Outlet / inlet are 0-indexed port positions on that node.

Validation (`parse.ts:443-463`):

- Source/target node index must resolve to a parsed node.
- `srcOutlet` must be `0 ≤ outlet < outlets.length`.
- `tgtInlet` must be `0 ≤ inlet < inlets.length`, *except* on
  `attribute`/`subPatch` nodes, which build inlets dynamically post-parse —
  range validation is skipped for those (`parse.ts:460-463`).

Out-of-range indices raise `PatchParseError`.

---

## 6. Per-node metadata lines

These statements augment an already-declared `#X obj` line. The first int
after the keyword is the **node index** (declaration order, 0-indexed).

### `#X id <idx> <uuid>;` — node identity (`parse.ts:355-367`, `serialize.ts:214`)

Persists the node's runtime `id` (UUID). Without this, every parse generates
fresh IDs and `PatchGraph.deserialize`'s diff-based update can't preserve
runtime state (audio buffers, blob storage keys, etc.). Applied
*before* edges are built so connections reference persisted UUIDs
(`parse.ts:431-436`).

### `#X name <idx> <name>;` — display name (`parse.ts:369-386`, `serialize.ts:215-217`)

Optional human-set name for the node. Validated by `validateNodeName`
(`src/graph/nodeNames.ts`); invalid names raise `PatchParseError`. Omitted
when `node.name` is unset.

### `#X size <idx> <w> <h>;` — node body size (`parse.ts:388-398`, `serialize.ts:218-220`)

Optional. Both `w` and `h` must be finite numbers; written when both are
present on the node.

### `#X panel <idx> <x> <y> [<w> [<h>]];` — attribute-panel position (`parse.ts:400-412`, `serialize.ts:221-225`)

Tracks the panel UI's position/size **independently** of the node's
`x`/`y`/`width`/`height`. Width and height are optional trailing tokens.

### `#X group <idx0> <idx1> [<idx2>…];` — node grouping (`parse.ts:414-422`, `serialize.ts:254-269`)

Declares that two or more nodes share a group. Serializer emits only groups
with ≥ 2 members (`serialize.ts:266`). On parse, each group statement gets a
fresh UUID assigned to every member's `groupId` (`parse.ts:494-500`).

---

## 7. Blob args

Some args hold large or binary payloads (source code, PCM buffers). They are
encoded with one of three patterns: **base64-on-disk**, **preEncoded
pass-through**, or **empty `-` marker**. The schema is in `BLOB_ARG_SCHEMA`
(`src/serializer/serialize.ts:65-83`):

```ts
const BLOB_ARG_SCHEMA: Record<string, BlobSlot[]> = {
  codebox:        [{ index: 1, label: "cb-src",  summarize: lineSummary, drivesPorts: true }],
  "js~":          [
    { index: 0, label: "js-src",  summarize: lineSummary, drivesPorts: true },
    { index: 1, label: "js-lib",  summarize: librarySummary },
    { index: 3, label: "js-vals", summarize: valuesSummary },
  ],
  "reaperVideo*": [ /* same shape as js~ */ ],
  "buffer~":      [
    { index: 6, label: "buf-L",   summarize: pcmSummary, preEncoded: true },
    { index: 7, label: "buf-R",   summarize: pcmSummary, preEncoded: true },
    { index: 8, label: "buf-Ls",  summarize: pcmSummary, preEncoded: true },
    { index: 9, label: "buf-Rs",  summarize: pcmSummary, preEncoded: true },
  ],
};
```

### `BlobSlot` flags

| Flag | Meaning |
|---|---|
| `drivesPorts` | The slot's content determines the node's inlets/outlets (e.g. codebox's source string). When the slot holds a *display placeholder* on read, `PatchGraph.deserialize` must preserve the in-memory node's existing ports instead of running port derivation against a placeholder. |
| `preEncoded` | The runtime value at `args[index]` is **already base64** (canonical example: `buffer~` PCM, kept as base64 in memory). On the disk path, `emitBlob` passes the value through verbatim instead of re-encoding (`serialize.ts:133-135`); on the display path, summary is computed against the base64 directly. |

### The `-` empty-marker convention

For `js~ / reaperVideo*` library + values, `buffer~` PCM slots and `storageKey`, and `youtube~*`
url / videoId: an empty value serializes as a single `-` (`serialize.ts:129,132,188`; `parse.ts:204,168,200,214,229,231,236-237`). On read,
`-` (or missing) is normalized back to the empty string. This keeps line
length sane and makes empty/non-empty trivially distinguishable when
hand-reading. `codebox` source has no `-` convention — it always encodes (even
empty string → base64 of empty string).

### Display placeholders

When `forDisplay: true` is set, blob args are written as:

```
~b64:<label>:<6-hex-hash>:<summary>~
```

- Label is the `BlobSlot.label` (e.g. `cb-src`, `js-lib`, `buf-L`).
- Hash is a 6-hex-char `djb2` digest of the decoded value (`serialize.ts:87-94`).
  Stable, fast, non-cryptographic — only meant to make the placeholder *change
  visibly* when the underlying content changes.
- Summary is a one-token, type-specific human-readable hint produced by the
  slot's `summarize` callback (lines for source, `Nfx` for library JSON, `Nsmp`
  for PCM, etc.).

Placeholder regex: `/^~b64:[A-Za-z0-9_-]+:[0-9a-f]+:[^~\s]+~$/`
(`serialize.ts:101`). Whitespace-free by construction so they round-trip
through the same `split(/\s+/)` tokenizer.

**Display tokens are valid input.** The parser detects them via
`isBlobPlaceholder` and keeps them in-place rather than trying to decode
them (`parse.ts:164, 139, 152, 166, 185, 198, 212`). `PatchGraph.deserialize`
treats them as "preserve the in-memory node's runtime value here." This is
what makes the text-panel ↔ canvas round-trip safe.

---

## 8. Disk vs display serialization

Both `serializePatch` and `serializePatchForDisplay` produce **the same grammar**
— same statements, same per-node metadata, same edge syntax. The *only*
difference is how `BlobSlot` args are rendered:

| Mode | API | Blob arg encoding | Use |
|---|---|---|---|
| Disk | `serializePatch(graph)` | Full base64 (or `-` if empty + supported) | Save to file, autosave, send to peer. |
| Display | `serializePatchForDisplay(graph)` | `~b64:label:hash:summary~` placeholder | Render in the text panel. |

Round-trip rules:

- **Disk → parse → disk** is byte-identity for stable graphs.
- **Display → parse → display** is also stable: placeholders re-parse to
  placeholders, runtime state preserved by `PatchGraph.deserialize`.
- **Display → parse → disk is lossy** (placeholders can't reconstitute the
  original PCM/source by themselves). The display-write path is only meant for
  the text panel, never for save.

---

## 9. Compatibility surface

The following are **format invariants** — changing any of them is a breaking
change that requires a version bump:

1. **Statement-line grammar** — `#N canvas;`, the five `#X` statements, the `;`
   terminator, the `//` comment, the `\s+` tokenizer.
2. **Per-object arg order** (defined by `ObjectSpec.args`).
3. **Per-object arg defaults** (via `ensureArgs` or `ArgDef.default`).
4. **`BLOB_ARG_SCHEMA` slot indices and labels** — the label is part of the
   display placeholder grammar.
5. **The `-` empty-marker convention** for the slots that use it.
6. **Display placeholder regex** — `~b64:label:hash:summary~`.

The following can change without a version bump (they are **not** part of the
format):

- Object semantics that don't affect arg layout (e.g. internal audio routing).
- `summarize` callbacks (the summary token is human-facing, not parsed back).
- The 6-char hash truncation length (purely cosmetic; the hash is never read).

**Adding a new object** is not a format change — the generic path covers it.

**Adding a new arg to an existing object** is a format change in the sense
that it expands the positional layout, but is backward-compatible *if and
only if* `ensureArgs` (or `ArgDef.default`) provides a value for the new slot
when missing. Old patches without the new arg must continue to parse. **Never
insert in the middle** — always append.

**Adding a blob slot** to an existing object means adding to
`BLOB_ARG_SCHEMA`. Backward-compatible by the same rule: the new slot must
default to empty/`-` when absent.

---

## 10. Versioning

**v1** = the historical default: no version header. Today this is how every
patch is saved.

**Optional version header** (M2/b, implemented):

```
#N patchnet v2;
#N canvas;
…
```

Parser behavior (`parse.ts:99-130`):

- Accepts an optional `#N patchnet v<digits>;` as the **first** non-comment
  statement (`parse.ts:100-105` enforces ordering — a version header later in
  the file is a `PatchParseError`).
- Validates the numeric version against an exported `KNOWN_VERSIONS` set
  (currently `{1, 2}`, `parse.ts:30`); unknown versions raise a clear
  `PatchParseError` (`parse.ts:120-126`).
- Treats absence of the header as v1.
- Exposes the parsed value as `ParsedPatch.version` (`parse.ts:18-25`) so the
  M2/d migration dispatcher can branch on it.

v1 and v2 share the same grammar today — v2 is reserved so the upgrade path
is wired before any v2-specific format change actually lands. The serializer
does **not** yet write the header; patches saved today are headerless v1. The
moment a v2-specific format change exists, the serializer flips on the
`#N patchnet v2;` emit, and the existing parser already knows what to do with
it.

**Why ship the parser side before the writer side?** Forward compatibility.
Every release from this point forward reads v2 patches. Whenever v2 actually
diverges from v1, patches saved by old binaries (no header → v1) keep
working, and patches saved by new binaries (header → v2) are unambiguous on
disk. Adding the parse-side acceptance first means the upgrade is a
single-release flip, not a coordinated two-step.

**Adding a v3 later** is a 3-step change: extend `KNOWN_VERSIONS` to include
3, add the v2→v3 migration in the M2/d dispatcher, and (when ready) switch
the serializer to write v3. Old v2 readers reject v3 patches with a clear
error rather than silently mis-parsing them.

### Migration dispatcher (M2/d — implemented)

`src/serializer/migrate.ts` exports:

- `LATEST_VERSION` — currently `2`. The version every parsed patch is
  normalized to before the rest of the app touches it.
- `migrate(patch: ParsedPatch) => ParsedPatch` — walks the patch up to
  `LATEST_VERSION` by applying every registered step in
  `STEPS[fromVersion]`. Pure; never mutates its input. Today the only
  registered step is `v1→v2` (identity-with-relabel), so a v1 patch comes
  out as v2 with the same nodes/edges; a v2 patch passes through unchanged.

The dispatcher is wired into `PatchGraph.deserialize` so consumers don't
need to remember to call it (`src/graph/PatchGraph.ts`, after `parsePatch`).
Tests calling `parsePatch` directly (e.g. the version-header test suite)
see the raw on-disk version; tests going through `PatchGraph` (e.g.
per-object round-trip) see post-migration state.

**To ship v3 later:** (1) extend `KNOWN_VERSIONS` to include `3` in
`parse.ts`, (2) register `STEPS[2] = (p) => /* v2 → v3 transform */` in
`migrate.ts`, (3) bump `LATEST_VERSION` to `3`. The dispatch walks
automatically.

---

## 11. Errors

All read errors are `PatchParseError` (`parse.ts:8-16`) with a 1-indexed
`line` field. Cases:

| Trigger | Message | Where |
|---|---|---|
| Line lacks `;` | `Missing trailing semicolon` | `parse.ts:83-85` |
| Statement is just one token | `Incomplete statement` | `parse.ts:91` |
| Line starts with neither `#N` nor `#X` | `Unsupported statement` | `parse.ts:139` |
| Line starts with `#N` but isn't `#N canvas` | falls through to `#X` path → `Unknown line prefix` | `parse.ts:141-143` |
| `#X obj` < 5 tokens | `Object lines must include x, y, and type` | `parse.ts:146` |
| `#X obj` with non-numeric coords | `Object coordinates must be numeric` | `parse.ts:151-153` |
| `#X connect` < 6 tokens / non-int values | `Connect lines must include …` / `Connect values must be integers` | `parse.ts:331-341` |
| `#X connect` references a missing node | `Connect statement references an object index that does not exist` | `parse.ts:447-451` |
| Connect endpoint outlet/inlet out of range | `Source outlet index is out of range` / `Target inlet index is out of range` | `parse.ts:454-462` |
| `#X id` malformed | `Id lines must include node index and UUID` / `Id node index must be an integer` / `Id value missing` | `parse.ts:356-364` |
| `#X name` with invalid name | message from `validateNodeName` | `parse.ts:376-383` |
| `#X size` malformed | `Size lines must include node index, width, and height` / `Size values must be numeric` | `parse.ts:389-395` |
| `#X panel` malformed | `Panel lines must include node index, x, and y` / `Panel values must be numeric` | `parse.ts:401-406` |
| `#X group` < 4 tokens / non-int indices | `Group lines must include at least two node indices` / `Group node indices must be integers` | `parse.ts:415-419` |
| Unknown `#X` keyword | `Unsupported #X statement: <keyword>` | `parse.ts:424` |
| No `#N canvas;` anywhere | `Patch must start with #N canvas;` (raised on line 1) | `parse.ts:427-429` |
| `#N patchnet …;` not at the start of the file | `Version header (#N patchnet vN;) must be the first statement` | `parse.ts:100-105` |
| `#N patchnet;` with no version token | `Version header missing version token (expected \`#N patchnet vN;\`)` | `parse.ts:106-111` |
| `#N patchnet vfoo;` / non-`v<digits>` version | `Malformed version token "…" (expected "v<digits>")` | `parse.ts:113-117` |
| `#N patchnet v0;` / `v99;` / any version ∉ `KNOWN_VERSIONS` | `Unknown patchnet format version v<n> (known: v1, v2)` | `parse.ts:120-126` |

Per-object decode failures (codebox/js~/reaperVideo source base64 corrupted)
are **non-fatal**: a `console.warn` is logged and the slot is treated as empty
(`parse.ts:168-172, 142-148, 188-194, 215-221`). Rationale: a single bad blob
shouldn't make the whole patch unloadable.

---

## 12. Reference grammar (BNF-ish)

```
file        := version? statement*
version     := "#N" "patchnet" "v" digits ";"           ; optional, must precede everything else
statement   := (canvas | obj | connect | id | name | size | panel | group) ";"
canvas      := "#N" "canvas"
obj         := "#X" "obj" int int type arg*
connect     := "#X" "connect" int int int int
id          := "#X" "id" int uuid
name        := "#X" "name" int symbol
size        := "#X" "size" int number number
panel       := "#X" "panel" int number number number? number?
group       := "#X" "group" int int int*

type        := one of the types in OBJECT_DEFS (post-canonicalizeType)
arg         := token | blob-arg | "-"
blob-arg    := base64-symbol | display-placeholder
display-placeholder := "~b64:" label ":" hex6 ":" summary "~"

token       := /[^\s;]+/   (the parser tokenizes by /\s+/)
int         := /-?\d+/
number      := /-?\d+(\.\d+)?/   (parsed with Number(); NaN → error)
symbol      := /\S+/         (validated by validateNodeName for #X name)
uuid        := /\S+/         (no format check; stored as-is)
digits      := one of `KNOWN_VERSIONS` (currently "1" or "2"; unknown → error)
```

v1 and v2 share this grammar; the `version` line is optional (absence ⇒ v1).
The version distinction is reserved for the first format-breaking change —
see §10.
