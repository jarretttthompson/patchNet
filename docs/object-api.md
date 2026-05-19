# patchNet Object API

**The authoritative contract every object must satisfy.** Source of truth is the
code; this document mirrors it with `file:line` citations. If this doc and the
code disagree, the code wins — fix the doc.

- **Milestone:** M1 (Object API Contract), task 1b.
- **Enforced by:** `validateObjectDef()` (`src/graph/objectDefs.ts`) at module
  init, and the CI gate `tests/object-spec-validation.test.ts` (fails the build
  if any registered object violates the contract).
- **Companion:** `docs/OBJECT_RECIPE.md` is the step-by-step "how to add an
  object" checklist. This file is the *reference*; that one is the *procedure*.
- **Supersedes:** `docs/object-spec-standard.md` (stale — see Appendix).

---

## 1. Overview

An "object" is a placeable node type (`button`, `metro`, `buffer~`, …). Every
type has exactly one `ObjectSpec` entry in the `OBJECT_DEFS` registry
(`src/graph/objectDefs.ts:91`, `Record<string, ObjectSpec>`). The spec is the
single declaration the rest of the app trusts: the renderer, cable layer,
serializer, parser, palette, autocomplete, and terminal all read it. An object
that misdescribes itself fails silently downstream — hence the validation gate.

`getObjectDef(type)` returns a defensively-cloned `ObjectSpec` (with an
auto-added attribute inlet for arg-only objects); callers never mutate
`OBJECT_DEFS`.

---

## 2. `ObjectSpec` interface

Verbatim, `src/graph/objectDefs.ts:34-69`:

```ts
export interface ObjectSpec {
  description: string;
  category: "ui" | "control" | "audio" | "scripting" | "visual";
  args: ArgDef[];
  messages: MessageDef[];
  inlets: PortDef[];
  outlets: PortDef[];
  defaultWidth: number;
  defaultHeight: number;
  platforms?: PlatformTarget[];
  keywords?: string[];
  derivePorts?: (args: string[]) => { inlets: PortDef[]; outlets: PortDef[] };
  ensureArgs?: (args: string[]) => string[];
}
```

| Field | Req | Type | Meaning |
|---|---|---|---|
| `description` | ✅ | `string` | One-line summary. Must be non-empty. |
| `category` | ✅ | enum (5) | `ui` \| `control` \| `audio` \| `scripting` \| `visual`. Drives render styling — see §4. |
| `args` | ✅ | `ArgDef[]` | Positional creation arguments (`node.args[]`). May be `[]`. |
| `messages` | ✅ | `MessageDef[]` | Inlet messages the object responds to. May be `[]`. |
| `inlets` | ✅ | `PortDef[]` | Static inlets. **`[]` if `derivePorts` is set** (ports are computed). |
| `outlets` | ✅ | `PortDef[]` | Static outlets. Same caveat. |
| `defaultWidth` | ✅ | `number` | Initial body width (px). Must be `> 0`. Node-level `width` overrides. |
| `defaultHeight` | ✅ | `number` | Initial body height (px). Must be `> 0`. Node-level `height` overrides. |
| `platforms` | ⬜ | `PlatformTarget[]` | Omit ⇒ available everywhere. `["native"]` ⇒ hidden in the browser build's palette/autocomplete/terminal and rendered as an inert placeholder if loaded. |
| `keywords` | ⬜ | `string[]` | Type aliases (e.g. `"trigger"`→`t`). Auto-registered in `TYPE_ALIASES` at module init. |
| `derivePorts` | ⬜ | fn | Dynamic-port hook — see §5. |
| `ensureArgs` | ⬜ | fn | Sparse-arg normalizer — see §5. |

---

## 3. Supporting types

### `ArgDef` — `src/graph/objectDefs.ts:13-23`

```ts
export interface ArgDef {
  name: string;
  type: "int" | "float" | "symbol" | "list";
  default?: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  hidden?: boolean;   // internal; omit from the attribute panel
}
```

