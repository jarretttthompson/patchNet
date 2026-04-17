# patchNet — Design Language

**Status:** Canonical. All UI decisions drawn from this document.
**Last updated:** 2026-04-16
**Agents:** Read this before touching any CSS, layout, or component work.

---

## Identity & Mood

- **Project name:** patchNet
- **Working label:** CRT operator console / lo-fi signal router
- **Feel:** Dark plum depths, **acid green** primary accent, **hot magenta** secondary, subtle scanlines, monospaced data surfaces, tactile industrial controls
- This is a **tool** — it should feel like hardware patched into a browser, not a SaaS dashboard

---

## Typography

| Role | Font | Notes |
|------|------|--------|
| Object labels, port names, system chrome, patch cable indicators | **Vulf Mono** | Default for all patch-canvas text and data readouts |
| Toolbar, menus, panel titles, body copy | **Vulf Sans** | UI shell text |

**Rules:**
- **No other fonts.** No system-ui, no Inter, no JetBrains, no fallback branded faces.
- Vulf Mono for anything that lives inside the patch canvas or reads like "data".
- Vulf Sans for everything outside the canvas that reads like "interface."
- Font files live in `fonts/` — use `@font-face` declarations, not CDN.

```css
@font-face {
  font-family: 'Vulf Mono';
  src: url('./fonts/VulfMono-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
}
@font-face {
  font-family: 'Vulf Mono';
  src: url('./fonts/VulfMono-Bold.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
}
@font-face {
  font-family: 'Vulf Sans';
  src: url('./fonts/VulfSans-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
}
@font-face {
  font-family: 'Vulf Sans';
  src: url('./fonts/VulfSans-Bold.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
}
```

---

## Color Tokens

All tokens are CSS custom properties on `:root`. No hardcoded hex values in components.

```css
:root {
  /* --- Surfaces --- */
  --pn-bg-deep:         #0a0610;   /* outermost void */
  --pn-bg:              #120a14;   /* app background */
  --pn-surface:         #17101e;   /* panels, canvas background */
  --pn-surface-raised:  #22182a;   /* toolbar, object bodies */
  --pn-surface-glow:    #2a1f35;   /* hover/active surfaces */

  /* --- Borders --- */
  --pn-border:          #342a40;
  --pn-border-subtle:   rgba(255,255,255,0.06);
  --pn-border-accent:   rgba(57,255,20,0.38);
  --pn-border-accent-soft: rgba(57,255,20,0.14);

  /* --- Text --- */
  --pn-text:            #ebe6f2;
  --pn-text-dim:        #c4b8d4;
  --pn-muted:           #8f819f;
  --pn-muted-deep:      #5c5168;

  /* --- Accents --- */
  --pn-accent:          #39ff14;   /* acid green — primary, cables, active states */
  --pn-accent-dim:      #26c40e;
  --pn-accent-glow:     rgba(57,255,20,0.14);
  --pn-secondary:       #ff2bd6;   /* hot magenta — secondary, warnings, special ports */
  --pn-secondary-soft:  rgba(255,43,214,0.20);
  --pn-cyan:            #00ff9f;   /* neon cyan — selection, highlights */
  --pn-cyan-soft:       rgba(0,255,159,0.12);
  --pn-danger:          #ff4d6d;
  --pn-warning:         #e8b84a;
  --pn-info:            #5ec8ff;

  /* --- Patch canvas specific --- */
  --pn-cable:           #39ff14;   /* default cable color */
  --pn-cable-audio:     #ff2bd6;   /* audio-rate cables (future) */
  --pn-cable-selected:  #00ff9f;   /* selected cable */
  --pn-object-bg:       #22182a;   /* object body fill */
  --pn-object-border:   #342a40;   /* object border at rest */
  --pn-object-border-active: #39ff14; /* object border when selected */
  --pn-port-in:         #5ec8ff;   /* inlet port color */
  --pn-port-out:        #39ff14;   /* outlet port color */
  --pn-canvas-grid:     rgba(255,255,255,0.035); /* subtle dot grid */

  /* --- Shadows & depth --- */
  --pn-shadow-inset:    inset 0 1px 0 rgba(255,255,255,0.045);
  --pn-shadow-panel:    0 18px 56px rgba(0,0,0,0.55);
  --pn-shadow-soft:     0 4px 24px rgba(0,0,0,0.35);
  --pn-shadow-halo:     inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 0 rgba(0,0,0,0.2);

  /* --- Interaction states --- */
  --pn-hover:           rgba(255,255,255,0.045);
  --pn-hover-accent:    rgba(57,255,20,0.07);
  --pn-active:          rgba(255,255,255,0.07);
  --pn-active-accent:   rgba(57,255,20,0.12);
  --pn-focus-ring:      0 0 0 2px var(--pn-accent);
}
```

