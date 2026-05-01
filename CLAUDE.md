# CLAUDE.md — patchNet

Read this every session.

---

## What patchNet Is

A browser-based visual programming environment modeled after Pure Data / Max MSP.
Users place objects on a canvas, connect them with straight patch cables, and see the patch mirrored as text in a side panel.

**App location:** `/Users/user/vibing/patchNet/`
**Vault:** `patchNet-Vault/wiki/` — Tier 2 project brain
**Main brain:** `~/vibing/brain/wiki/projects/patchnet.md` (canonical) — symlinked from `~/brain/`

---

## Key Files

| File | Purpose |
|------|---------|
| `PLAN.md` | Full phased architecture plan |
| `CHANGELOG.md` | Append work-log entries here after completing tasks |
| `DESIGN_LANGUAGE.md` | All UI decisions live here — read before any CSS work |
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

Check `CHANGELOG.md` — most recent entry shows the current state. Check `PLAN.md` for the active phase.

---

## Workflow

After completing meaningful work:
1. Append a `## [YYYY-MM-DD] COMPLETED | <task>` entry to `CHANGELOG.md` (Agent: Claude Code, Done, Changed files, Notes, Next needed)
2. Update `patchNet-Vault/wiki/log.md` if a wiki-worthy decision was made
3. Update or add wiki pages for new objects/concepts/sources

## Vault Operations

When adding research or decisions to the vault:
- Sources go in `patchNet-Vault/wiki/sources/<slug>.md`
- Concepts go in `patchNet-Vault/wiki/concepts/<name>.md`
- Object specs go in `patchNet-Vault/wiki/entities/object-<name>.md`
- NotebookLM exports go in `patchNet-Vault/raw/notebooklm/<notebook-slug>/` (immutable; see folder README for the convention)
- Always update `index.md` and append to `log.md`