`name` and `type` are required; everything else is optional. `default` is the
value the serializer assumes when the slot is absent. `hidden: true` keeps the
arg out of the attribute inspector — used for persisted internal state (e.g.
`buffer~`'s transport/PCM slots). `min`/`max`/`step` annotate numeric args for
the inspector (not range-enforced by validation).

### `MessageDef` — `src/graph/objectDefs.ts:25-30`

```ts
export interface MessageDef {
  inlet: number;
  selector: string;
  description: string;
  args?: string[];
}
```

`inlet` is the inlet index the message arrives on. **`-1` is a sentinel**
meaning "any inlet / control selector" (used heavily by `buffer~`) and is exempt
from the inlet-range check. `selector` is the message head (`bang`, `float`,
`record`, …). `args` is a **`string[]`** of arg descriptions (the old doc had
this as a single `string`).

### `PortDef` / `PortType` — `src/graph/PatchNode.ts:1-11`

```ts
export type PortType = "bang" | "float" | "signal" | "any" | "message" | "media";

export interface PortDef {
  index: number;
  label?: string;
  type: PortType;
  temperature?: "hot" | "cold";          // default: hot
  side?: "top" | "left" | "right";       // default: top
}
```

`index` **must equal the port's position in the array** (validated). `type` is
one of the **6** `PortType` values. `temperature` defaults to `hot` (hot inlets
trigger output; cold inlets store only). `side` defaults to `top`
(`left`/`right` are edge "side" ports, e.g. the attribute inlet).

### `PlatformTarget` — `src/graph/objectDefs.ts:32`

```ts
export type PlatformTarget = "browser" | "native";
```

---

## 4. Categories & rendering

`category` is one of `ui`, `control`, `audio`, `scripting`, `visual`. It selects
the object's render styling. **Visual/CSS rules are owned by
`DESIGN_LANGUAGE.md`** — consult it before touching appearance; do not duplicate
styling rules here. This contract only guarantees `category` is one of the five
valid values.

---

## 5. Lifecycle hooks

Two optional executable hooks. Both are pure functions of the creation `args`.

### `ensureArgs(args) => args`

Fills missing positional slots with defaults so serialization is deterministic
and positional. Set on objects with sparse/optional args (`sequencer`,
`buffer~`). Example — `ensureBufferArgs`, `src/graph/objectDefs.ts:1996-2011`:

```ts
export function ensureBufferArgs(args: string[]): string[] {
  if (args[0]  === undefined) args[0]  = "stereo";
  if (args[1]  === undefined) args[1]  = "1";
  // … through args[12] …
  return args;
}
```

### `derivePorts(args) => { inlets, outlets }`

Computes inlets/outlets from args, **overriding** the static (empty) `inlets`/
`outlets` in the spec. Set on objects whose port shape depends on args:
`t`, `pack`, `unpack`, `route`, `sequencer`, `adc~`, `dac~`, `mixer~`, `fft~`,
`js~`, `buffer~`, `reaperVideo*`, `subPatch`.

### Application order (parse time)

`src/serializer/parse.ts:248-252` — for every parsed node:

```ts
const spec = getObjectDef(type);
if (spec.ensureArgs)  args = spec.ensureArgs(args);   // 1. normalize args first
if (spec.derivePorts) ({ inlets, outlets } = spec.derivePorts(args)); // 2. then ports
```

`ensureArgs` always runs before `derivePorts` (ports may depend on normalized
args). `codebox` is a hard-coded special case — its ports derive from the code
string, not a spec hook (`parse.ts:255-257`).

---

## 6. Serialization contract

Serialization is **generic and positional — there are no per-object
serialize/deserialize hooks.** An object round-trips purely through its `args`:

- Disk form: `#X obj <x> <y> <type> <arg0> <arg1> … ;`
- `ArgDef.default` + `ensureArgs` define what a missing slot becomes on reload.
- Therefore: **arg order and defaults are a permanent compatibility surface.**
  Inserting an arg in the middle, or changing a default, breaks existing patches.
  Append new args at the end with a sensible `default`.

### Blob args

Large/binary payloads (code, PCM) use `BLOB_ARG_SCHEMA`
(`src/serializer/serialize.ts:116-165`), not plain tokens:

- `codebox` → `cb-src`; `js~` → `js-src` / `js-lib` / `js-vals`;
  `buffer~` → 13 positional slots incl. base64 PCM (`preEncoded` — passed
  through verbatim, not re-encoded).
- Two emit modes: **disk** writes full base64; **display** (`forDisplay`) writes
  a compact `~b64:…~` placeholder so the text panel stays readable.
- Empty optional blob slots that support the `-` convention (`js~` lib/vals,
  `youtube~*`) serialize as `-`.

Deep format *versioning/migration* is **M2 scope**, not covered here. This
documents only the current (v1) contract.

---

## 7. Validation rules

`validateObjectDef(type, spec)` (`src/graph/objectDefs.ts:2183-2266`) returns an
error list. **Enforced (each is an error):**

- `description` non-empty; `category` ∈ the 5 valid values.
- `args`, `messages`, `inlets`, `outlets` are arrays.
- `defaultWidth` / `defaultHeight` are numbers `> 0`.
- `platforms` (if present) is an array of only `"browser"` / `"native"`.
- Every `args[i]` has a string `name`; `args[i].type` ∈ `int|float|symbol|list`.
- Every `messages[i]` has a string `selector`.
- Every `inlets[i]` / `outlets[i]` has a string `type` **and `index === i`**.
- A `messages[i].inlet` exceeding the static inlet count is an error **only**
  when ports are static (no `derivePorts`) and `inlet !== -1`.

**Not checked (author beware — these are contract-by-convention only):**
`PortDef.label` / `temperature` / `side`; `keywords`; `ArgDef`
`min`/`max`/`step`/`default`; `MessageDef.args`; hook purity / return shape.

---

## 8. Canonical examples

### Minimal — `button` (`src/graph/objectDefs.ts:103-112`)

Static ports, no args, no hooks. The reference shape for a simple object:

```ts
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
```

### Maximal — `buffer~` (`src/graph/objectDefs.ts:900-957`)

Dynamic ports + sparse args + blob state. Exercises every optional mechanism:

- **13 `args`** including `min`/`max`/`step` numeric annotations and `hidden`
  persisted state (`transport`, `position`, base64 PCM `bufferL/R`,
  `rangeStart/End`, `storageKey`).
- `messages` use the **`inlet: -1`** sentinel for transport selectors
  (`record`, `play`, `stop`, `seek`, `range`, …) plus inlet-0 parameter setters.
- `inlets: []` / `outlets: []` — **derived** by `deriveBufferPorts`
  (`objectDefs.ts:2032-2057`): stereo ⇒ 3 in / 3 out, mono ⇒ 2 in / 2 out.
- `ensureArgs: ensureBufferArgs` (`1996-2011`) backfills all 13 slots so the
  positional blob layout is stable on disk.

```ts
"buffer~": {
  description: "Audio tape-recorder buffer. …",
  category: "audio",
  args: [ /* mode, rate, loop, maxLen, transport, position,
             bufferL, bufferR, bufferLStereo, bufferRStereo,
             rangeStart, rangeEnd, storageKey  (13 slots) */ ],
  messages: [ /* inlet 0 setters: rate/loop/maxLen;
                 inlet -1 transport: record/play/pause/stop/stereo/mono/
                 clear/seek/range/float */ ],
  inlets:  [],   // derived by deriveBufferPorts(args)
  outlets: [],   // derived by deriveBufferPorts(args)
  defaultWidth:  280,
  defaultHeight: 110,
  derivePorts: deriveBufferPorts,
  ensureArgs:  ensureBufferArgs,
},
```

These two are the M1/1c canonical exemplars and are pinned valid by
`tests/object-spec-validation.test.ts`.

---

## Appendix — reconciliation with `object-spec-standard.md`

The prior doc (2026-04-16) is superseded. Where it misled:

| Old doc claim | Reality |
|---|---|
| `ObjectSpec extends ObjectDef`; separate `ObjectDef` base | No `ObjectDef` exists. `ObjectSpec` is the sole interface (`objectDefs.ts:34-69`). |
| `category: "ui" \| "control" \| "audio"` (3) | **5**: adds `scripting`, `visual`. |
| `ArgDef.description: string` (required) | **Optional** (`description?: string`). |
| `ArgDef` has only name/type/default/description | Also `min`, `max`, `step`, `hidden`. |
| `MessageDef.args?: string` | **`string[]`**. |
| No `platforms` / `keywords` | Both exist (optional). |
| No `derivePorts` / `ensureArgs` | Both exist — core to ~14 objects. |
| §2 "one file per object in `docs/objects/`", §4 `PatchMessage` "Phase B target", §5 "all 7 existing objects" | Migration-era / aspirational; long obsolete (73 objects today). |