---

## Type Scale

```css
:root {
  --pn-font-mono: 'Vulf Mono', monospace;
  --pn-font-sans: 'Vulf Sans', sans-serif;

  --pn-type-display:  2rem;
  --pn-type-title:    1.25rem;
  --pn-type-heading:  1.0625rem;
  --pn-type-body:     0.9375rem;
  --pn-type-ui:       0.875rem;
  --pn-type-helper:   0.8125rem;
  --pn-type-chip:     0.75rem;
  --pn-type-micro:    0.6875rem;

  /* Object label on canvas: */
  --pn-type-object-label: 0.6875rem;  /* Vulf Mono, small, tight tracking */
  --pn-type-object-name:  0.75rem;    /* Vulf Mono, the object's class name */
}
```

---

## Spacing

```css
:root {
  --pn-space-1: 2px;
  --pn-space-2: 4px;
  --pn-space-3: 6px;
  --pn-space-4: 8px;
  --pn-space-5: 12px;
  --pn-space-6: 16px;
  --pn-space-7: 20px;
  --pn-space-8: 24px;
  --pn-space-9: 32px;
  --pn-space-10: 48px;
}
```

---

## Shape

```css
:root {
  --pn-radius-xs:  3px;
  --pn-radius-sm:  6px;
  --pn-radius-md:  10px;
  --pn-radius-lg:  14px;
  --pn-radius-pill: 9999px;

  /* Objects on canvas are nearly square, very slightly rounded */
  --pn-object-radius: 4px;
  /* Port nubs are small circles */
  --pn-port-size: 8px;
  --pn-port-radius: 50%;
}
```

---

## Effects & Texture

- **CRT overlay** — fixed, pointer-events none, subtle scanlines + light RGB tint; z above canvas, below modals
- **Panel borders** — use `--pn-border-accent` (uniform on all sides, no fake 3D "shadow border" on one edge only)
- **Glows** — always `0 0` offset box-shadows (symmetric, not directional); avoid making glow the only contrast signal
- **No `.lofi-static` noise** on the patch canvas — it would interfere with reading cables
- **Noise/grain** is fine on the shell chrome and sidebar surfaces

---

## Layout Shell

```
┌─────────────────────────────────────────────────────────────────┐
│  TOOLBAR  [File] [Edit] [Object…] [Run/Edit mode toggle]       │  ← Vulf Sans, --pn-surface-raised
├─────────────────────────────────────────┬───────────────────────┤
│                                         │                       │
│          PATCH CANVAS                   │   TEXT / CODE VIEW    │
│   (drag objects, draw cables)           │   (live-synced with   │
│                                         │    patch state)       │
│                                         │                       │
│                                         │                       │
└─────────────────────────────────────────┴───────────────────────┘
│  STATUS BAR  [mode indicator] [object count] [audio status]    │
└─────────────────────────────────────────────────────────────────┘
```

- **Toolbar** — thin strip, Vulf Sans labels, `--pn-surface-raised`, acid-green accent on active items
- **Patch canvas** — dark surface (`--pn-surface`), subtle dot grid, infinite scroll with pan
- **Text panel** — right side, resizable splitter; Vulf Mono throughout; mirrors patch state in real time
- **Status bar** — bottom strip, Vulf Mono micro text, muted by default, accent on active audio

---

## Patch Canvas Visual Rules

