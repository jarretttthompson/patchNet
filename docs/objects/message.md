# message

Reference doc for the `message` object. For agent use.
Last updated: 2026-04-16

---

## Description

A message box that stores a message and outputs it when triggered. The message can contain
literal text, numbers, or dollar-argument placeholders (`$1`–`$9`) that are substituted
from incoming values at trigger time. Clicking the box (or receiving a bang on inlet 0)
sends the stored message. The right inlet sets the stored message without triggering output.

---

## Arguments

| # | name | type | default | description |
|---|------|------|---------|-------------|
| 0+ | content | symbol/list | (empty) | Initial message text. Multiple words stored space-joined. May contain `$1`–`$9` placeholders. |

`node.args` stores the message as a single-element array after editing: `node.args[0] = "hello world"`.
The renderer displays `node.args.join(" ")`.

---

## Inlets

| # | type | temperature | accepts | description |
|---|------|-------------|---------|-------------|
| 0 | message | hot | bang, int, float, list, symbol | Triggers output. `$1`–`$9` are substituted from incoming value before outputting. |
| 1 | message | cold | any | Sets stored message content without triggering output. |

---

## Outlets

| # | type | description |
|---|------|-------------|
| 0 | message | Outputs the stored message (after dollar-arg substitution if applicable). |

---

## Messages

| inlet | selector | args | effect |
|-------|----------|------|--------|
| 0 | bang | — | Output stored message as-is. No substitution. |
| 0 | int | `$1: int` | Substitute `$1` with value, then output. |
| 0 | float | `$1: float` | Substitute `$1` with value, then output. |
| 0 | list | `$1–$9: items` | Substitute `$n` from list items in order, then output. |
| 0 | symbol | `$1: symbol` | Substitute `$1` with symbol string, then output. |
| 0 | set | `[list]` | Store new content without outputting. |
| 1 | (any) | — | Store incoming value as message content. No output. |
| 1 | append | `[list]` | Append words to end of stored message. No output. |
| 1 | prepend | `[list]` | Prepend words to start of stored message. No output. |

**Comma multi-output:** A stored message containing `,` outputs each comma-separated segment
sequentially on outlet 0 (e.g., `"start, 500"` → `"start"` then `"500"`).

**Semicolon routing (Max only):** `;` prefix routes to a named `receive` object. Not in patchNet v1.

---

## Examples

```
; Basic click-to-send
#N canvas;
#X obj 100 100 message hello world;

; Dollar arg — receive float 0.75 on inlet 0, output "vol 0.75"
#X obj 100 100 message vol $1;

; Comma multi-output — sends "start" then "500"
#X obj 100 100 message start, 500;
```

---

## Implementation Status

### Done
- Stores content in `node.args`; renders via `.patch-object-message-content`
- Double-click to edit via inline `<input>` (`beginMessageEdit`)
- Click sends stored content (`dispatchValue`) or bang (`dispatchBang`)
- Cold inlet (index 1) stores value, does not output
- Hot inlet (index 0) stores + outputs immediately
- Bang on hot inlet sets `node.args = ["bang"]` and dispatches bang downstream

### Missing
- **`$1`–`$9` substitution** — dollar args pass through as literal text
- **`set` message selector** — not parsed; treated as raw value
- **`append` / `prepend`** — not implemented
- **Comma multi-output** — comma treated as literal character
- **Typed message dispatch** — `dispatchValue` sends raw strings; no int/float/list/symbol distinction
- **Bang hot inlet fix** — currently overwrites `node.args` with `["bang"]`; should preserve stored content and output it unchanged

---

## Max/MSP Delta

| Behavior | Max spec | patchNet state |
|----------|----------|----------------|
| `$1`–`$9` substitution | `$n` tokens replaced by incoming list items before output | Not implemented |
| `set` selector | Sets content, no output; accepted on both inlets | Not parsed; cold inlet stores any value |
| `append [list]` | Appends words to stored message | Not implemented |
| `prepend [list]` | Prepends words to stored message | Not implemented |
| Comma multi-output | Comma splits into sequential outputs | Not implemented |
| Semicolon routing | `;` routes to named receive | Not planned for v1 |
| Bang hot inlet | Outputs stored message unchanged | Currently overwrites content with `"bang"` |
| Typed coercion | int/float arrive as numbers, not strings | All values are strings; no type distinction |
