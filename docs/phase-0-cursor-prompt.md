# Phase 0 — Cursor Prompt: Scaffold

Paste this into Cursor. Complete all tasks before moving to Phase 1.

---

You are building **patchNet**, a browser-based visual programming environment modeled after Pure Data / Max MSP. You are working in `/Users/user/vibing/patchNet/`.

**Your job in Phase 0:** Create the app scaffold — no audio, no patch logic, just the shell that everything else will live inside.

**Read these files before writing any code:**
- `DESIGN_LANGUAGE.md` — all color tokens, font rules, layout spec. Follow it exactly.
- `AGENTS.md` — project state and communication log
- `PLAN.md` — full architecture

---

## Tasks

### 1. `package.json`
```json
{
  "name": "patchnet",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vite": "^5.2.0"
  }
}
```

### 2. `tsconfig.json`
Standard strict TypeScript config targeting ES2022, moduleResolution bundler.

### 3. `vite.config.ts`
Minimal Vite config, no plugins needed in Phase 0.

### 4. `src/tokens.css`
Copy every CSS custom property from the `## Color Tokens`, `## Type Scale`, `## Spacing`, and `## Shape` sections of `DESIGN_LANGUAGE.md` into a single `:root {}` block. No other content.

### 5. `src/fonts.css`
Declare `@font-face` for:
- Vulf Mono Regular — `fonts/VulfMono-Regular.woff2` (weight 400)
- Vulf Mono Bold — `fonts/VulfMono-Bold.otf` (weight 700)
- Vulf Sans Regular — `fonts/VulfSans-Regular.woff2` (weight 400)
- Vulf Sans Bold — `fonts/VulfSans-Bold.otf` (weight 700)

### 6. `src/shell.css`
Style the app shell:

- `body` — `background: var(--pn-bg-deep)`, `color: var(--pn-text)`, `font-family: var(--pn-font-sans)`, `margin: 0`, `height: 100vh`, column flex, overflow hidden
- `#app` — full viewport, column flex
- `.toolbar` — height 40px, `background: var(--pn-surface-raised)`, `border-bottom: 1px solid var(--pn-border)`, flex row, align-items center, padding 0 16px, gap 8px; font-family Vulf Sans, font-size `var(--pn-type-ui)`
- `.toolbar .app-title` — Vulf Mono, `var(--pn-accent)`, font-size `var(--pn-type-chip)`, letter-spacing 0.1em, uppercase
- `.workspace` — flex: 1, flex-direction: row, overflow: hidden
- `.canvas-area` — flex: 1, position: relative, background: `var(--pn-surface)`, overflow: hidden; the patch canvas lives here
- `.canvas-grid` — absolute, inset 0, background: radial-gradient dot grid using `var(--pn-canvas-grid)`, pointer-events: none
- `.divider` — width 4px, background: `var(--pn-border)`, cursor: col-resize; hover: background `var(--pn-accent)`
- `.text-panel` — width 280px, min-width 180px, max-width 480px, background: `var(--pn-bg)`, border-left: `1px solid var(--pn-border)`, display flex, flex-direction column
- `.text-panel-header` — height 32px, `background: var(--pn-surface-raised)`, `border-bottom: 1px solid var(--pn-border)`, display flex, align-items center, padding 0 12px; Vulf Mono, `var(--pn-type-chip)`, `var(--pn-muted)`, uppercase, letter-spacing 0.08em; text: "TEXT VIEW"
- `.text-panel textarea` — flex 1, background transparent, color `var(--pn-text-dim)`, font-family `var(--pn-font-mono)`, font-size `var(--pn-type-helper)`, border none, outline none, resize none, padding 12px, line-height 1.6
- `.status-bar` — height 24px, `background: var(--pn-bg-deep)`, `border-top: 1px solid var(--pn-border)`, display flex, align-items center, padding 0 12px, gap 16px; Vulf Mono, `var(--pn-type-micro)`, `var(--pn-muted)`
- `.status-bar .status-mode` — color `var(--pn-accent)`

**CRT overlay:**
```css
.crt-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 100;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.03) 2px,
    rgba(0, 0, 0, 0.03) 4px
  );
}
```

### 7. `index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>patchNet</title>
  <link rel="stylesheet" href="/src/fonts.css" />
  <link rel="stylesheet" href="/src/tokens.css" />
  <link rel="stylesheet" href="/src/shell.css" />
</head>
<body>
  <div class="crt-overlay"></div>
  <div id="app">
    <div class="toolbar">
      <span class="app-title">patchNet</span>
      <span style="flex:1"></span>
      <span style="color:var(--pn-muted);font-size:var(--pn-type-micro);font-family:var(--pn-font-mono)">EDIT MODE</span>
    </div>
    <div class="workspace">
      <div class="canvas-area">
        <div class="canvas-grid"></div>
        <!-- objects and cables render here in later phases -->
      </div>
      <div class="divider"></div>
      <div class="text-panel">
        <div class="text-panel-header">text view</div>
        <textarea placeholder="#N canvas;" spellcheck="false"></textarea>
      </div>
    </div>
    <div class="status-bar">
      <span class="status-mode">EDIT</span>
      <span>0 objects</span>
      <span>audio: off</span>
    </div>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

### 8. `src/main.ts`
For Phase 0, just a stub:
```typescript
console.log('patchNet v0.1 — scaffold loaded');
```

---

## Dot Grid (canvas background)

Implement the `.canvas-grid` as a CSS background using radial-gradient to create a subtle dot pattern:
```css
background-image: radial-gradient(circle, var(--pn-canvas-grid) 1px, transparent 1px);
background-size: 24px 24px;
```

---

## Completion Instructions

When Phase 0 is done:
1. Run `npm install && npm run dev` and confirm the app loads at localhost:5173
2. Confirm: two-panel layout visible, correct dark colors, "patchNet" in toolbar uses Vulf Mono in acid green, text panel visible on right, status bar at bottom
3. Append to `AGENTS.md`:

```
---
## [DATE] COMPLETED | Phase 0 — Scaffold
**Agent:** Cursor
**Phase:** Phase 0
**Done:**
- [list what you built]
**Changed files:**
- [list files]
**Notes:**
- [any decisions or deviations]
**Next needed:**
- Claude Code to review and greenlight Phase 1 start
---
```

4. Reply with a completion log:

COMPLETED: Phase 0 — Scaffold
AGENT: Cursor
TASKS DONE:
- [bullets]
TASKS SKIPPED: [anything skipped and why]
NEXT NEEDED: Claude Code review, then Phase 1 patch graph model
