import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { DmxNode, DmxLogEntry } from "../runtime/DmxNode";
import type { TransportState } from "../runtime/dmx/DmxTransport";
import type { AttributeDef, FixtureProfile, AttributeRole } from "../runtime/dmx/FixtureProfile";
import { describeValidationError, validateProfile } from "../runtime/dmx/FixtureProfile";
import type { FixtureInstance } from "../runtime/dmx/Patch";

type TabKey = "device" | "profiles" | "patch" | "monitor";

/**
 * Inline multi-tab panel for the `dmx` object. Rendered directly into the
 * object body on the canvas (no floating overlay). The instance persists
 * across graph re-renders — only the mount point changes — so mid-edit
 * form state (profile editor working copy, log scroll position, selected
 * tab) survives cable tweaks and node moves.
 *
 * - **Device**: Web Serial port picker, connect, rate slider, log.
 * - **Profiles**: bundled + user library; JSON paste import; structured
 *   channel-row editor on user profiles; duplicate-as-user on bundled.
 * - **Patch**: fixture-instance table with add form, mute/unpatch actions,
 *   occupancy strip, orphan-row flagging.
 * - **Monitor**: 512-cell live universe snapshot at 4 Hz.
 *
 * All mutations route through DmxNode public methods, which log to the
 * Device log. After profile/patch mutations the panel syncs node.args[6]/[7]
 * (base64 JSON) for persistence — ObjectInteractionController already does
 * this for message-driven mutations; the panel does it directly.
 */
export class DmxPanel {
  private readonly root: HTMLDivElement;
  private readonly tabs: Record<TabKey, HTMLButtonElement>;
  private readonly tabPanels: Record<TabKey, HTMLDivElement>;
  private currentHost: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private frameTickTimer: ReturnType<typeof setInterval> | null = null;

  // Device tab refs
  private statusDot!: HTMLSpanElement;
  private statusLabel!: HTMLSpanElement;
  private deviceLabel!: HTMLSpanElement;
  private connectBtn!: HTMLButtonElement;
  private rateInput!: HTMLInputElement;
  private rateReadout!: HTMLSpanElement;
  private logList!: HTMLDivElement;

  // Profiles tab refs
  private profileList!: HTMLDivElement;
  private profileDetail!: HTMLDivElement;
  private profileImportBox!: HTMLTextAreaElement;
  private profileImportStatus!: HTMLDivElement;
  private selectedProfileId: string | null = null;
  private editingProfileId: string | null = null;
  private editorWorkingCopy: FixtureProfile | null = null;

  // Patch tab refs
  private patchTable!: HTMLDivElement;
  private patchOccupancy!: HTMLDivElement;
  private patchAddName!: HTMLInputElement;
  private patchAddProfile!: HTMLSelectElement;
  private patchAddAddr!: HTMLInputElement;
  private patchAddStatus!: HTMLDivElement;