### Objects (boxes)
- Rectangular, `--pn-object-radius` rounding
- Fill: `--pn-object-bg`; border: `1px solid --pn-object-border`
- **Class name** centered in box body, Vulf Mono `--pn-type-object-name`, `--pn-text`
- **Inlet ports** — small squares/circles along the top edge, `--pn-port-in` color
- **Outlet ports** — along the bottom edge, `--pn-port-out` color
- Selected state: border becomes `--pn-object-border-active`, subtle glow

### Patch Cables
- **Straight lines only** (Pure Data style — not curved like Max)
- Default color: `--pn-cable`
- 1.5px stroke, slight glow on hover/selected
- Z-order: below objects, above canvas grid
- Cables originate from outlet center → inlet center; both endpoints snapped to port center

### Ports
- 8×8px with 1px border, filled with port color
- Hover: slight scale-up + glow ring (`--pn-focus-ring`)
- Active (cable attached): filled solid; inactive: filled with 40% opacity

---

## Object Visual Vocabulary (v1)

Each object has a class name displayed inside the box. Custom content (slider track, toggle state, button face) renders within or below the class label area.

| Object | Size (default) | Special display |
|--------|---------------|-----------------|
| `button` | 40×40 | Circle face, flashes accent on bang |
| `toggle` | 40×40 | X drawn inside when ON |
| `slider` | 120×30 | Horizontal track + thumb |
| `metro` | 80×30 | Shows interval in ms |
| `click~` | 60×30 | Waveform glyph or label only |
| `dac~` | 60×30 | Speaker icon or label only |

---

## Text View Format

The right-panel text view serializes the patch as a human-readable format inspired by Pure Data's `.pd` text format, but more readable:

```
#N canvas;
#X obj 100 80 button;
#X obj 100 160 metro 500;
#X obj 100 240 click~;
#X obj 100 320 dac~;
#X connect 0 0 1 0;
#X connect 1 0 2 0;
#X connect 2 0 3 0;
```

- Changes to the patch reflect immediately in the text view
- Changes typed in the text view (parse-safe) reflect back to the canvas (future feature)
- Font: Vulf Mono, `--pn-type-helper`, `--pn-text-dim`; keywords highlighted in `--pn-accent`

---

## Tone & Copy

- Labels are short, lowercase, familiar: `button`, `metro`, `dac~`, `toggle`
- No fake hacker jargon in UI chrome
- Status bar reads like a hardware readout: `EDIT MODE  |  6 objects  |  audio: off`
- Object names match their Pure Data / Max analogs where applicable (tilde suffix for audio objects)

---

## Interaction Model — Default to Max/MSP

All UI interactions default to Max/MSP conventions unless documented otherwise here.

### Object Creation
| Trigger | Behavior |
|---------|----------|
| `n` key | Spawns a blank inline text input at canvas center (or last click position). User types object name + args (e.g. `metro 500`). Enter confirms and instantiates. Escape cancels. |
| Double-click on empty canvas | Same as `n` — inline text entry |
| Right-click context menu | Secondary method — lists the 6 v1 object types |

**Inline object entry box:** Vulf Mono, border `--pn-object-border-active`, background `--pn-object-bg`, min-width 80px, grows with text. Looks like a new object already placed on canvas.

### Other Max/MSP keyboard shortcuts (implement as the suite expands)
- `b` → place `button` directly
- `t` → place `toggle` directly  
- `m` → message box (future object)
- Double-click on existing object → edit its arguments inline
- `Cmd+E` → toggle lock/performance mode (future)

---

## Agent Checklist

Before submitting any UI work, verify:
- [ ] Only Vulf Mono and Vulf Sans used — no other font families introduced
- [ ] All colors reference `--pn-*` tokens — no hardcoded hex
- [ ] Patch cables are straight lines, not bezier curves
- [ ] Object boxes use `--pn-object-radius`, `--pn-object-bg`, `--pn-object-border`
- [ ] Port colors: inlets = `--pn-port-in`, outlets = `--pn-port-out`
- [ ] CRT overlay present on app shell, not interfering with canvas interaction
- [ ] Text panel uses Vulf Mono throughout
- [ ] Status bar uses Vulf Mono micro text
