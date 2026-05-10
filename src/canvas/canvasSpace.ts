/**
 * Canvas geometry constants.
 *
 * The patch canvas is bounded — fixed width/height in world pixels — rather
 * than growing with object placement. Coordinate rulers (X top, Y left)
 * report position in grid cells (1 cell = GRID_CELL_PX world pixels).
 *
 * Gutters (CANVAS_LEFT_GUTTER_PX / CANVAS_TOP_GUTTER_PX) are the inset
 * between canvasArea's top-left corner and world (0,0). The rulers occupy
 * exactly that inset.
 */

export const CANVAS_WIDTH_PX = 3000;
export const CANVAS_HEIGHT_PX = 3000;

/** Pixels per grid cell (one whole-number unit on the rulers). */
export const GRID_CELL_PX = 50;

/** Subdivisions per cell — fractional grid resolution. 2 → 0.5 steps. */
export const GRID_SUBDIVISIONS = 2;

/** Pixels per sub-cell (smallest grid step; also the snap step). */
export const GRID_SUB_PX = GRID_CELL_PX / GRID_SUBDIVISIONS;

/** Major label every N cells. */
export const GRID_MAJOR_EVERY = 5;

/** Thickness of the ruler strips along the top (X) and left (Y) edges. */
export const RULER_THICKNESS_PX = 22;

export const CANVAS_LEFT_GUTTER_PX = RULER_THICKNESS_PX;
export const CANVAS_TOP_GUTTER_PX = RULER_THICKNESS_PX;
