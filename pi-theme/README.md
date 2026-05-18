# patchnet pi TUI

Brings patchnet's **dichromatic black-and-lime CRT aesthetic** to the pi coding agent.

## What it includes

### 1. Theme (`patchnet-theme.json`)

A pi theme file mapping all 51 color tokens to patchnet's lime-on-black palette:

- **Backgrounds:** Pure black (`#000000`) with subtle green tints for depth
- **Text/Accents:** Lime green (`#00ff00`) — every color is green at different intensities
- **Syntax highlighting:** Green-luminance hierarchy instead of multi-color
- **Diffs:** Both added/removed are green (dimmed for removed)
- **Borders:** Muted green at 35-42% perceived intensity, matching `--pn-border`
- **Markdown:** Heads are bright lime, code is medium lime, everything stays monochromatic

### 2. Extension (`patchnet-extension.ts`)

Adds interactive CRT terminal effects to pi's TUI:

| Feature                        | What it does                                                        |
| ------------------------------ | ------------------------------------------------------------------- |
| **Phosphor working indicator** | Animated `· • ●` glow effect while pi thinks — brightens under load |
| **Turn counter status**        | `[● patchnet]` + `[#3 processing/ready]` in the footer              |
| **CRT scanline widget**        | Subtle dot-scanline border below the editor                         |
| **Custom footer**              | Shows `PN │ ↑1.2k ↓3.4k $0.0023` with git branch and model info     |
| **Session sidebar**            | Right-side overlay listing all sessions — switch, delete, rename    |
| **`/patchnet` command**        | Toggle all CRT effects on/off, check status                         |

### 3. Scanline/Phosphor aesthetic

- **Scanlines:** Horizontal dotted lines below the editor (`#003300` on `#001a00`)
- **Glow line:** Thin green separator above the footer
- **Phosphor bloom:** Working indicator pulses brighter on active turns
- **Border separator:** Subtle green `│` between footer sections

## Installation

### Option A: Auto-install (recommended)

```bash
# Copy theme to global themes directory
cp patchnet-theme.json ~/.pi/agent/themes/patchnet.json

# Copy extension to global extensions directory
cp patchnet-extension.ts ~/.pi/agent/extensions/patchnet.ts
```

Then in pi:

```
/settings → theme → patchnet
```

Or launch with:

```bash
pi --theme patchnet
```

The extension auto-loads on next session start. You may need to run `/reload` if pi was already running.

### Option B: Project-local

```bash
mkdir -p .pi/themes .pi/extensions
cp patchnet-theme.json .pi/themes/
cp patchnet-extension.ts .pi/extensions/
```

### Option C: One-shot from repo

```bash
pi --extension ./patchnet-extension.ts --theme ./patchnet-theme.json
```

## Usage

Once loaded, the CRT effects are automatic. Use these commands:

```
/patchnet status   → Show current status and turn count
/patchnet off      → Disable all CRT effects (restore default)
/patchnet on       → Re-enable CRT effects
/sessions          → Open session sidebar (or press alt+s)
```

### Session sidebar

Press **`alt+s`** or type **`/sessions`** to open a right-side overlay listing all sessions for the current project.

| Key   | Action                             |
| ----- | ---------------------------------- |
| `↑ ↓` | Navigate session list              |
| `↵`   | Switch to selected session         |
| `d`   | Delete (press twice to confirm)    |
| `n`   | Create new session                 |
| `r`   | Show rename hint (`/name <title>`) |
| `esc` | Close sidebar                      |

The sidebar shows:

- **Green dot** (`●`) for the currently active session
- Session name (or truncated ID if unnamed) |
- Message count per session
- All sorted by most recently modified

## Design

The theme is **dichromatic**: exactly two colors — black and lime green.

Instead of using different hues for different state (red=error, blue=link, yellow=warning), it uses **luminance levels of the same green**:

| Token        | Hex       | Patchnet Equivalent      |
| ------------ | --------- | ------------------------ |
| Full green   | `#00ff00` | `--pn-accent`            |
| Bright green | `#66ff66` | `--pn-accent-glow`       |
| Dim green    | `#00cc00` | `--pn-text-dim` (80%)    |
| Muted green  | `#009900` | `--pn-muted` (60%)       |
| Deep green   | `#006600` | `--pn-muted-deep` (45%)  |
| Trace green  | `#003300` | `--pn-hover` (20%)       |
| Background   | `#001a00` | `--pn-hover` × 0.5 (10%) |

This matches patchnet's `tokens.css` where `--pn-danger`, `--pn-warning`, `--pn-info`, `--pn-cyan`, `--pn-group` are **all `#00ff00`** — the only differentiator is opacity.
