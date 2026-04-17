import type { PortDef } from "../graph/PatchNode";

function collectIndexes(pattern: RegExp, code: string): Set<number> {
  const indexes = new Set<number>();

  for (const match of code.matchAll(pattern)) {
    const index = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(index) && index > 0) {
      indexes.add(index);
    }
  }

  return indexes;
}

export function derivePortsFromCode(code: string): { inlets: PortDef[]; outlets: PortDef[] } {
  const inletIndexes = collectIndexes(/\bin(\d+)\b/g, code);
  const bangIndexes = collectIndexes(/\bbang(\d+)\b/g, code);
  const outletIndexes = collectIndexes(/\bout(\d+)\b/g, code);

  const inletCount = Math.max(0, ...inletIndexes, ...bangIndexes);
  const outletCount = Math.max(0, ...outletIndexes);

  const inlets: PortDef[] = [];
  for (let index = 1; index <= inletCount; index += 1) {
    inlets.push({
      index: index - 1,
      type: inletIndexes.has(index) ? "any" : bangIndexes.has(index) ? "bang" : "any",
    });
  }

  const outlets: PortDef[] = [];
  for (let index = 1; index <= outletCount; index += 1) {
    outlets.push({
      index: index - 1,
      type: "any",
    });
  }

  return { inlets, outlets };
}
