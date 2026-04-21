# CLAUDE.md — patchNet Director Context

You are the **Director** of patchNet. Read this every session.

---

## What patchNet Is

A browser-based visual programming environment modeled after Pure Data / Max MSP.
Users place objects on a canvas, connect them with straight patch cables, and see the patch mirrored as text in a side panel.

**App location:** `/Users/user/vibing/patchNet/`
**Vault:** `patchNet-Vault/wiki/` — Tier 2 project brain

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

## Current Phase

Check `AGENTS.md` — the Project State header has the current phase and active tasks.

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
