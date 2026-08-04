/**
 * .patchnet text format versioning.
 *
 * The first non-blank, non-comment line of a versioned patch is
 *
 *   #N patchnet <version>;
 *
 * Files from before this header existed carry no marker and read as v0 —
 * the parser accepts them unchanged (tolerant dual-read), so autosave
 * restores and shared links never prompt. Explicit file-opens are the one
 * place an older version triggers the ask-before-upgrade dialog, because
 * saving from a newer app rewrites the file in the current format.
 *
 * Bump FORMAT_VERSION only when the format's shape changes (new statement
 * kinds, changed encodings) — not for added object types or appended args,
 * which v0-era backfill already handles.
 */
export const FORMAT_VERSION = 1;

const HEADER_RE = /^#N patchnet (\d+);$/;

/** Version stamped in the text's header; 0 for pre-header (or empty) text. */
export function detectFormatVersion(text: string): number {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const match = HEADER_RE.exec(line);
    return match ? Number(match[1]) : 0;
  }
  return 0;
}
