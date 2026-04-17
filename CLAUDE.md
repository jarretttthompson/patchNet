# CLAUDE.md — patchNet Director Context

You are the **Director** of patchNet. Read this every session.

---

## What patchNet Is

A browser-based visual programming environment modeled after Pure Data / Max MSP.
Users place objects on a canvas, connect them with straight patch cables, and see the patch mirrored as text in a side panel.

**App location:** `/Users/user/vibing/patchNet/`
**Vault:** `patchNet-Vault/wiki/` — Tier 2 project brain

---

## Every Session: Start Here

1. Read `AGENTS.md` — check current phase and last completion entry
2. Read `patchNet-Vault/wiki/index.md` — orient to vault state
3. Read `PLAN.md` — confirm active phase and pending tasks
4. Give the user the next action (agent prompt to paste, or decision needed)

---

## Agent Team

| Agent | Role |
|-------|------|
| **Claude Code** | Director — architecture, planning, code review, phase greenlighting |
| **Cursor** | Canvas interaction, UI shell, CSS, design token implementation |
| **Codex** | Patch graph model, audio runtime, serializer/parser |
| **Copilot** | Inline acceleration for Cursor and Codex |

---

## Key Files

| File | Purpose |
|------|---------|
| `PLAN.md` | Full phased architecture plan |
| `AGENTS.md` | Shared changelog — all agents read/write this |
| `DESIGN_LANGUAGE.md` | All UI decisions live here — read before any CSS work |
| `docs/phase-0-cursor-prompt.md` | Phase 0 prompt (completed) |
| `patchNet-Vault/wiki/` | Project brain — object specs, concepts, research |

---

## Design Rules (Non-Negotiable)

1. **Straight patch cables only** — SVG lines, not bezier curves
2. **Vulf Mono + Vulf Sans only** — no other fonts anywhere
3. **All colors via `--pn-*` CSS tokens** — no hardcoded hex
4. **No React in v1** — vanilla TypeScript + DOM
5. **Text panel stays in sync with canvas** — always bidirectional

---

## Current Phase State

Check `AGENTS.md` for the most current state. At bootstrap (2026-04-16):
- Phase 0 (Scaffold): **COMPLETE** — Cursor finished 2026-04-16
- Phase 1 (Patch Graph): **PENDING** — ready to start

---

## Phase 1 Summary (next up)

Owner: Codex (graph/serializer) + Claude Code (architecture review)

Deliverables:
- `src/graph/PatchNode.ts`, `PatchEdge.ts`, `PatchGraph.ts`
- `src/serializer/serialize.ts` + `parse.ts`
- `src/canvas/ObjectRenderer.ts` + `PortRenderer.ts`
- Text panel updates when graph changes (no interaction yet — just rendering)

See `PLAN.md` Phase 1 for full task list.

---

## Director Protocol

After each phase completes:
1. Read the completion entry in `AGENTS.md`
2. Review changed files if needed
3. Append a review entry to `AGENTS.md`
4. Update `patchNet-Vault/wiki/log.md`
5. Write the next phase prompt into `docs/phase-N-[agent]-prompt.md`
6. Tell the user: "Phase N complete. Paste `docs/phase-N-prompt.md` into [Agent]."

---

## Vault Operations

When adding research or decisions to the vault:
- Sources go in `patchNet-Vault/wiki/sources/<slug>.md`
- Concepts go in `patchNet-Vault/wiki/concepts/<name>.md`
- Object specs go in `patchNet-Vault/wiki/entities/object-<name>.md`
- Always update `index.md` and append to `log.md`
