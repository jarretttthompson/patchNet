export interface PatchEdgeData {
  id: string;
  fromNodeId: string;
  fromOutlet: number;
  toNodeId: string;
  toInlet: number;
}

export class PatchEdge implements PatchEdgeData {
  id: string;
  fromNodeId: string;
  fromOutlet: number;
  toNodeId: string;
  toInlet: number;

  constructor(data: PatchEdgeData) {
    this.id = data.id;
    this.fromNodeId = data.fromNodeId;
    this.fromOutlet = data.fromOutlet;
    this.toNodeId = data.toNodeId;
    this.toInlet = data.toInlet;
  }
}
