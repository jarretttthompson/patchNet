import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";

import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import { derivePortsFromCode } from "./codeboxPorts";

const DEFAULT_LANGUAGE = "js";
const DEBOUNCE_MS = 300;

type EditorRecord = {
  errorEl: HTMLDivElement;
  host: HTMLElement;
  timeoutId: number | null;
  view: EditorView;
};

function normalizeOutput(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "1.0" : "0.0";
  }

  if (Array.isArray(value) || typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  return String(value);
}

function buildRunner(node: PatchNode, source: string): (...args: unknown[]) => Record<string, unknown> {
  const inletCount = Math.max(node.inlets.length, 8);
  const outletCount = Math.max(node.outlets.length, 8);
  const inletNames = Array.from({ length: inletCount }, (_, index) => `in${index + 1}`);
  const bangNames = Array.from({ length: inletCount }, (_, index) => `bang${index + 1}`);
  const argNames = [
    "Math",
    "JSON",
    "Number",
    "String",
    "Boolean",
    "parseFloat",
    "parseInt",
    "isNaN",
    "isFinite",
    "structuredClone",
    "console",
    ...inletNames,
    ...bangNames,
  ];
  const outputNames = Array.from({ length: outletCount }, (_, index) => `out${index + 1}`);
  const declarations = outputNames.length > 0 ? `let ${outputNames.join(", ")};\n` : "";
  const body = `${declarations}${source}\nreturn { ${outputNames.join(", ")} };`;

  return new Function(...argNames, body) as (...args: unknown[]) => Record<string, unknown>;
}

export class CodeboxController {
  private readonly editors = new Map<string, EditorRecord>();

  constructor(
    private readonly graph: PatchGraph,
    private readonly dispatchBang: (fromNodeId: string, outlet: number) => void,
    private readonly dispatchValue: (fromNodeId: string, outlet: number, value: string) => void,
  ) {}

  mountEditor(node: PatchNode, host: HTMLElement): void {
    const existing = this.editors.get(node.id);
    if (existing) {
      if (existing.host !== host) {
        host.replaceChildren(existing.view.dom, existing.errorEl);
        existing.host = host;
      }

      const source = this.getNodeSource(node);
      const current = existing.view.state.doc.toString();
      if (current !== source) {
        existing.view.dispatch({
          changes: { from: 0, to: current.length, insert: source },
        });
      }
      return;
    }

    const errorEl = document.createElement("div");
    errorEl.className = "pn-codebox-error-msg";

    const view = new EditorView({
      state: EditorState.create({
        doc: this.getNodeSource(node),
        extensions: [
          javascript(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            this.scheduleSync(node.id);
          }),
        ],
      }),
    });

    host.replaceChildren(view.dom, errorEl);
    this.editors.set(node.id, {
      errorEl,
      host,
      timeoutId: null,
      view,
    });
    this.validateNodeCode(node);
  }

  unmountEditor(nodeId: string): void {
    const record = this.editors.get(nodeId);
    if (!record) return;

    if (record.timeoutId !== null) {
      window.clearTimeout(record.timeoutId);
    }

    record.view.destroy();
    record.host.removeAttribute("data-error");
    record.errorEl.remove();
    this.editors.delete(nodeId);
  }

  pruneEditors(activeNodeIds: Set<string>): void {
    for (const nodeId of this.editors.keys()) {
      if (!activeNodeIds.has(nodeId)) {
        this.unmountEditor(nodeId);
      }
    }
  }

  executeBang(node: PatchNode, inlet: number): void {
    this.execute(node, inlet, undefined, true);
  }

  executeValue(node: PatchNode, inlet: number, value: string): void {
    if (inlet === 0) {
      const setMessage = this.parseSetMessage(value);
      if (setMessage !== null) {
        const record = this.editors.get(node.id);
        const source = setMessage;
        if (record) {
          const current = record.view.state.doc.toString();
          record.view.dispatch({
            changes: { from: 0, to: current.length, insert: source },
          });
        } else {
          this.applyCodeChange(node, source);
        }
        return;
      }
    }

    this.execute(node, inlet, value, false);
  }

  destroy(): void {
    for (const nodeId of Array.from(this.editors.keys())) {
      this.unmountEditor(nodeId);
    }
  }

  private scheduleSync(nodeId: string): void {
    const record = this.editors.get(nodeId);
    if (!record) return;

    if (record.timeoutId !== null) {
      window.clearTimeout(record.timeoutId);
    }

    record.timeoutId = window.setTimeout(() => {
      record.timeoutId = null;
      const node = this.graph.nodes.get(nodeId);
      if (!node || node.type !== "codebox") return;
      this.applyCodeChange(node, record.view.state.doc.toString());
    }, DEBOUNCE_MS);
  }

  private applyCodeChange(node: PatchNode, source: string): void {
    const { inlets, outlets } = derivePortsFromCode(source);
    node.inlets = inlets;
    node.outlets = outlets;
    node.args[0] = node.args[0] || DEFAULT_LANGUAGE;
    node.args[1] = source;
    this.removeStaleEdges(node);
    this.validateNodeCode(node);
    this.graph.emit("change");
  }

  private removeStaleEdges(node: PatchNode): void {
    for (const edge of this.graph.getEdges()) {
      if (
        (edge.fromNodeId === node.id && edge.fromOutlet >= node.outlets.length) ||
        (edge.toNodeId === node.id && edge.toInlet >= node.inlets.length)
      ) {
        this.graph.removeEdge(edge.id);
      }
    }
  }

  private execute(node: PatchNode, inlet: number, value: string | undefined, isBang: boolean): void {
    const source = this.getNodeSource(node);
    void this.dispatchBang;

    try {
      const runner = buildRunner(node, source);
      const inletCount = Math.max(node.inlets.length, 8);
      const inputValues = Array.from({ length: inletCount }, (_, index) => (
        index === inlet ? value : undefined
      ));
      const bangValues = Array.from({ length: inletCount }, (_, index) => (
        isBang && index === inlet
      ));
      const result = runner(
        Math,
        JSON,
        Number,
        String,
        Boolean,
        parseFloat,
        parseInt,
        isNaN,
        isFinite,
        structuredClone,
        { log: console.log.bind(console), warn: console.warn.bind(console) },
        ...inputValues,
        ...bangValues,
      );

      for (let outlet = 0; outlet < node.outlets.length; outlet += 1) {
        const normalized = normalizeOutput(result[`out${outlet + 1}`]);
        if (normalized !== null) {
          this.dispatchValue(node.id, outlet, normalized);
        }
      }

      this.syncErrorState(node.id, null);
    } catch (error) {
      this.handleExecutionError(node.id, error);
    }
  }

  private validateNodeCode(node: PatchNode): void {
    const source = this.getNodeSource(node);

    try {
      buildRunner(node, source);
      this.syncErrorState(node.id, null);
    } catch (error) {
      this.handleExecutionError(node.id, error);
    }
  }

  private handleExecutionError(nodeId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`codebox ${nodeId} error: ${message}`);
    this.syncErrorState(nodeId, message);
  }

  private syncErrorState(nodeId: string, message: string | null): void {
    const record = this.editors.get(nodeId);
    if (!record) return;

    if (message) {
      record.host.dataset.error = "true";
      record.errorEl.textContent = message;
    } else {
      delete record.host.dataset.error;
      record.errorEl.textContent = "";
    }
  }

  private getNodeSource(node: PatchNode): string {
    return node.args[1] ?? "";
  }

  private parseSetMessage(value: string): string | null {
    if (value === "set") {
      return "";
    }

    if (value.startsWith("set ")) {
      return value.slice(4);
    }

    return null;
  }
}
