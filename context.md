# patchNet — Graph Serialization & Canvas↔Text Sync

## 1. Text Serialization (in-memory graph ↔ text format)

| File                              | Role                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`src/serializer/serialize.ts`** | Converts `PatchGraph` → text. Exports `serializePatch()` (full base64 for disk) and `serializePatchForDisplay()` (compact `~b64:label:hash:summary~` placeholders for the text panel). Handles per-type blob args (codebox, js~, buffer~, reaperVideo\*).                                                         |
| **`src/serializer/parse.ts`**     | Converts text → `{nodes, edges}` via `parsePatch()`. Parses `#N canvas;`, `#X obj …;`, `#X connect …;`, and metadata lines (`#X id`, `#X name`, `#X size`, `#X panel`, `#X group`). Decodes base64 blob args back to source strings; recognizes display placeholders and leaves them as-is for later rehydration. |

## 2. Canvas ↔ Text Bidirectional Sync

| File                          | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`src/graph/PatchGraph.ts`** | Bridges serializer to the graph model. `serialize()` calls `serializePatch()`, `serializeForDisplay()` calls `serializePatchForDisplay()`. `deserialize(text)` calls `parsePatch()` then applies diff-based matching to preserve node IDs and runtime state (IndexedDB blobs, audio nodes) across text edits.                                                                                                                                                |
| **`src/main.ts`**             | Orchestrates bidirectional sync. `syncTextPanel()` (line ~915) writes `graph.serializeForDisplay()` into the `<textarea>`, guarded by `renderingToTextPanel` flag to prevent echo. The textarea `input` listener (line ~1068) debounces 350ms then calls `graph.deserialize(textArea.value)`. `graph.on("change", render)` triggers full canvas re-render + text sync; `graph.on("display", syncTextPanel)` updates only the text panel without DOM rebuild. |

## 3. Supporting paths

| File                             | Role                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **`src/graph/objectDefs.ts`**    | Object spec definitions that `serialize.ts` and `parse.ts` consult for `derivePorts`, `ensureArgs`, and port schemas per type.             |
| **`src/canvas/codeboxPorts.ts`** | `derivePortsFromCode()` — used by both serialize and parse to compute dynamic inlets/outlets for codebox objects from their source string. |
