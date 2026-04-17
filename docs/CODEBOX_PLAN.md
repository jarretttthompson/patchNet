# patchNet codebox — Implementation Plan

Working plan for adding a `codebox` object to patchNet.
This is an agent-facing architecture and sequencing doc, not a user-facing spec.
Last updated: 2026-04-16

---

## Purpose

`codebox` is a scriptable object whose inlet and outlet layout is derived from the code it contains.
It is the escape hatch object for patchNet: when the built-in object suite is too small, the user can
write code inside the patch and still participate in the same graph, serializer, and canvas model.

Unlike Max's `codebox`, patchNet's version is not audio-only. The long-term design is multi-domain:

| Domain | First language | Execution model |
|--------|----------------|-----------------|
| Data / messages | JavaScript | `Function()` on main thread, later optional `Worker` |
| Audio / signal | JavaScript | `AudioWorkletProcessor` |
| Video / shader | GLSL | WebGL2 fragment shader |
| Optional scripting | Lua / Python | External runtime bridges |

The implementation should ship in phases. Only the JavaScript data/message version belongs in the
first real milestone.

---

## Current Baseline

This plan assumes the current codebase state, not the original Phase 1 scaffold:

- `ObjectSpec` already exists in [src/graph/objectDefs.ts](/Users/user/vibing/patchNet/src/graph/objectDefs.ts).
- `message` is already a real object type, so `codebox` will be the 8th shipped object, not the 7th.
- `PortType` currently includes `"bang" | "float" | "signal" | "any" | "message"` in [src/graph/PatchNode.ts](/Users/user/vibing/patchNet/src/graph/PatchNode.ts).
- `ObjectInteractionController` already owns UI/control message delivery and metro timing.
- The text format is PD-inspired and line-oriented, so raw multiline code cannot be serialized directly without escaping.

Any codebox implementation needs to fit those constraints instead of replacing them.

---

## Product Definition

### What the user experiences

The user places a `codebox` object on the canvas, edits code inline, and the object grows ports based on
reserved identifiers found in the code. When a message arrives at an inlet, the code executes and may emit
values on its outlets.

Example:

```javascript
out1 = in1 * 2;
```

If this is the source:

- the object gets 1 inlet and 1 outlet
- a value arriving on inlet 0 becomes `in1`
- assigning `out1` fires outlet 0 with the assigned value

### Scope boundaries

In the first shipping phase, `codebox` should:

- support JavaScript only
- handle message/data flow only
- use dynamic inlets/outlets derived from code
- surface syntax/runtime errors inline
- serialize cleanly through the existing text patch format

It should not, in the first phase:

- run audio-rate DSP
- process video frames
- expose DOM, network, storage, or arbitrary globals
- invent a separate save format

---

## Object Contract

`codebox` should be defined as an `ObjectSpec` entry in `src/graph/objectDefs.ts`.

### Proposed `ObjectSpec`

```typescript
codebox: {
  description: "Scriptable object with dynamic ports derived from code.",
  category: "scripting",
  args: [
    {
      name: "language",
      type: "symbol",
      default: "js",
      description: "Active language. Phase 1 supports only js.",
    },
    {
      name: "code",
      type: "symbol",
      default: "",
      description: "Serialized source code.",
    },
  ],
  messages: [
    { inlet: 0, selector: "bang", description: "execute with bang on inlet 0" },
    { inlet: 0, selector: "float", description: "execute with a numeric input" },
    { inlet: 0, selector: "symbol", description: "execute with a string input" },
    { inlet: 0, selector: "set", description: "replace code without executing" },
  ],
  inlets: [],
  outlets: [],
  defaultWidth: 260,
  defaultHeight: 120,
}
```

### Required type changes

`ObjectSpec.category` currently only allows `"ui" | "control" | "audio"`.
Add `"scripting"` to that union before introducing the object.

No new category-specific rendering system is needed. `ObjectRenderer` only needs enough branching to:

- add `patch-object--scripting`
- mount the code editor inside the object body
- preserve the existing port/header conventions

---

## Port Convention

Dynamic ports are derived from reserved variable names in the source.

### Phase 1: JavaScript data/message identifiers

| Identifier | Meaning | Port type |
|------------|---------|-----------|
| `in1`, `in2`, ... | Data/message inlet N | `"any"` |
| `bang1`, `bang2`, ... | Bang-only inlet N | `"bang"` |
| `out1`, `out2`, ... | Data/message outlet N | `"any"` |

### Later phases

