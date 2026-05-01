import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { PeerRegistry } from "../runtime/peer/PeerRegistry";
import type { PeerSession, PeerStatus } from "../runtime/peer/PeerSession";

/**
 * Inline panel for a `peer` object — Phase 7A manual-SDP UX.
 *
 * Layout:
 *   [ role: ◉ offerer  ◯ answerer ]
 *   [ status: connecting           ]
 *   [ ▢ offer / answer textarea    ]
 *   [ [generate] [accept] [reset]  ]
 *
 * Offerer flow:
 *   1. Click "generate" → produces local SDP → pastes into textarea
 *   2. User copies that to the answerer machine
 *   3. Answerer pastes their answer back into this textarea
 *   4. Click "accept" → session connects
 *
 * Answerer flow:
 *   1. User pastes the offerer's blob into the textarea
 *   2. Click "accept" → produces local answer → replaces textarea content
 *   3. User copies that back to the offerer
 */
export class PeerPanel {
  private readonly root: HTMLDivElement;
  private readonly roleOffererRadio: HTMLInputElement;
  private readonly roleAnswererRadio: HTMLInputElement;
  private readonly statusEl: HTMLDivElement;
  private readonly sdpTextarea: HTMLTextAreaElement;
  private readonly generateBtn: HTMLButtonElement;
  private readonly acceptBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;

  private currentHost: HTMLElement | null = null;
  private session: PeerSession | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  /** True if the answerer has produced its answer SDP (so the textarea
   *  shows what the user should copy back to the offerer). */
  private answerProduced = false;

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    private registry: PeerRegistry,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pn-peer-panel";
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    this.root.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, textarea, input")) e.stopPropagation();
    });

    // Role row
    const roleRow = document.createElement("div");
    roleRow.className = "pn-peer-role";
    const offererLabel = document.createElement("label");
    this.roleOffererRadio = document.createElement("input");
    this.roleOffererRadio.type = "radio";
    this.roleOffererRadio.name = `pn-peer-role-${patchNode.id}`;
    this.roleOffererRadio.value = "offerer";
    offererLabel.append(this.roleOffererRadio, document.createTextNode(" offerer"));
    const answererLabel = document.createElement("label");
    this.roleAnswererRadio = document.createElement("input");
    this.roleAnswererRadio.type = "radio";
    this.roleAnswererRadio.name = `pn-peer-role-${patchNode.id}`;
    this.roleAnswererRadio.value = "answerer";
    answererLabel.append(this.roleAnswererRadio, document.createTextNode(" answerer"));
    roleRow.append(offererLabel, answererLabel);
    this.roleOffererRadio.addEventListener("change", () => this.onRoleChange("offerer"));
    this.roleAnswererRadio.addEventListener("change", () => this.onRoleChange("answerer"));

    // Status line
    this.statusEl = document.createElement("div");
    this.statusEl.className = "pn-peer-status";
    this.statusEl.textContent = "idle";

    // SDP textarea (the copy/paste surface)
    this.sdpTextarea = document.createElement("textarea");
    this.sdpTextarea.className = "pn-peer-sdp";
    this.sdpTextarea.placeholder = "SDP offer/answer blob — generate or paste here";
    this.sdpTextarea.spellcheck = false;

    // Buttons
    const btnRow = document.createElement("div");
    btnRow.className = "pn-peer-btnrow";
    this.generateBtn = mkBtn("generate", "Offerer: produce local SDP offer. Answerer: not used (paste an offer in first, then click accept).");
    this.acceptBtn   = mkBtn("accept",   "Apply the SDP currently in the textarea (offer if you're the answerer; answer if you're the offerer).");
    this.resetBtn    = mkBtn("reset",    "Tear down the current session and start a fresh one.");
    btnRow.append(this.generateBtn, this.acceptBtn, this.resetBtn);

    this.generateBtn.addEventListener("click", () => void this.onGenerate());
    this.acceptBtn.addEventListener("click",   () => void this.onAccept());
    this.resetBtn.addEventListener("click",    () => this.onReset());

    this.root.append(roleRow, this.statusEl, this.sdpTextarea, btnRow);

    this.syncFromArgs();
  }

  setRegistry(registry: PeerRegistry): void {
    this.registry = registry;
    this.bindToSession();
  }

  attach(host: HTMLElement): void {
    if (this.currentHost === host && host.contains(this.root)) {
      this.bindToSession();
      this.syncFromArgs();
      return;
    }
    this.currentHost = host;
    host.innerHTML = "";
    host.appendChild(this.root);
    this.bindToSession();
    this.syncFromArgs();
  }

  syncFromArgs(): void {
    const role = (this.patchNode.args[1] ?? "offerer") === "answerer" ? "answerer" : "offerer";
    this.roleOffererRadio.checked  = role === "offerer";
    this.roleAnswererRadio.checked = role === "answerer";
  }

  destroy(): void {
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.root.remove();
    this.currentHost = null;
  }

  // ── Session binding ───────────────────────────────────────────────────

  private bindToSession(): void {
    const session = this.registry.getSession(this.patchNode.id);
    if (this.session === session) return;
    this.unsubscribeStatus?.();
    this.session = session;
    if (!session) {
      this.setStatus("idle");
      return;
    }
    this.unsubscribeStatus = session.addStatusListener((status) => {
      this.setStatus(status);
    });
    this.setStatus(session.getStatus());
  }

  private setStatus(status: PeerStatus): void {
    this.statusEl.textContent = status;
    this.statusEl.dataset.status = status;
  }

  // ── Event handlers ────────────────────────────────────────────────────

  private onRoleChange(role: "offerer" | "answerer"): void {
    if ((this.patchNode.args[1] ?? "offerer") === role) return;
    this.patchNode.args[1] = role;
    this.graph.emit("change");
    // Recreate the underlying RTCPeerConnection in the new role; topic
    // bindings are preserved by the registry.
    this.registry.recreateSession(this.patchNode.id, role);
    this.answerProduced = false;
    this.sdpTextarea.value = "";
    this.bindToSession();
  }

  private async onGenerate(): Promise<void> {
    if (!this.session) return;
    if (this.session.role !== "offerer") {
      this.setStatus("idle");
      this.sdpTextarea.value = "(switch to offerer to generate an offer)";
      return;
    }
    try {
      const offer = await this.session.createOffer();
      this.sdpTextarea.value = offer;
      this.sdpTextarea.select();
    } catch (err) {
      this.sdpTextarea.value = `error: ${(err as Error).message}`;
    }
  }

  private async onAccept(): Promise<void> {
    if (!this.session) return;
    const blob = this.sdpTextarea.value.trim();
    if (!blob) return;
    try {
      if (this.session.role === "answerer" && !this.answerProduced) {
        const answer = await this.session.acceptOffer(blob);
        this.sdpTextarea.value = answer;
        this.sdpTextarea.select();
        this.answerProduced = true;
      } else if (this.session.role === "offerer") {
        await this.session.acceptAnswer(blob);
      }
    } catch (err) {
      this.setStatus("failed");
      this.statusEl.textContent = `failed: ${(err as Error).message}`;
    }
  }

  private onReset(): void {
    const role = (this.patchNode.args[1] ?? "offerer") === "answerer" ? "answerer" : "offerer";
    this.registry.recreateSession(this.patchNode.id, role);
    this.answerProduced = false;
    this.sdpTextarea.value = "";
    this.bindToSession();
  }
}

function mkBtn(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pn-peer-btn";
  b.textContent = label;
  b.title = title;
  return b;
}
