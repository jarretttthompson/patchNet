export type PortType = "bang" | "float" | "signal" | "any" | "message" | "media";

export interface PortDef {
  index: number;
  label?: string;
  type: PortType;
  /** Hot inlets trigger output; cold inlets store only. Default: hot. */
  temperature?: "hot" | "cold";
  /** Rendering edge. "top" = normal top/bottom strip (default). "left" = left-edge side inlet. "right" = right-edge side outlet. */
  side?: "top" | "left" | "right";
}

export interface PatchNodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  args: string[];
  inlets: PortDef[];
  outlets: PortDef[];
  width?: number;
  height?: number;
  groupId?: string;
  /** Panel position — independent of editor x/y. Serialized as #X panel. */
  panelX?: number;
  panelY?: number;
  panelW?: number;
  panelH?: number;
}

export class PatchNode implements PatchNodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  args: string[];
  inlets: PortDef[];
  outlets: PortDef[];
  width?: number;
  height?: number;
  groupId?: string;
  panelX?: number;
  panelY?: number;
  panelW?: number;
  panelH?: number;
  /** Transient display URL (blob: or data:) — never serialized, set by runtime after IDB load. */
  displayUrl?: string;

  constructor(data: PatchNodeData) {
    this.id = data.id;
    this.type = data.type;
    this.x = data.x;
    this.y = data.y;
    this.args = [...data.args];
    this.inlets = data.inlets.map((port) => ({ ...port }));
    this.outlets = data.outlets.map((port) => ({ ...port }));
    this.width = data.width;
    this.height = data.height;
    this.groupId = data.groupId;
    this.panelX = data.panelX;
    this.panelY = data.panelY;
    this.panelW = data.panelW;
    this.panelH = data.panelH;
  }
}