| Identifier | Meaning | Port type |
|------------|---------|-----------|
| `sig_in1`, `sig_in2`, ... | Audio signal inlet | `"signal"` |
| `sig_out1`, `sig_out2`, ... | Audio signal outlet | `"signal"` |
| `vid_in1`, `vid_in2`, ... | Video input | `"video"` |
| `vid_out1`, `vid_out2`, ... | Video output | `"video"` |

### Port derivation rule

Port count is derived from the highest referenced index.

Examples:

- `in1` and `out1` -> 1 inlet, 1 outlet
- `in1` and `in3` -> 3 inlets, with inlet 1 treated as a gap and defaulted to `"any"`
- `bang2` only -> 2 inlets, inlet 0 defaulting to `"any"` and inlet 1 typed as `"bang"`

### Phase 1 parser strategy

Use fast regex scanning first. Do not build a full AST parser in the first milestone.

Suggested helpers:

```typescript
function collectIndexedMatches(code: string, pattern: RegExp): number[] {
  return [...code.matchAll(pattern)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function derivePortsFromJavaScript(code: string): { inlets: PortDef[]; outlets: PortDef[] } {
  const anyInputs = collectIndexedMatches(code, /\bin(\d+)\b/g);
  const bangInputs = collectIndexedMatches(code, /\bbang(\d+)\b/g);
  const outputs = collectIndexedMatches(code, /\bout(\d+)\b/g);

  const inletCount = Math.max(0, ...anyInputs, ...bangInputs);
  const outletCount = Math.max(0, ...outputs);

  const inlets = Array.from({ length: inletCount }, (_, index) => {
    const nth = index + 1;
    const isBang = bangInputs.includes(nth);

    return {
      index,
      type: isBang ? "bang" : "any",
      label: isBang ? `bang${nth}` : `in${nth}`,
    };
  });

  const outlets = Array.from({ length: outletCount }, (_, index) => ({
    index,
    type: "any" as const,
    label: `out${index + 1}`,
  }));

  return { inlets, outlets };
}
```

This is intentionally simple and good enough for the first phase.

---

## Execution Model

## Phase 1: JavaScript data/message execution

The first version should execute JavaScript synchronously on incoming messages.

### Inputs

On delivery to inlet `N`:

- `inN` gets the incoming value for that execution
- all other `in*` values are `undefined`
- `bangN` receives `true` when the incoming message is a bang and the port exists

### Outputs

The script may assign `out1`, `out2`, etc.
After execution, any defined `outN` should be dispatched through the graph.

### Allowed globals

Only explicitly injected values should be available:

- `Math`
- `JSON`
- `Number`
- `String`
- `Boolean`
- `parseFloat`
- `parseInt`
- `isNaN`
- `isFinite`
- `structuredClone`
- a restricted `console` with `log` and `warn`

Do not expose `window`, `document`, `fetch`, `localStorage`, `Function`, or `eval`.

### Suggested wrapper

```typescript
const runner = new Function(
  ...inputNames,
  "Math",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "parseFloat",
  "parseInt",
  "isNaN",
  "isFinite",
  "structuredClone",
  "console",
  `
  let out1, out2, out3, out4, out5, out6, out7, out8;
  ${userCode}
  return { out1, out2, out3, out4, out5, out6, out7, out8 };
  `,
);
```

### Value normalization

Before dispatching `outN`, normalize the result:

| JS value | Outgoing patch value |
|----------|----------------------|
| `number` | stringified float/int |
| `string` | raw string |
| `boolean` | `"1.0"` or `"0.0"` |
| `null` / `undefined` | do not dispatch |
| arrays / objects | JSON string in Phase 1 |

Do not invent a richer typed message union in the codebox milestone alone. If the project later
upgrades dispatch beyond raw strings/bangs, codebox should adapt to that shared abstraction.

---

## Editor Architecture

### Editor choice

Use CodeMirror 6, not Monaco.

Reasons:

- smaller dependency surface
- modular language packages
- no VS Code worker/runtime overhead
- easier DOM embedding inside a patch object

### Phase 1 dependencies

Add only what Phase 1 needs:

- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/lang-javascript`

Defer linting and autocompletion packages until the object is stable.

### Embedded editor contract

Each live `codebox` node needs an editor instance mounted into its object body.
That lifecycle should not live in `ObjectRenderer`, which should stay mostly declarative.

Instead:

- `ObjectRenderer` renders a `.patch-object-codebox-host` placeholder
- `CodeboxController` mounts CodeMirror into that host after render
- `CodeboxController` owns editor state, code persistence, error markers, and debounced port re-parsing

### UI requirements

The box should render:

- a header showing `codebox`
- a small language badge such as `JS`
- the editor filling the main body
- inline error styling
- no resize handle work beyond whatever the canvas already provides

Min dimensions:

- width: 260px
- height: 120px

Auto-growth is optional. Manual resize support can come later.

---

## Controller Design

Create `src/canvas/CodeboxController.ts`.

### Responsibilities

- mount and unmount CodeMirror instances
- persist editor text into `node.args[1]`
- keep language mode in `node.args[0]`
- debounce code scans and rebuild `node.inlets` / `node.outlets`
- execute JavaScript code on incoming messages
- surface syntax/runtime errors in the editor
- clean up editors for deleted nodes

### Proposed API

```typescript
export class CodeboxController {
  constructor(
    private readonly graph: PatchGraph,
    private readonly dispatchBang: (fromNodeId: string, outlet: number) => void,
    private readonly dispatchValue: (fromNodeId: string, outlet: number, value: string) => void,
  ) {}

  mountEditor(node: PatchNode, host: HTMLElement): void;
  unmountEditor(nodeId: string): void;
  pruneEditors(activeNodeIds: Set<string>): void;

  executeBang(node: PatchNode, inlet: number): void;
  executeValue(node: PatchNode, inlet: number, value: string): void;

  destroy(): void;
}
```

### Why dispatch callbacks are injected

`CodeboxController` should not duplicate graph traversal logic or know about cable dispatch details.
It should reuse the existing `ObjectInteractionController` dispatch path by calling back into it.

That keeps message delivery consistent across objects.

---

## Integration Points

### `src/graph/objectDefs.ts`

- add `"scripting"` category support
- add the `codebox` object spec

### `src/canvas/ObjectRenderer.ts`

- render `codebox` shell markup and editor host
- use `node.width` / `node.height` when present, otherwise defaults

### `src/canvas/ObjectInteractionController.ts`

- add `codebox` cases to bang/value delivery
- delegate execution to `CodeboxController`
- keep non-codebox object behavior untouched

### `src/main.ts`

- instantiate `CodeboxController`
- hand it the graph and dispatch callbacks
- ensure it is pruned on re-render and destroyed on teardown

### `src/shell.css`

- add scripting-object styles
- style editor host, badge, focus state, and error state

### `package.json`

- add CodeMirror dependencies

---

## Serialization Plan

This is the part that must be explicit. The existing serializer is line-oriented and uses spaces and
semicolons as delimiters. Raw code in `node.args[1]` will break the format as soon as the user types
spaces, semicolons, or newlines.

### Required rule

When serializing a `codebox` node:

- `args[0]` stays as plain language text, for example `js`
- `args[1]` is base64-encoded before writing to the `#X obj` line

Example:

```text
#X obj 120 80 codebox js b3V0MSA9IGluMSAqIDI7;
```

### Parser rule

When parsing a `codebox` node:

- decode the final argument from base64 back into source text
- if decoding fails, surface a parse error instead of silently corrupting the code

### Why base64 instead of URL encoding

Base64 is better here because:

- it is delimiter-safe in a space-separated format
- it preserves multiline content exactly
- it avoids percent-decoding ambiguity and human-edited partial escapes

### Important note

Port definitions are still dynamic runtime state. They should not be serialized separately.
After parsing a `codebox`, the runtime should derive ports from the decoded code and language.

---

## Error Model

There are two distinct failure classes and both need dedicated handling.

### Syntax / compile errors

These happen when building the JavaScript runner.

Behavior:

- execution aborts
- no outlets fire
- error state is shown inline in the editor
- console logs a structured warning for debugging

### Runtime errors

These happen when the compiled code throws during execution.

Behavior:

- execution aborts for that message only
- no outlets fire for that execution
- editor shows the last runtime error state
- graph and app remain alive

### Minimum inline error UI

Phase 1 does not need a full diagnostic engine.
It only needs:

- a red border or gutter marker on the editor
- a short error text area or tooltip
- clearing the error when execution succeeds or the code changes

---

## Phase Plan

## Phase A — Data-only JavaScript codebox

Goal: ship a useful codebox for message/data patches.

### Files to create or change

| File | Change |
|------|--------|
| `src/graph/objectDefs.ts` | Add `"scripting"` category and `codebox` spec |
| `src/canvas/CodeboxController.ts` | New controller for editor lifecycle, port parsing, execution, and error state |
| `src/canvas/ObjectRenderer.ts` | Render codebox chrome and editor host |
| `src/canvas/ObjectInteractionController.ts` | Delegate bang/value delivery to `CodeboxController` |
| `src/serializer/serialize.ts` | Base64-encode codebox source |
| `src/serializer/parse.ts` | Decode codebox source and rebuild dynamic ports |
| `src/shell.css` | Add codebox styling |
| `src/main.ts` | Wire controller lifecycle |
| `package.json` | Add CodeMirror deps |

