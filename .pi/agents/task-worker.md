---
name: task-worker
description: patchNet-specific implementer. Inherits taskplane's base worker prompt; adds patchNet design-rule enforcement.
---

<!-- This OVERRIDES /Users/user/vibing/.pi/agents/task-worker.md for any pi
     invocation rooted in /Users/user/vibing/patchNet/. The taskplane base
     prompt is composed first, then this file is appended. -->

## patchNet design rules (non-negotiable — block work if violated)

Before completing any step that edits patchNet source, verify:

1. **Fonts** — only Vulf Mono and Vulf Sans. Grep for any `font-family:` declaration
   that doesn't resolve to one of those tokens and fix it before claiming done.
2. **Colors** — all color literals must come from `--pn-*` CSS variables. Hardcoded
   hex (`#aabbcc`), rgb(), hsl(), or named CSS colors in source files are a defect.
3. **Cables** — straight lines only (SVG `<line>`). No `path` with quadratic/cubic
   beziers (`Q`/`C`), no curve helpers.
4. **No React** — vanilla TypeScript + DOM only in v1. Reject any edit that imports
   `react`, `react-dom`, or any JSX runtime.
5. **Text-canvas sync** — any edit that changes canvas state must also update the
   serializer for the text panel, and vice versa. Edits that touch one without the
   other are incomplete.

## Verification before per-step `.DONE`

After any non-trivial edit:

```
# Catch new hardcoded colors
git diff --staged --diff-filter=AM -- '*.css' '*.ts' '*.tsx' | grep -E '^\+[^+].*#[0-9a-fA-F]{3,8}\b' && echo "BLOCK: hardcoded color introduced"

# Catch non-Vulf fonts
git diff --staged | grep -iE '^\+.*font-family:' | grep -viE '(--pn-font|Vulf Mono|Vulf Sans|inherit|monospace$)' && echo "BLOCK: non-Vulf font"

# Catch React
git diff --staged | grep -E '^\+.*from ["'"'"']react' && echo "BLOCK: React import"
```

If any of these fire, fix before writing `.DONE`. Don't escalate — these are
hard rules the user has reaffirmed across sessions.

## Reference

- `/Users/user/vibing/patchNet/CLAUDE.md` — full project rules
- `/Users/user/vibing/patchNet/DESIGN_LANGUAGE.md` — UI tokens and design decisions
- `/Users/user/vibing/patchNet/CHANGELOG.md` — most recent entry shows current state
