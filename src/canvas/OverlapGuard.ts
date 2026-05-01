import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import { getObjectDef } from "../graph/objectDefs";

/**
 * Object types that don't participate in no-overlap enforcement. They neither
 * block nor are blocked. `frame~` is the canonical example (its job is to
 * overlay arbitrary regions). Comments sit over patches as annotations.
 */
const NO_OVERLAP_EXEMPT = new Set<string>(["frame*", "comment"]);

export function objectIgnoresOverlap(type: string): boolean {
  return NO_OVERLAP_EXEMPT.has(type);
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function getNodeBox(node: PatchNode): Box {
  const def = getObjectDef(node.type);
  return {
    x: node.x,
    y: node.y,
    w: node.width  ?? def.defaultWidth,
    h: node.height ?? def.defaultHeight,
  };
}

/** Strict AABB overlap. Touching edges (a.x+a.w === b.x) do NOT overlap. */
export function boxesOverlap(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/**
 * Result of an overlap check. When blocked, `obstacle` is the first colliding
 * node — used to flash visual feedback on its edge.
 */
export interface OverlapCheckResult {
  ok: boolean;
  obstacleId?: string;
}

/**
 * Test whether a proposed move/resize for a set of moving nodes is allowed.
 *
 * `proposed` is a partial map of nodeId → new box. Any moving node not in the
 * map keeps its current box. The check ignores collisions among moving nodes
 * themselves (the group is treated rigidly), and ignores any node — moving
 * or stationary — whose type is in the exempt set.
 */
export function checkOverlap(
  graph: PatchGraph,
  movingIds: ReadonlySet<string>,
  proposed: ReadonlyMap<string, Box>,
): OverlapCheckResult {
  for (const movingId of movingIds) {
    const movingNode = graph.nodes.get(movingId);
    if (!movingNode) continue;
    if (objectIgnoresOverlap(movingNode.type)) continue;

    const box = proposed.get(movingId) ?? getNodeBox(movingNode);

    for (const other of graph.getNodes()) {
      if (other.id === movingId) continue;
      if (movingIds.has(other.id)) continue;
      if (objectIgnoresOverlap(other.type)) continue;

      const otherBox = getNodeBox(other);
      if (boxesOverlap(box, otherBox)) {
        return { ok: false, obstacleId: other.id };
      }
    }
  }
  return { ok: true };
}

/**
 * Find the nearest empty position for a new object at (x,y) of size (w,h),
 * sliding down-right by `step` until it doesn't collide with anything. Used
 * by addNode / duplicateNodes so placing into an occupied spot succeeds with
 * a small offset rather than failing.
 *
 * Bounded — if no free slot is found within `maxSteps`, returns the original
 * position so we never spiral indefinitely on dense canvases.
 */
export function findFreePlacement(
  graph: PatchGraph,
  x: number,
  y: number,
  w: number,
  h: number,
  excludeIds: ReadonlySet<string> = new Set(),
  step: number = 20,
  maxSteps: number = 60,
): { x: number; y: number } {
  let cx = x;
  let cy = y;
  for (let i = 0; i < maxSteps; i++) {
    const candidate: Box = { x: cx, y: cy, w, h };
    let collides = false;
    for (const other of graph.getNodes()) {
      if (excludeIds.has(other.id)) continue;
      if (objectIgnoresOverlap(other.type)) continue;
      if (boxesOverlap(candidate, getNodeBox(other))) {
        collides = true;
        break;
      }
    }
    if (!collides) return { x: cx, y: cy };
    cx += step;
    cy += step;
  }
  return { x, y };
}

/** Box getter exported for callers that need to read current node bounds. */
export { getNodeBox };