  // Monitor tab refs
  private monitorGrid!: HTMLDivElement;
  private monitorCells: HTMLDivElement[] = [];
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly patchNode: PatchNode,
    private readonly dmxNode: DmxNode,
    private readonly graph: PatchGraph,
  ) {
    this.tabs     = { device: null!, profiles: null!, patch: null!, monitor: null! };
    this.tabPanels = { device: null!, profiles: null!, patch: null!, monitor: null! };
    this.root = this.buildRoot();
    this.syncLive();
    this.refreshProfileList();
    this.refreshPatchTable();
  }

  /**
   * Mount (or re-parent) the panel into a host element. Idempotent — calling
   * on the same host is a no-op. Re-parenting preserves internal state
   * (selected tab, editor working copy, etc.) across patch re-renders.
   */
  attach(host: HTMLElement): void {
    if (this.currentHost === host) return;
    host.appendChild(this.root);
    this.currentHost = host;
    if (!this.unsubscribe) {
      this.unsubscribe = this.dmxNode.onChange(() => this.syncLive());
    }
    // Frame counter / log ticker — transport events don't fire per-frame, so
    // we poll at 2 Hz while the panel is attached. Stopped on detach.
    if (this.frameTickTimer === null) {
      this.frameTickTimer = setInterval(() => this.syncLive(), 500);
    }
    // If the Monitor tab is active on re-attach, restart its refresh loop.
    if (this.tabs.monitor?.dataset.active === "true") this.startMonitorLoop();
  }

  /** Detach from the current host without destroying state. */
  detach(): void {
    this.root.remove();
    this.currentHost = null;
    if (this.frameTickTimer !== null) {
      clearInterval(this.frameTickTimer);
      this.frameTickTimer = null;
    }
    this.stopMonitorLoop();
  }

  /** Tear down listeners + timers. Call when the underlying dmx node goes away. */
  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.frameTickTimer !== null) {
      clearInterval(this.frameTickTimer);
      this.frameTickTimer = null;
    }
    this.stopMonitorLoop();
    this.root.remove();
    this.currentHost = null;
  }

  // ── Shell ──────────────────────────────────────────────────────────

  private buildRoot(): HTMLDivElement {
    const root = document.createElement("div");
    root.className = "pn-dmx-panel";
    // Swallow wheel events so scrolling the panel doesn't pan/zoom the canvas.
    root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    // Swallow mousedown on non-interactive surfaces so clicks don't propagate
    // to drag-start. Interactive elements inherit pointer events normally.
    root.addEventListener("mousedown", (e) => e.stopPropagation());

    root.appendChild(this.buildSupportBanner());
    root.appendChild(this.buildTabStrip());

    const tabBody = document.createElement("div");
    tabBody.className = "pn-dmx-tab-body";
    tabBody.appendChild(this.buildDeviceTab());
    tabBody.appendChild(this.buildProfilesTab());
    tabBody.appendChild(this.buildPatchTab());
    tabBody.appendChild(this.buildMonitorTab());
    root.appendChild(tabBody);

    this.setActiveTab("device");
    return root;
  }

  private buildSupportBanner(): HTMLDivElement {
    const banner = document.createElement("div");
    banner.className = "pn-dmx-banner";
    if (!this.dmxNode.isSupported()) {
      banner.textContent = "Web Serial not supported in this browser. Use Chrome, Edge, or Opera.";
      banner.dataset.kind = "error";
    } else {
      banner.hidden = true;
    }
    return banner;
  }

  private buildTabStrip(): HTMLDivElement {
    const strip = document.createElement("div");
    strip.className = "pn-dmx-tab-strip";

    for (const key of ["device", "profiles", "patch", "monitor"] as TabKey[]) {
      const btn = document.createElement("button");
      btn.className = "pn-dmx-tab";
      btn.type = "button";
      btn.textContent = key;
      btn.addEventListener("click", () => this.setActiveTab(key));
      this.tabs[key] = btn;
      strip.appendChild(btn);
    }
    return strip;
  }

  private setActiveTab(key: TabKey): void {
    for (const k of ["device", "profiles", "patch", "monitor"] as TabKey[]) {
      this.tabs[k].dataset.active = k === key ? "true" : "false";
      this.tabPanels[k].hidden = k !== key;
    }
    if (key === "profiles") this.refreshProfileList();
    if (key === "patch")    this.refreshPatchTable();
    if (key === "monitor")  this.startMonitorLoop();
    else                    this.stopMonitorLoop();
  }

  // ── Device tab ─────────────────────────────────────────────────────

  private buildDeviceTab(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "pn-dmx-tab-panel";
    panel.appendChild(this.buildStatusRow());
    panel.appendChild(this.buildActionsRow());
    panel.appendChild(this.buildRateRow());
    panel.appendChild(this.buildLogSection());
    this.tabPanels.device = panel;
    return panel;
  }

  private buildStatusRow(): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-dmx-status-row";
    this.statusDot = document.createElement("span");
    this.statusDot.className = "pn-dmx-status-dot";
    const textWrap = document.createElement("div");
    textWrap.className = "pn-dmx-status-text";
    this.statusLabel = document.createElement("span");
    this.statusLabel.className = "pn-dmx-status-label";
    this.deviceLabel = document.createElement("span");
    this.deviceLabel.className = "pn-dmx-status-device";
    textWrap.append(this.statusLabel, this.deviceLabel);
    row.append(this.statusDot, textWrap);
    return row;
  }

  private buildActionsRow(): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-dmx-actions";

    const pickBtn = document.createElement("button");
    pickBtn.className = "pn-dmx-btn";
    pickBtn.type = "button";
    pickBtn.textContent = "select device...";
    pickBtn.addEventListener("click", () => this.handlePick());

    this.connectBtn = document.createElement("button");
    this.connectBtn.className = "pn-dmx-btn pn-dmx-btn-primary";
    this.connectBtn.type = "button";
    this.connectBtn.textContent = "connect";
    this.connectBtn.addEventListener("click", () => this.handleConnectToggle());

    row.append(pickBtn, this.connectBtn);
    return row;
  }

  private buildRateRow(): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-dmx-rate-row";
    const label = document.createElement("span");
    label.className = "pn-dmx-label";
    label.textContent = "rate";
    this.rateInput = document.createElement("input");
    this.rateInput.type = "range";
    this.rateInput.className = "pn-dmx-slider";
    this.rateInput.min = "10";
    this.rateInput.max = "44";
    this.rateInput.step = "1";
    this.rateInput.value = String(this.dmxNode.getRateHz());
    this.rateInput.addEventListener("input", () => {
      const hz = parseInt(this.rateInput.value, 10);
      this.dmxNode.setRateHz(hz);
      this.patchNode.args[0] = String(hz);
      this.graph.emit("display");
    });
    this.rateReadout = document.createElement("span");
    this.rateReadout.className = "pn-dmx-readout";
    this.rateReadout.textContent = `${this.dmxNode.getRateHz()} Hz`;
    row.append(label, this.rateInput, this.rateReadout);
    return row;
  }

  private buildLogSection(): HTMLDivElement {
    const section = document.createElement("div");
    section.className = "pn-dmx-log-section";
    const label = document.createElement("div");
    label.className = "pn-dmx-log-label";
    label.textContent = "log";
    this.logList = document.createElement("div");
    this.logList.className = "pn-dmx-log-list";
    section.append(label, this.logList);
    return section;
  }

  private async handlePick(): Promise<void> {
    const info = await this.dmxNode.requestDevice();
    if (!info) return;
    this.patchNode.args[3] = String(info.usbVendorId ?? 0);
    this.patchNode.args[4] = String(info.usbProductId ?? 0);
    this.patchNode.args[5] = info.label;
    this.graph.emit("change");
  }

  private async handleConnectToggle(): Promise<void> {
    const state = this.dmxNode.getState();
    if (state === "connected" || state === "connecting") {
      await this.dmxNode.disconnect();
      this.patchNode.args[2] = "0";
      // "change" so the open flag persists through reloads (otherwise the
      // page would auto-reconnect into a state the user explicitly ended).
      this.graph.emit("change");
      return;
    }
    if (!this.dmxNode.getInfo()) {
      const vid = parseInt(this.patchNode.args[3] ?? "0", 10) || null;
      const pid = parseInt(this.patchNode.args[4] ?? "0", 10) || null;
      let info = await this.dmxNode.reacquire(vid, pid);
      if (!info) info = await this.dmxNode.requestDevice();
      if (!info) return;
      this.patchNode.args[3] = String(info.usbVendorId ?? 0);
      this.patchNode.args[4] = String(info.usbProductId ?? 0);
      this.patchNode.args[5] = info.label;
    }
    await this.dmxNode.connect();
    if (this.dmxNode.getState() === "connected") {
      this.patchNode.args[2] = "1";
      // "change" so args[2..5] (open + vid/pid/label) all flush to disk
      // — auto-reconnect on next load needs them.
    }
    this.graph.emit("change");
  }

  // ── Profiles tab ───────────────────────────────────────────────────

  private buildProfilesTab(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "pn-dmx-tab-panel pn-dmx-profiles-panel";

    const split = document.createElement("div");
    split.className = "pn-dmx-profiles-split";

    this.profileList = document.createElement("div");
    this.profileList.className = "pn-dmx-profiles-list";

    this.profileDetail = document.createElement("div");
    this.profileDetail.className = "pn-dmx-profiles-detail";

    split.append(this.profileList, this.profileDetail);
    panel.appendChild(split);

    const importSection = document.createElement("div");
    importSection.className = "pn-dmx-profile-import";

    const importLabel = document.createElement("div");
    importLabel.className = "pn-dmx-log-label";
    importLabel.textContent = "import profile (paste JSON)";

    this.profileImportBox = document.createElement("textarea");
    this.profileImportBox.className = "pn-dmx-profile-import-box";
    this.profileImportBox.rows = 4;
    this.profileImportBox.placeholder = '{ "id": "...", "name": "...", "channelCount": N, "attributes": [...] }';

    const importRow = document.createElement("div");
    importRow.className = "pn-dmx-actions";
    const importBtn = document.createElement("button");
    importBtn.className = "pn-dmx-btn pn-dmx-btn-primary";
    importBtn.type = "button";
    importBtn.textContent = "import";
    importBtn.addEventListener("click", () => this.handleProfileImport());

    const importFileBtn = document.createElement("button");
    importFileBtn.className = "pn-dmx-btn";
    importFileBtn.type = "button";
    importFileBtn.textContent = "import from file…";
    importFileBtn.addEventListener("click", () => this.handleProfileImportFile());

    const exportFileBtn = document.createElement("button");
    exportFileBtn.className = "pn-dmx-btn";
    exportFileBtn.type = "button";
    exportFileBtn.textContent = "export user profiles";
    exportFileBtn.addEventListener("click", () => this.handleProfileExportFile());

    importRow.append(importBtn, importFileBtn, exportFileBtn);

    this.profileImportStatus = document.createElement("div");
    this.profileImportStatus.className = "pn-dmx-import-status";

    importSection.append(importLabel, this.profileImportBox, importRow, this.profileImportStatus);
    panel.appendChild(importSection);

    this.tabPanels.profiles = panel;
    return panel;
  }

  private refreshProfileList(): void {
    if (!this.profileList) return;
    this.profileList.textContent = "";
    const profiles = this.dmxNode.listProfiles();
    // User profiles are a subset of listProfiles(); the rest are bundled.
    const userIds = new Set(this.dmxNode.exportUserProfiles().map(p => p.id));

    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-dmx-empty";
      empty.textContent = "no profiles";
      this.profileList.appendChild(empty);
    }

    for (const p of profiles) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pn-dmx-profile-row";
      row.dataset.selected = p.id === this.selectedProfileId ? "true" : "false";

      const name = document.createElement("span");
      name.className = "pn-dmx-profile-name";
      name.textContent = p.name;

      const badge = document.createElement("span");
      badge.className = "pn-dmx-profile-badge";
      badge.textContent = userIds.has(p.id) ? "user" : "built-in";

      const meta = document.createElement("span");
      meta.className = "pn-dmx-profile-meta";
      meta.textContent = `${p.channelCount}ch${p.mode ? ` · ${p.mode}` : ""}`;

      row.append(name, badge, meta);
      row.addEventListener("click", () => {
        this.selectedProfileId = p.id;
        this.refreshProfileList();
        this.renderProfileDetail(p);
      });
      this.profileList.appendChild(row);
    }

    if (this.selectedProfileId) {
      const current = profiles.find(p => p.id === this.selectedProfileId);
      if (current) this.renderProfileDetail(current);
      else this.profileDetail.textContent = "";
    } else if (profiles[0]) {
      this.renderProfileDetail(profiles[0]);
    }
  }

  private renderProfileDetail(p: FixtureProfile): void {
    if (!this.profileDetail) return;
    this.profileDetail.textContent = "";
    if (this.editingProfileId === p.id && this.editorWorkingCopy) {
      this.renderProfileEditor();
    } else {
      this.renderProfileReadOnly(p);
    }
  }

  private renderProfileReadOnly(p: FixtureProfile): void {
    const header = document.createElement("div");
    header.className = "pn-dmx-profile-detail-header";
    const name = document.createElement("div");
    name.className = "pn-dmx-profile-detail-name";
    name.textContent = p.name;
    const id = document.createElement("div");
    id.className = "pn-dmx-profile-detail-id";
    id.textContent = p.id;
    header.append(name, id);
    this.profileDetail.appendChild(header);

    const table = document.createElement("div");
    table.className = "pn-dmx-profile-channels";
    const head = document.createElement("div");
    head.className = "pn-dmx-profile-channel-row pn-dmx-profile-channel-head";
    head.append(cell("ch"), cell("attribute"), cell("type"), cell("default"));
    table.appendChild(head);

    for (const attr of p.attributes) {
      const row = document.createElement("div");
      row.className = "pn-dmx-profile-channel-row";
      const chLabel = attr.type === "16bit" && attr.fineOffset !== undefined
        ? `${attr.offset + 1}+${attr.fineOffset + 1}`
        : String(attr.offset + 1);
      row.append(
        cell(chLabel),
        cell(attr.name),
        cell(attr.type + (attr.role ? ` · ${attr.role}` : "")),
        cell(String(attr.default)),
      );
      table.appendChild(row);
    }
    this.profileDetail.appendChild(table);

    const userIds = new Set(this.dmxNode.exportUserProfiles().map(p => p.id));
    const actions = document.createElement("div");
    actions.className = "pn-dmx-actions";

    if (userIds.has(p.id)) {
      const edit = document.createElement("button");
      edit.className = "pn-dmx-btn pn-dmx-btn-primary";
      edit.type = "button";
      edit.textContent = "edit";
      edit.addEventListener("click", () => this.enterEditMode(p));
      actions.appendChild(edit);

      const rm = document.createElement("button");
      rm.className = "pn-dmx-btn";
      rm.type = "button";
      rm.textContent = "remove";
      rm.addEventListener("click", () => {
        if (this.dmxNode.removeProfile(p.id)) {
          this.selectedProfileId = null;
          this.persistProfiles();
          this.refreshProfileList();
          this.refreshPatchTable();
        }
      });
      actions.appendChild(rm);
    } else {
      const dup = document.createElement("button");
      dup.className = "pn-dmx-btn pn-dmx-btn-primary";
      dup.type = "button";
      dup.textContent = "duplicate as user profile";
      dup.addEventListener("click", () => this.duplicateProfile(p));
      actions.appendChild(dup);
    }
    this.profileDetail.appendChild(actions);
  }

  // ── Profile editor ────────────────────────────────────────────────

  private enterEditMode(p: FixtureProfile): void {
    this.editingProfileId = p.id;
    this.editorWorkingCopy = cloneProfile(p);
    this.renderProfileDetail(this.editorWorkingCopy);
  }

  private exitEditMode(): void {
    this.editingProfileId = null;
    this.editorWorkingCopy = null;
    this.refreshProfileList();
  }

  private duplicateProfile(source: FixtureProfile): void {
    const newId = uniqueProfileId(`${source.id}-copy`, new Set(this.dmxNode.listProfiles().map(p => p.id)));
    const clone: FixtureProfile = { ...cloneProfile(source), id: newId, name: `${source.name} (copy)` };
    const err = this.dmxNode.importProfile(clone);
    if (err) {
      this.profileImportStatus.dataset.kind = "error";
      this.profileImportStatus.textContent = err;
      return;
    }
    this.persistProfiles();
    this.selectedProfileId = newId;
    this.enterEditMode(clone);
    this.refreshProfileList();
  }

  private renderProfileEditor(): void {
    const wc = this.editorWorkingCopy;
    if (!wc) return;

    const header = document.createElement("div");
    header.className = "pn-dmx-profile-detail-header";
    const headingRow = document.createElement("div");
    headingRow.className = "pn-dmx-profile-editor-heading";

    const nameIn = document.createElement("input");
    nameIn.className = "pn-dmx-input pn-dmx-profile-editor-name";
    nameIn.value = wc.name;
    nameIn.placeholder = "profile name";
    nameIn.addEventListener("input", () => { wc.name = nameIn.value; });

    const idReadout = document.createElement("span");
    idReadout.className = "pn-dmx-profile-detail-id";
    idReadout.textContent = wc.id;

    headingRow.append(nameIn, idReadout);
    header.appendChild(headingRow);
    this.profileDetail.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "pn-dmx-profile-editor-meta";

    const countLabel = document.createElement("span");
    countLabel.className = "pn-dmx-label";
    countLabel.textContent = "channels";
    const countIn = document.createElement("input");
    countIn.className = "pn-dmx-input pn-dmx-profile-editor-count";
    countIn.type = "number";
    countIn.min = "1";
    countIn.max = "512";
    countIn.value = String(wc.channelCount);
    countIn.addEventListener("input", () => {
      const v = parseInt(countIn.value, 10);
      if (Number.isFinite(v) && v >= 1 && v <= 512) wc.channelCount = v;
    });
    meta.append(countLabel, countIn);
    this.profileDetail.appendChild(meta);

    // Attribute rows
    const table = document.createElement("div");
    table.className = "pn-dmx-profile-channels pn-dmx-profile-editor-table";
    const head = document.createElement("div");
    head.className = "pn-dmx-profile-channel-row pn-dmx-profile-editor-head";
    head.append(cell("name"), cell("type"), cell("ofs"), cell("fine"), cell("default"), cell("role"), cell(""));
    table.appendChild(head);

    const renderRow = (attr: AttributeDef, i: number): HTMLDivElement => {
      const row = document.createElement("div");
      row.className = "pn-dmx-profile-channel-row pn-dmx-profile-editor-row";

      const nameI = document.createElement("input");
      nameI.className = "pn-dmx-input";
      nameI.value = attr.name;
      nameI.addEventListener("input", () => { attr.name = nameI.value.trim(); });

      const typeS = document.createElement("select");
      typeS.className = "pn-dmx-select";
      for (const opt of ["8bit", "16bit"]) {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        typeS.appendChild(o);
      }
      typeS.value = attr.type;

      const offsetI = document.createElement("input");
      offsetI.className = "pn-dmx-input";
      offsetI.type = "number";
      offsetI.min = "0";
      offsetI.value = String(attr.offset);
      offsetI.addEventListener("input", () => {
        const v = parseInt(offsetI.value, 10);
        if (Number.isFinite(v) && v >= 0) attr.offset = v;
      });

      const fineI = document.createElement("input");
      fineI.className = "pn-dmx-input";
      fineI.type = "number";
      fineI.min = "0";
      fineI.value = attr.fineOffset !== undefined ? String(attr.fineOffset) : "";
      fineI.placeholder = "–";
      fineI.disabled = attr.type !== "16bit";
      fineI.addEventListener("input", () => {
        const v = parseInt(fineI.value, 10);
        attr.fineOffset = Number.isFinite(v) && v >= 0 ? v : undefined;
      });

      typeS.addEventListener("change", () => {
        attr.type = typeS.value as "8bit" | "16bit";
        fineI.disabled = attr.type !== "16bit";
        if (attr.type === "8bit") {
          attr.fineOffset = undefined;
          fineI.value = "";
        }
      });

      const defaultI = document.createElement("input");
      defaultI.className = "pn-dmx-input";
      defaultI.type = "number";
      defaultI.min = "0";
      defaultI.max = "65535";
      defaultI.value = String(attr.default);
      defaultI.addEventListener("input", () => {
        const v = parseInt(defaultI.value, 10);
        if (Number.isFinite(v)) attr.default = v;
      });

      const roleS = document.createElement("select");
      roleS.className = "pn-dmx-select";
      const roles: AttributeRole[] = [
        "intensity", "color.r", "color.g", "color.b", "color.w", "color.a", "color.uv",
        "position.pan", "position.tilt",
        "gobo", "prism", "strobe", "shutter", "macro", "speed",
        "zoom", "focus", "other",
      ];
      const none = document.createElement("option");
      none.value = ""; none.textContent = "—";
      roleS.appendChild(none);
      for (const r of roles) {
        const o = document.createElement("option");
        o.value = r; o.textContent = r;
        roleS.appendChild(o);
      }
      roleS.value = attr.role ?? "";
      roleS.addEventListener("change", () => {
        attr.role = (roleS.value || undefined) as AttributeRole | undefined;
      });

      const rm = document.createElement("button");
      rm.className = "pn-dmx-btn pn-dmx-btn-small";
      rm.type = "button";
      rm.textContent = "×";
      rm.title = "remove attribute";
      rm.addEventListener("click", () => {
        wc.attributes.splice(i, 1);
        this.renderProfileDetail(wc);
      });

      row.append(nameI, typeS, offsetI, fineI, defaultI, roleS, rm);
      return row;
    };

    wc.attributes.forEach((attr, i) => table.appendChild(renderRow(attr, i)));
    this.profileDetail.appendChild(table);

    // Add row
    const addBtn = document.createElement("button");
    addBtn.className = "pn-dmx-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ add channel";
    addBtn.addEventListener("click", () => {
      const nextOffset = wc.attributes.reduce((max, a) => {
        const claim = a.type === "16bit" && a.fineOffset !== undefined ? Math.max(a.offset, a.fineOffset) : a.offset;
        return Math.max(max, claim);
      }, -1) + 1;
      wc.attributes.push({
        name: `attr${wc.attributes.length + 1}`,
        type: "8bit",
        offset: nextOffset,
        default: 0,
      });
      this.renderProfileDetail(wc);
    });
    this.profileDetail.appendChild(addBtn);

    // Save / Cancel + validation output
    const statusLine = document.createElement("div");
    statusLine.className = "pn-dmx-import-status";
    this.profileDetail.appendChild(statusLine);

    const footer = document.createElement("div");
    footer.className = "pn-dmx-actions";
    const save = document.createElement("button");
    save.className = "pn-dmx-btn pn-dmx-btn-primary";
    save.type = "button";
    save.textContent = "save";
    save.addEventListener("click", () => {
      const errors = validateProfile(wc);
      if (errors.length > 0) {
        statusLine.dataset.kind = "error";
        statusLine.textContent = errors.map(describeValidationError).join("; ");
        return;
      }
      this.dmxNode.importProfile(wc);
      this.persistProfiles();
      this.exitEditMode();
      this.selectedProfileId = wc.id;
      this.refreshProfileList();
      this.refreshPatchTable();
    });

    const cancel = document.createElement("button");
    cancel.className = "pn-dmx-btn";
    cancel.type = "button";
    cancel.textContent = "cancel";
    cancel.addEventListener("click", () => {
      this.exitEditMode();
      // Re-render detail pane with the unedited profile
      const original = this.dmxNode.listProfiles().find(p => p.id === this.selectedProfileId);
      if (original) this.renderProfileDetail(original);
    });

    footer.append(save, cancel);
    this.profileDetail.appendChild(footer);
  }

  private handleProfileExportFile(): void {
    const profiles = this.dmxNode.exportUserProfiles();
    if (profiles.length === 0) {
      this.profileImportStatus.dataset.kind = "error";
      this.profileImportStatus.textContent = "no user profiles to export";
      return;
    }
    const json = JSON.stringify(profiles, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const a = document.createElement("a");
    a.href = url;
    a.download = `patchnet-dmx-profiles-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.profileImportStatus.dataset.kind = "ok";
    this.profileImportStatus.textContent = `exported ${profiles.length} profile${profiles.length === 1 ? "" : "s"}`;
  }

  private handleProfileImportFile(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        this.profileImportStatus.dataset.kind = "error";
        this.profileImportStatus.textContent = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
      // Accept either a single profile object or an array.
      const items = Array.isArray(parsed) ? parsed : [parsed];
      let ok = 0;
      const failures: string[] = [];
      for (const item of items) {
        const err = this.dmxNode.importProfile(item);
        if (err) failures.push(err);
        else ok++;
      }
      if (ok > 0) this.persistProfiles();
      this.profileImportStatus.dataset.kind = failures.length > 0 ? "error" : "ok";
      this.profileImportStatus.textContent = failures.length > 0
        ? `imported ${ok}, failed ${failures.length}: ${failures[0]}`
        : `imported ${ok} profile${ok === 1 ? "" : "s"}`;
      this.refreshProfileList();
      this.refreshPatchTable();
    });
    input.click();
  }

  private handleProfileImport(): void {
    this.profileImportStatus.textContent = "";
    const raw = this.profileImportBox.value.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.profileImportStatus.dataset.kind = "error";
      this.profileImportStatus.textContent = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    const err = this.dmxNode.importProfile(parsed);
    if (err) {
      this.profileImportStatus.dataset.kind = "error";
      this.profileImportStatus.textContent = err;
      return;
    }
    this.profileImportStatus.dataset.kind = "ok";
    this.profileImportStatus.textContent = "imported";
    this.profileImportBox.value = "";
    this.persistProfiles();
    this.refreshProfileList();
    this.refreshPatchTable();
  }

  // ── Patch tab ──────────────────────────────────────────────────────

  private buildPatchTab(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "pn-dmx-tab-panel pn-dmx-patch-panel";

    // Universe shortcut row: affects every patched fixture at once.
    const shortcutRow = document.createElement("div");
    shortcutRow.className = "pn-dmx-actions pn-dmx-patch-shortcuts";

    const homeBtn = document.createElement("button");
    homeBtn.className = "pn-dmx-btn pn-dmx-btn-small";
    homeBtn.type = "button";
    homeBtn.textContent = "home all";
    homeBtn.title = "Write profile defaults to every patched fixture";
    homeBtn.addEventListener("click", () => this.dmxNode.allFixturesDefaults());

    const blackoutBtn = document.createElement("button");
    blackoutBtn.className = "pn-dmx-btn pn-dmx-btn-small";
    blackoutBtn.type = "button";
    blackoutBtn.textContent = "blackout all";
    blackoutBtn.title = "Zero every DMX channel in the universe";
    blackoutBtn.addEventListener("click", () => this.dmxNode.blackout());

    shortcutRow.append(homeBtn, blackoutBtn);
    panel.appendChild(shortcutRow);

    // Instance table
    this.patchTable = document.createElement("div");
    this.patchTable.className = "pn-dmx-patch-table";
    panel.appendChild(this.patchTable);

    // Occupancy strip
    const occSection = document.createElement("div");
    occSection.className = "pn-dmx-occ-section";
    const occLabel = document.createElement("div");
    occLabel.className = "pn-dmx-log-label";
    occLabel.textContent = "universe occupancy (1..512)";
    this.patchOccupancy = document.createElement("div");
    this.patchOccupancy.className = "pn-dmx-occ-strip";
    occSection.append(occLabel, this.patchOccupancy);
    panel.appendChild(occSection);

    // Add form
    const addSection = document.createElement("div");
    addSection.className = "pn-dmx-patch-add";
    const addLabel = document.createElement("div");
    addLabel.className = "pn-dmx-log-label";
    addLabel.textContent = "add fixture";
    const form = document.createElement("div");
    form.className = "pn-dmx-patch-add-form";

    this.patchAddName = document.createElement("input");
    this.patchAddName.className = "pn-dmx-input";
    this.patchAddName.placeholder = "name";

    this.patchAddProfile = document.createElement("select");
    this.patchAddProfile.className = "pn-dmx-select";

    this.patchAddAddr = document.createElement("input");
    this.patchAddAddr.className = "pn-dmx-input";
    this.patchAddAddr.type = "number";
    this.patchAddAddr.min = "1";
    this.patchAddAddr.max = "512";
    this.patchAddAddr.placeholder = "addr";

    const addBtn = document.createElement("button");
    addBtn.className = "pn-dmx-btn pn-dmx-btn-primary";
    addBtn.type = "button";
    addBtn.textContent = "patch";
    addBtn.addEventListener("click", () => this.handlePatchAdd());

    form.append(this.patchAddName, this.patchAddProfile, this.patchAddAddr, addBtn);

    this.patchAddStatus = document.createElement("div");
    this.patchAddStatus.className = "pn-dmx-import-status";

    addSection.append(addLabel, form, this.patchAddStatus);
    panel.appendChild(addSection);

    this.tabPanels.patch = panel;
    return panel;
  }

  private refreshPatchTable(): void {
    if (!this.patchTable) return;

    // Re-populate profile select
    const profiles = this.dmxNode.listProfiles();
    this.patchAddProfile.textContent = "";
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.id} (${p.channelCount}ch)`;
      this.patchAddProfile.appendChild(opt);
    }

    // Instance rows
    this.patchTable.textContent = "";
    const head = document.createElement("div");
    head.className = "pn-dmx-patch-row pn-dmx-patch-row-head";
    head.append(cell("name"), cell("profile"), cell("start"), cell("end"), cell(""));
    this.patchTable.appendChild(head);

    const instances = this.dmxNode.listFixtures();
    if (instances.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-dmx-empty";
      empty.textContent = "no fixtures patched";
      this.patchTable.appendChild(empty);
    }

    for (const inst of instances) {
      const profile = profiles.find(p => p.id === inst.profileId);
      const channelCount = profile?.channelCount ?? 0;
      const row = this.buildPatchRow(inst, channelCount, profile != null);
      this.patchTable.appendChild(row);
    }

    this.renderOccupancy();
  }

  private buildPatchRow(inst: FixtureInstance, channelCount: number, profileResolved: boolean): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-dmx-patch-row";
    if (inst.muted) row.dataset.muted = "true";
    if (!profileResolved) row.dataset.orphan = "true";

    const profileCell = cell(inst.profileId);
    if (!profileResolved) {
      profileCell.textContent = `${inst.profileId} ⚠`;
      profileCell.title = "Profile no longer exists — repoint this fixture to a different profile or unpatch it.";
    }

    row.append(
      cell(inst.name),
      profileCell,
      cell(String(inst.startAddress)),
      cell(channelCount > 0 ? String(inst.startAddress + channelCount - 1) : "?"),
    );

    const actions = document.createElement("div");
    actions.className = "pn-dmx-patch-row-actions";

    // Orphan rows get a repoint-inline flow: click "repoint..." → a select
    // replaces the button with every available profile → pick one → live
    // repoint. If the pick creates an overlap, error surfaces in the status
    // line and the row stays orphaned so the user can try another.
    if (!profileResolved) {
      const repointBtn = document.createElement("button");
      repointBtn.className = "pn-dmx-btn pn-dmx-btn-small";
      repointBtn.type = "button";
      repointBtn.textContent = "repoint…";
      repointBtn.addEventListener("click", () => {
        const select = document.createElement("select");
        select.className = "pn-dmx-select pn-dmx-btn-small";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "— pick profile —";
        select.appendChild(placeholder);
        for (const p of this.dmxNode.listProfiles()) {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = `${p.id} (${p.channelCount}ch)`;
          select.appendChild(opt);
        }
        select.addEventListener("change", () => {
          const target = select.value;
          if (!target) return;
          const err = this.dmxNode.repointFixture(inst.name, target);
          if (err) {
            this.patchAddStatus.dataset.kind = "error";
            this.patchAddStatus.textContent = `repoint ${inst.name}: ${describePatchErrorInline(err)}`;
            return;
          }
          this.patchAddStatus.dataset.kind = "ok";
          this.patchAddStatus.textContent = `repointed ${inst.name}`;
          this.persistPatches();
          this.refreshPatchTable();
        });
        repointBtn.replaceWith(select);
        select.focus();
      });
      actions.appendChild(repointBtn);
    } else {
      const muteBtn = document.createElement("button");
      muteBtn.className = "pn-dmx-btn pn-dmx-btn-small";
      muteBtn.type = "button";
      muteBtn.textContent = inst.muted ? "unmute" : "mute";
      muteBtn.addEventListener("click", () => {
        this.dmxNode.setFixtureMuted(inst.name, !inst.muted);
        this.persistPatches();
        this.refreshPatchTable();
      });

      const defBtn = document.createElement("button");
      defBtn.className = "pn-dmx-btn pn-dmx-btn-small";
      defBtn.type = "button";
      defBtn.textContent = "defaults";
      defBtn.addEventListener("click", () => {
        this.dmxNode.fixtureDefaults(inst.name);
      });

      actions.append(muteBtn, defBtn);
    }

    // Unpatch is always available — even on orphans, since removing the
    // broken instance is a valid recovery path.
    const rmBtn = document.createElement("button");
    rmBtn.className = "pn-dmx-btn pn-dmx-btn-small";
    rmBtn.type = "button";
    rmBtn.textContent = "unpatch";
    rmBtn.addEventListener("click", () => {
      this.dmxNode.unpatchFixture(inst.name);
      this.persistPatches();
      this.refreshPatchTable();
    });
    actions.appendChild(rmBtn);

    row.appendChild(actions);
    return row;
  }

  private renderOccupancy(): void {
    const occ = this.dmxNode.occupancy();
    // Assign each fixture a stable hue index based on first-appearance order.
    const nameToIdx = new Map<string, number>();
    this.patchOccupancy.textContent = "";
    for (let i = 0; i < occ.length; i++) {
      const cell = document.createElement("div");
      cell.className = "pn-dmx-occ-cell";
      const name = occ[i];
      if (name) {
        if (!nameToIdx.has(name)) nameToIdx.set(name, nameToIdx.size);
        cell.dataset.claimed = "true";
        cell.dataset.fixture = name;
        cell.title = `ch ${i + 1}: ${name}`;
      }
      this.patchOccupancy.appendChild(cell);
    }
  }

  private handlePatchAdd(): void {
    this.patchAddStatus.textContent = "";
    const name = this.patchAddName.value.trim();
    const profileId = this.patchAddProfile.value;
    const addr = parseInt(this.patchAddAddr.value, 10);

    if (!name || !profileId || !Number.isFinite(addr)) {
      this.patchAddStatus.dataset.kind = "error";
      this.patchAddStatus.textContent = "name, profile, and address required";
      return;
    }

    const err = this.dmxNode.patchFixture(name, profileId, addr);
    if (err) {
      this.patchAddStatus.dataset.kind = "error";
      this.patchAddStatus.textContent = describePatchErrorInline(err);
      return;
    }
    this.patchAddStatus.dataset.kind = "ok";
    this.patchAddStatus.textContent = `patched ${name}`;
    this.patchAddName.value = "";
    this.patchAddAddr.value = "";
    this.persistPatches();
    this.refreshPatchTable();
  }

  // ── Monitor tab ────────────────────────────────────────────────────

  private buildMonitorTab(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "pn-dmx-tab-panel pn-dmx-monitor-panel";

    const label = document.createElement("div");
    label.className = "pn-dmx-log-label";
    label.textContent = "universe snapshot (ch 1..512) — brightness ∝ value";
    panel.appendChild(label);

    this.monitorGrid = document.createElement("div");
    this.monitorGrid.className = "pn-dmx-monitor-grid";
    // 512 fixed cells, 64 per row × 8 rows. Built once, painted in place.
    this.monitorCells = [];
    for (let i = 0; i < 512; i++) {
      const c = document.createElement("div");
      c.className = "pn-dmx-monitor-cell";
      this.monitorCells.push(c);
      this.monitorGrid.appendChild(c);
    }
    panel.appendChild(this.monitorGrid);

    this.tabPanels.monitor = panel;
    return panel;
  }

  private startMonitorLoop(): void {
    if (this.monitorTimer !== null) return;
    const tick = () => this.paintMonitor();
    tick();
    this.monitorTimer = setInterval(tick, 250);
  }

  private stopMonitorLoop(): void {
    if (this.monitorTimer === null) return;
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  private paintMonitor(): void {
    const snapshot = this.dmxNode.getUniverseSnapshot();
    const occ = this.dmxNode.occupancy();
    for (let i = 0; i < 512; i++) {
      const v = snapshot[i];
      const cell = this.monitorCells[i];
      // CSS variable drives a phosphor-green fill. 0 = nearly black, 255 = full.
      cell.style.setProperty("--pn-mon-v", String(v / 255));
      const owner = occ[i];
      cell.dataset.claimed = owner ? "true" : "false";
      cell.title = owner
        ? `ch ${i + 1}  =  ${v}  ·  ${owner}`
        : `ch ${i + 1}  =  ${v}`;
    }
  }

  // ── Live sync + persistence ────────────────────────────────────────

  private syncLive(): void {
    if (!this.statusDot) return;
    const state = this.dmxNode.getState();
    const info = this.dmxNode.getInfo();
    const rateHz = this.dmxNode.getRateHz();
    const frames = this.dmxNode.getFramesSent();
    this.statusDot.dataset.state = state;
    this.statusLabel.textContent = state === "connected"
      ? `${stateLabel(state)}  ·  ${rateHz} Hz  ·  ${frames}f`
      : stateLabel(state);
    this.deviceLabel.textContent = info ? info.label : "no device";
    this.connectBtn.textContent = (state === "connected" || state === "connecting") ? "disconnect" : "connect";
    this.rateInput.value = String(rateHz);
    this.rateReadout.textContent = `${rateHz} Hz`;
    this.renderLog(this.dmxNode.getLog());
  }

  private renderLog(entries: readonly DmxLogEntry[]): void {
    this.logList.textContent = "";
    const recent = entries.slice(-16);
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      const row = document.createElement("div");
      row.className = "pn-dmx-log-row";
      row.dataset.level = e.level;
      const time = document.createElement("span");
      time.className = "pn-dmx-log-time";
      time.textContent = formatTime(e.time);
      const msg = document.createElement("span");
      msg.className = "pn-dmx-log-msg";
      msg.textContent = e.message;
      row.append(time, msg);
      this.logList.appendChild(row);
    }
  }

  private persistProfiles(): void {
    const profiles = this.dmxNode.exportUserProfiles();
    this.patchNode.args[6] = encodeBase64Json(profiles);
    // "change" so the main-app autosave flushes to localStorage. "display"
    // would only sync the text panel — profiles wouldn't survive reload.
    this.graph.emit("change");
  }

  private persistPatches(): void {
    const instances = this.dmxNode.exportInstances();
    this.patchNode.args[7] = encodeBase64Json(instances);
    // Same reasoning as persistProfiles — fixture patches must reach disk.
    this.graph.emit("change");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function cell(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "pn-dmx-cell";
  el.textContent = text;
  return el;
}

function stateLabel(state: TransportState): string {
  switch (state) {
    case "idle":         return "idle";
    case "connecting":   return "connecting…";
    case "connected":    return "connected";
    case "reconnecting": return "reconnecting…";
    case "error":        return "error";
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function encodeBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json || json === "[]") return "";
  return btoa(unescape(encodeURIComponent(json)));
}

function cloneProfile(p: FixtureProfile): FixtureProfile {
  return {
    id: p.id,
    name: p.name,
    manufacturer: p.manufacturer,
    mode: p.mode,
    channelCount: p.channelCount,
    attributes: p.attributes.map(a => ({ ...a })),
  };
}

function uniqueProfileId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Patch errors are declared in runtime/dmx/Patch.ts; this mirror keeps UI
 *  copy in sync without importing describePatchError's full enum. */
function describePatchErrorInline(err: unknown): string {
  const e = err as { kind?: string } & Record<string, unknown>;
  switch (e.kind) {
    case "no-profile":        return `unknown profile "${String(e.profileId)}"`;
    case "bad-address":       return `address ${String(e.address)} + ${String(e.channelCount)} channels exceeds universe`;
    case "duplicate-name":    return `name "${String(e.name)}" already exists`;
    case "bad-name":          return `invalid name "${String(e.name)}"`;
    case "overlap":           return `channel ${String(e.startByte)} already claimed by "${String(e.existingName)}"`;
    case "no-such-fixture":   return `no fixture "${String(e.name)}"`;
    case "no-such-attribute": return `"${String(e.fixture)}" has no attribute "${String(e.attribute)}"`;
    default:                  return "patch failed";
  }
}
