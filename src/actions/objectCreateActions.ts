import { OBJECT_DEFS } from "../graph/objectDefs";
import type { PatchAction } from "./types";

/** Default keybindings for the five legacy quick-place keys. Other object
 *  types are palette-only — the palette is intentionally the unrestricted
 *  surface for new users to discover the full object library. */
const QUICK_PLACE_KEYS: Record<string, string[]> = {
  button: ["B"],
  toggle: ["T"],
  slider: ["S"],
  attribute: ["A"],
  message: ["M"],
};

/** Object types where a keyboard-triggered place should require the cursor
 *  to be over the canvas. Single-letter shortcuts that double as common
 *  English letters fall here so they don't surprise the user when typed
 *  somewhere unrelated. */
const REQUIRE_CURSOR_OVER_CANVAS = new Set(["message"]);

/**
 * One action per `OBJECT_DEFS` key, including local-plugin types (those are
 * merged into OBJECT_DEFS at module load). Section "Place object" so the
 * palette groups them under one heading.
 *
 * Run is a thin wrapper around `canvas.placeObject` — the same code path
 * as the legacy B/T/S/A/M shortcuts. ids are stable: existing macros and
 * tests can reference `canvas.object.create.<type>`.
 */
export function generateObjectCreateActions(): PatchAction[] {
  const types = Object.keys(OBJECT_DEFS).sort();
  return types.map<PatchAction>((type) => {
    const spec = OBJECT_DEFS[type];
    return {
      id: `canvas.object.create.${type}`,
      title: `Place ${type}`,
      section: "Place object",
      category: spec.category,
      defaultKeys: QUICK_PLACE_KEYS[type],
      keywords: keywordsFromDescription(spec.description),
      run: (ctx) => ctx.canvas.placeObject(type, {
        requireCursorOverCanvas: REQUIRE_CURSOR_OVER_CANVAS.has(type),
      }),
    };
  });
}

function keywordsFromDescription(desc: string): string[] {
  // Cheap tokenization — split on non-letters, drop short noise words.
  return desc.toLowerCase()
    .split(/[^a-z0-9~*]+/)
    .filter((w) => w.length >= 4);
}
