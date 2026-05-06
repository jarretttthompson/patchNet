import type { PatchNode } from "./PatchNode";

export const NODE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function isValidNodeName(name: string | undefined | null): name is string {
  return typeof name === "string" && NODE_NAME_RE.test(name);
}

export function validateNodeName(name: string): void {
  if (!isValidNodeName(name)) {
    throw new Error(`invalid object name: ${name}`);
  }
}

export function nodeNameBaseForType(type: string): string {
  const base = type.replace(/[^A-Za-z0-9_]+/g, "");
  if (!base) return "object";
  return /^[A-Za-z_]/.test(base) ? base : `object${base}`;
}

export function nextNodeName(type: string, usedNames: ReadonlySet<string>): string {
  const base = nodeNameBaseForType(type);
  let index = 1;
  while (usedNames.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

export function usedNodeNames(nodes: Iterable<PatchNode>): Set<string> {
  const names = new Set<string>();
  for (const node of nodes) {
    if (isValidNodeName(node.name)) names.add(node.name);
  }
  return names;
}

export function assignMissingNodeNames(nodes: Iterable<PatchNode>): void {
  const used = new Set<string>();
  for (const node of nodes) {
    const name = node.name?.trim();
    if (name && isValidNodeName(name) && !used.has(name)) {
      node.name = name;
      used.add(name);
      continue;
    }

    const generated = nextNodeName(node.type, used);
    node.name = generated;
    used.add(generated);
  }
}