### Acceptance criteria

- A placed `codebox` renders with an embedded JS editor
- Typing `out1 = in1 * 2;` creates 1 inlet and 1 outlet
- Slider -> codebox doubles values downstream
- `out1 = "bang"` emits `"bang"` as a normal string value; actual bang dispatch is reserved for explicit bang behavior
- Syntax errors do not crash the app
- Code persists through serialize -> parse round trip

### Non-goals

- AST-accurate parsing
- autocomplete
- Worker isolation
- audio or video support

## Phase B — JavaScript audio mode

Goal: support `sig_in*` and `sig_out*` using `AudioWorklet`.

### Changes

- extend port derivation for signal variables
- compile user DSP body into an `AudioWorkletProcessor`
- bridge message-rate parameters to the worklet

### Files

| File | Change |
|------|--------|
| `src/runtime/AudioRuntime.ts` | Reuse existing audio runtime entry point |
| `src/runtime/CodeboxWorklet.ts` | Worklet registration and source generation |
| `src/canvas/CodeboxController.ts` | Detect and manage worklet mode |

### Acceptance criteria

- `codebox` can produce `signal` output and connect to `dac~`
- message/data-only codeboxes still use the light synchronous path

## Phase C — GLSL video mode

Goal: support `vid_in*` and `vid_out*` via WebGL2.

### Required type addition

Add `"video"` to `PortType`.

### Files

| File | Change |
|------|--------|
| `src/runtime/VideoRuntime.ts` | WebGL2 program compile, texture binding, output surface |
| `src/canvas/CodeboxController.ts` | Shader compilation and runtime delegation |
| `src/graph/PatchNode.ts` | Add `"video"` port type |

### Acceptance criteria

- video input -> GLSL codebox -> video output works for a simple fragment transform
- shader compile errors surface inline

## Phase D — Optional Lua and Python

Goal: add additional scripting runtimes after JavaScript is stable.

### Runtime choices

| Language | Runtime | Tradeoff |
|----------|---------|----------|
| Lua | Fengari | Lightweight, good for scripting |
| Python | Pyodide | Heavy but powerful; lazy-load only |

### Files

| File | Change |
|------|--------|
| `src/runtime/LuaRuntime.ts` | Execute Lua with injected variables |
| `src/runtime/PythonRuntime.ts` | Lazy-load Pyodide and execute code |
| `src/canvas/CodeboxController.ts` | Route execution by language |

### Acceptance criteria

- language badge switches runtime
- non-JS runtimes load only on demand

---

## Risks

### Main-thread execution

`Function()` execution on the page thread is acceptable for the first message/data milestone, but it is
not an ideal long-term sandbox.

Deferred mitigation:

- move data execution into a `Worker`
- keep the main-thread path only for local development if needed

### Regex-based port parsing

Regex scanning will misread some strings/comments.
That is acceptable in Phase A if documented.
If it becomes a real usability problem, replace it later with a JS parser such as Acorn.

### Dynamic port churn

Every code edit can change the inlet/outlet count.
That can invalidate existing edges.

Required rule:

- on port rebuild, drop edges that reference ports that no longer exist
- emit a graph change so the canvas and text view stay honest

Do not leave orphaned edges in the model.

### Editor lifecycle complexity

DOM re-renders can destroy editor hosts.
The implementation should key editors by `node.id` and make mounting idempotent.

---

## Recommended Delivery Order

1. Update docs and object spec expectations.
2. Add the `codebox` `ObjectSpec` and serializer/parser support.
3. Add `CodeboxController` with plain text persistence and dynamic ports before embedding CodeMirror.
4. Embed CodeMirror and error state.
5. Wire execution into `ObjectInteractionController`.
6. Only after Phase A ships, consider audio and video modes.

This order reduces risk because serialization and graph integrity matter more than editor polish.

---

## Definition of Done for Phase A

Phase A is complete when all of the following are true:

- `codebox` can be created from the object menu
- code edits persist in `node.args`
- ports rebuild from source changes
- invalid edges are removed when ports shrink
- inlet messages execute code and dispatch outputs
- inline error state works for syntax and runtime failures
- patch text round-trips without corrupting multiline code
- `npm run build` passes after the implementation lands

Anything short of that is still an experimental branch, not a shipped object.
