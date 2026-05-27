// @ts-nocheck — pi provides these packages at runtime

/**
 * patchnet TUI Extension
 *
 * Brings patchnet's dichromatic black-and-lime CRT aesthetic to pi.
 *
 * Features:
 *  - Phosphor-glow working indicator
 *  - Scanline widget below editor
 *  - patchnet-style footer with model/git info
 *  - Session sidebar (alt+s / /sessions) — browse, switch, rename, delete
 *  - /patchnet command to toggle CRT effects
 *
 * Install:
 *   1. Copy to ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project)
 *   2. Select theme: /settings → theme → patchnet
 *   3. Or: pi --extension ./patchnet-extension.ts --theme ./patchnet-theme.json
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type {
	SessionInfo,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { SessionManager as SM } from "@earendil-works/pi-coding-agent";

// ─── patchnet color constants ───────────────────────────────────────────────

const LIME = "\x1b[38;2;0;255;0m";
const LIME_BRIGHT = "\x1b[38;2;102;255;102m";
const LIME_DIM = "\x1b[38;2;0;204;0m";
const LIME_MUTED = "\x1b[38;2;0;153;0m";
const LIME_DEEP = "\x1b[38;2;0;102;0m";
const LIME_TRACE = "\x1b[38;2;0;51;0m";
const LIME_BG = "\x1b[48;2;0;26;0m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

// Border chars
const SEP = `${LIME_DIM}│${RESET}`;

// ─── Phosphor glow working indicator ────────────────────────────────────────

const PHOSPHOR_FRAMES = [
	`${LIME_DIM}·${RESET}`,
	`${LIME_MUTED}·${RESET}`,
	`${LIME_DIM}•${RESET}`,
	`${LIME}•${RESET}`,
	`${LIME_BRIGHT}●${RESET}`,
	`${LIME}●${RESET}`,
	`${LIME_DIM}•${RESET}`,
	`${LIME_MUTED}·${RESET}`,
];

const PHOSPHOR_BLOOM_FRAMES = [
	`${LIME_MUTED}⚡${RESET}`,
	`${LIME_DIM}⚡${RESET}`,
	`${LIME}⚡${RESET}`,
	`${LIME_BRIGHT}⚡${RESET}`,
	`${LIME}⚡${RESET}`,
	`${LIME_DIM}⚡${RESET}`,
	`${LIME_MUTED}⚡${RESET}`,
	`${LIME_TRACE}⚡${RESET}`,
];

const phosphorIndicator: WorkingIndicatorOptions = {
	frames: PHOSPHOR_FRAMES,
	intervalMs: 100,
};

const phosphorBloomIndicator: WorkingIndicatorOptions = {
	frames: PHOSPHOR_BLOOM_FRAMES,
	intervalMs: 80,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function lime(text: string): string {
	return `${LIME}${text}${RESET}`;
}

function limeDim(text: string): string {
	return `${LIME_DIM}${text}${RESET}`;
}

function limeMuted(text: string): string {
	return `${LIME_MUTED}${text}${RESET}`;
}

function limeDeep(text: string): string {
	return `${LIME_DEEP}${text}${RESET}`;
}

// ─── Scanline widget ────────────────────────────────────────────────────────

function renderScanlines(width: number): string[] {
	const dot = `${LIME_TRACE}·${RESET}`;
	const row = Array(Math.max(1, Math.floor(width / 3)))
		.fill(dot)
		.join(" ");
	return [
		`${LIME_BG}${LIME_TRACE}${"─".repeat(Math.max(0, width - 4))}${RESET}`,
		`${LIME_BG}${row}${RESET}`,
		`${LIME_BG}${LIME_TRACE}${"─".repeat(Math.max(0, width - 4))}${RESET}`,
	];
}

// ─── Session Sidebar ────────────────────────────────────────────────────────

interface SidebarState {
	sessions: SessionInfo[];
	selectedIndex: number;
	currentSessionId: string | undefined;
	message: string | null;
}

class SessionSidebar {
	private state: SidebarState;
	private onClose: (result?: string) => void;
	private requestRender: () => void;
	private confirmDelete: string | null = null; // session path pending deletion

	constructor(
		sessions: SessionInfo[],
		currentSessionId: string | undefined,
		onClose: (result?: string) => void,
		requestRender: () => void,
	) {
		this.state = {
			sessions,
			selectedIndex: sessions.findIndex((s) => s.id === currentSessionId),
			currentSessionId,
			message: null,
		};
		if (this.state.selectedIndex === -1) this.state.selectedIndex = 0;
		this.onClose = onClose;
		this.requestRender = requestRender;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, Key.ctrl("c"))
		) {
			this.onClose();
			return;
		}

		if (matchesKey(data, Key.up)) {
			if (this.confirmDelete) {
				this.confirmDelete = null;
				this.state.message = null;
				this.requestRender();
				return;
			}
			if (this.state.selectedIndex > 0) {
				this.state.selectedIndex--;
				this.state.message = null;
				this.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.down)) {
			if (this.confirmDelete) {
				this.confirmDelete = null;
				this.state.message = null;
				this.requestRender();
				return;
			}
			if (this.state.selectedIndex < this.state.sessions.length - 1) {
				this.state.selectedIndex++;
				this.state.message = null;
				this.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (this.confirmDelete) {
				// Confirm delete
				this.deleteSession(this.confirmDelete);
				this.confirmDelete = null;
				return;
			}
			const sess = this.state.sessions[this.state.selectedIndex];
			if (sess) {
				this.state.message = `${limeDim("Switching to:")} ${truncateToWidth(sess.name || sess.id.slice(0, 8), 30)}`;
				this.requestRender();
				this.onClose(sess.path);
			}
			return;
		}

		// 'd' = delete (or confirm delete)
		if (data === "d") {
			const sess = this.state.sessions[this.state.selectedIndex];
			if (!sess) return;
			if (this.confirmDelete === sess.path) {
				// Second press = confirm
				this.deleteSession(sess.path);
				this.confirmDelete = null;
			} else {
				this.confirmDelete = sess.path;
				this.state.message = `${limeMuted("Press")} ${lime("d")} ${limeMuted("again to delete")}`;
				this.requestRender();
			}
			return;
		}

		// 'r' = rename (closes sidebar, opens rename prompt)
		if (data === "r" && !this.confirmDelete) {
			const sess = this.state.sessions[this.state.selectedIndex];
			if (!sess) return;
			this.onClose(`__rename__:${sess.path}`);
			return;
		}

		// 'n' = new session
		if (data === "n" && !this.confirmDelete) {
			this.state.message = `${limeDim("Creating new session...")}`;
			this.requestRender();
			this.onClose("__new__"); // signal: create new session
			return;
		}

		// Refresh list
		if (data === "R" && !this.confirmDelete) {
			this.state.message = `${limeDim("Refreshing...")}`;
			this.requestRender();
			return;
		}
	}

	private deleteSession(path: string) {
		const fs = require("node:fs");
		const pathMod = require("node:path");

		// Safety: only allow deleting .jsonl files under the sessions directory
		const sessionsDir = pathMod.resolve(
			pathMod.join(require("node:os").homedir(), ".pi", "agent", "sessions"),
		);
		const resolved = pathMod.resolve(path);
		if (!resolved.startsWith(sessionsDir) || !resolved.endsWith(".jsonl")) {
			this.state.message = `${limeMuted("Delete blocked: not a session file")}`;
			this.requestRender();
			return;
		}

		try {
			fs.unlinkSync(resolved);
			this.state.sessions = this.state.sessions.filter((s) => s.path !== path);
			if (this.state.selectedIndex >= this.state.sessions.length) {
				this.state.selectedIndex = Math.max(0, this.state.sessions.length - 1);
			}
			this.state.message = `${limeMuted("Session deleted")}`;
			this.requestRender();
		} catch (e) {
			this.state.message = `${LIME_DIM}Failed to delete: ${e.message}${RESET}`;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const contentWidth = width - 2; // 1 char padding each side

		// ── Top border ────────────────────────────────────────────
		lines.push(`${LIME_DEEP}${"━".repeat(width)}${RESET}`);

		// ── Header ────────────────────────────────────────────────
		const headerText = `${BOLD}${LIME}SESSIONS${RESET} ${limeDim(`(${this.state.sessions.length})`)}`;
		lines.push(`${padRight(truncateToWidth(headerText, contentWidth), width)}`);

		// ── Separator ─────────────────────────────────────────────
		lines.push(`${LIME_DEEP}${"─".repeat(width)}${RESET}`);

		// ── Key hints row ─────────────────────────────────────────
		const hints = `${limeDim("↑↓ sel")} ${SEP} ${limeDim("↵ switch")} ${SEP} ${limeDim("r ren")} ${SEP} ${limeDim("d del")} ${SEP} ${limeDim("esc close")}`;
		lines.push(`${padRight(truncateToWidth(hints, contentWidth), width)}`);

		lines.push(`${LIME_DEEP}${"─".repeat(width)}${RESET}`);

		// ── Session list ─────────────────────────────────────────
		const maxVisible = Math.min(this.state.sessions.length, 15);
		const start = Math.max(
			0,
			this.state.selectedIndex - Math.floor(maxVisible / 2),
		);
		const end = Math.min(this.state.sessions.length, start + maxVisible);
		const visible = this.state.sessions.slice(start, end);

		for (const sess of visible) {
			const isSelected =
				this.state.sessions.indexOf(sess) === this.state.selectedIndex;
			const isCurrent = sess.id === this.state.currentSessionId;
			const prefix = isSelected ? `${LIME}❯${RESET}` : " ";
			const cursor = isCurrent ? `${LIME}●${RESET}` : `${limeDeep("○")}`;

			const name =
				sess.name && sess.name !== "unnamed" ? sess.name : sess.id.slice(0, 8);
			const meta = `${sess.messageCount}msgs`;

			const paddedCursor = `${prefix} ${cursor}`;
			const nameStr = isSelected
				? `${LIME}${truncateToWidth(name, Math.floor(contentWidth * 0.5))}${RESET}`
				: `${limeDim(truncateToWidth(name, Math.floor(contentWidth * 0.5)))}`;
			const metaStr = isSelected ? `${limeMuted(meta)}` : `${limeDeep(meta)}`;

			const row = `${paddedCursor} ${nameStr} ${limeDeep("·")} ${metaStr}`;
			const bg = isSelected ? LIME_BG : "";
			lines.push(
				`${bg}${padRight(truncateToWidth(row, contentWidth), width)}${isSelected ? RESET : ""}`,
			);
		}

		// ── Bottom message ────────────────────────────────────────
		lines.push(`${LIME_DEEP}${"─".repeat(width)}${RESET}`);
		if (this.state.message) {
			lines.push(
				`${LIME_BG}${padRight(truncateToWidth(this.state.message, contentWidth), width)}${RESET}`,
			);
		} else {
			lines.push(`${padRight(limeDeep("alt+s to toggle"), width)}`);
		}

		// ── Bottom border ─────────────────────────────────────────
		lines.push(`${LIME_DEEP}${"━".repeat(width)}${RESET}`);

		return lines;
	}

	invalidate(): void {}
}

function padRight(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

// ─── Auto-naming for new sessions ──────────────────────────────────────────

let pendingAutoName = false;

function deriveName(text: string): string {
	// Take first ~48 chars, collapse whitespace, strip non-word chars
	const cleaned = text
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 48)
		.replace(/[^\w\s-]/g, "")
		.trim();
	return cleaned || "chat";
}

// ─── Turn counter ───────────────────────────────────────────────────────────

let turnCount = 0;
let crtEnabled = true;

function applyCRT(ctx: ExtensionContext) {
	if (!crtEnabled) {
		ctx.ui.setWorkingIndicator(undefined);
		ctx.ui.setStatus("patchnet", undefined);
		ctx.ui.setWidget("patchnet", undefined);
		return;
	}

	ctx.ui.setStatus(
		"patchnet-status",
		`${LIME_TRACE}[${RESET}${limeDim("●")}${LIME_TRACE}]${RESET} ${limeDim("patchnet")}`,
	);

	// Apply working indicator
	ctx.ui.setWorkingIndicator(
		turnCount > 0 ? phosphorBloomIndicator : phosphorIndicator,
	);
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function buildFooter(
	width: number,
	theme: { fg: (color: string, text: string) => string },
	footerData: {
		getGitBranch: () => string | null;
		getExtensionStatuses: () => ReadonlyMap<string, string>;
	},
	ctx: ExtensionContext,
) {
	const branch = footerData.getGitBranch();

	let input = 0,
		output = 0,
		cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			input += m.usage.input;
			output += m.usage.output;
			cost += m.usage.cost.total;
		}
	}

	const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

	// Left: patchnet brand + token stats
	const brand = `${LIME}PN${RESET}`;
	const stats = `${limeDim(`↑${fmt(input)}`)} ${limeDeep(`↓${fmt(output)}`)} ${limeMuted(`$${cost.toFixed(4)}`)}`;

	// Right: model + git branch
	const model = ctx.model?.id || "";
	const branchStr = branch ? `${limeDeep("⎇")} ${limeMuted(branch)}` : "";

	const left = `${brand} ${SEP} ${stats}`;
	const right = branch
		? `${branchStr} ${SEP} ${limeDim(model)}`
		: limeDim(model);

	const pad = " ".repeat(
		Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
	);

	// Add a thin phosphor glow line above the footer content
	const glowLine = `${LIME_DEEP}${"─".repeat(Math.max(0, width))}${RESET}`;

	return [`${glowLine}`, truncateToWidth(left + pad + right, width)];
}

// ─── Session sidebar handler ────────────────────────────────────────────────

async function openSessionSidebar(ctx: ExtensionContext) {
	// Loop: reopen after rename so the new name appears instantly
	while (true) {
		// Refresh session list
		const sessions = await SM.list(ctx.cwd);
		const currentId = ctx.sessionManager.getSessionId();

		// Sort by modified date, newest first
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

		// Open the overlay and wait for result
		const result = await ctx.ui.custom<string | null>(
			(tui, theme, keybindings, done) => {
				const sidebar = new SessionSidebar(sessions, currentId, done, () =>
					tui.requestRender(),
				);
				return sidebar;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "55%",
					minWidth: 42,
					maxHeight: "100%",
					anchor: "top-right",
				},
			},
		);

		// Handle the result
		if (!result) break; // closed normally

		if (result === "__new__") {
			ctx.ui.notify(
				`${limeMuted("Use")} ${lime("/new")} ${limeMuted("to start a fresh session")}`,
				"info",
			);
			break;
		}

		if (result.startsWith("__rename__:")) {
			const path = result.slice("__rename__:".length);
			// Get current name for placeholder
			const existing = sessions.find((s) => s.path === path);
			const placeholder = existing?.name?.slice(0, 40) || "new name";
			const newName = await ctx.ui.input("Rename session:", placeholder);
			if (newName && newName.trim()) {
				SM.open(path).appendSessionInfo(newName.trim());
				ctx.ui.notify(
					`${lime("Renamed to:")} ${limeDim(newName.trim())}`,
					"info",
				);
			}
			// Re-open sidebar with refreshed list
			continue;
		}

		// Switch to selected session
		await ctx.switchSession(result, {
			withSession: async (newCtx) => {
				newCtx.ui.notify(
					`${LIME}◈${RESET} ${lime("Switched session")}`,
					"info",
				);
			},
		});
		break;
	}
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		turnCount = 0;

		// Auto-name new sessions from first user message
		if (event.reason === "new" || event.reason === "fork") {
			pendingAutoName = true;
		}

		// Show startup notification
		ctx.ui.notify(`${LIME}◈${RESET} patchnet ${limeDim("CRT mode")}`, "info");

		// Apply CRT effects
		applyCRT(ctx);

		// Set custom footer
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					return buildFooter(width, theme, footerData, ctx);
				},
			};
		});

		// Set scanline widget
		ctx.ui.setWidget(
			"patchnet-scanlines",
			(_tui, _theme) => ({
				render: (width: number) => renderScanlines(width),
				invalidate: () => {},
			}),
			{ placement: "belowEditor" },
		);
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		applyCRT(ctx);

		// Animate status on turn start
		ctx.ui.setStatus(
			"patchnet-turn",
			`${LIME_TRACE}[${RESET}${limeDim(`#${turnCount}`)}${LIME_TRACE}]${RESET} ${limeDim("processing")}`,
		);
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus(
			"patchnet-turn",
			`${LIME_TRACE}[${RESET}${limeDim(`#${turnCount}`)}${LIME_TRACE}]${RESET} ${limeMuted("ready")}`,
		);
	});

	// ─── Auto-name new sessions on first user input ───────────────

	pi.on("input", async (event, ctx) => {
		if (pendingAutoName && !event.text.startsWith("/")) {
			pendingAutoName = false;
			const name = deriveName(event.text);
			if (name) {
				const file = ctx.sessionManager.getSessionFile();
				if (file) {
					SM.open(file).appendSessionInfo(name);
				}
			}
		}
		return { action: "continue" };
	});

	// ─── /sessions command — open chat sidebar ────────────────────

	pi.registerCommand("sessions", {
		description:
			"Open session sidebar: browse, switch, rename, delete sessions",
		handler: async (_args, ctx) => {
			await openSessionSidebar(ctx);
		},
	});

	// ─── alt+s shortcut for session sidebar ───────────────────────

	pi.registerShortcut("alt+s", {
		description: "Open session sidebar",
		handler: async (ctx) => {
			await openSessionSidebar(ctx);
		},
	});

	// ─── /patchnet command ────────────────────────────────────────

	pi.registerCommand("patchnet", {
		description: "Toggle patchnet CRT effects: /patchnet [on|off|status]",
		handler: async (args, ctx) => {
			const cmd = args?.trim().toLowerCase();

			if (cmd === "off") {
				crtEnabled = false;
				applyCRT(ctx);
				ctx.ui.setFooter(undefined);
				ctx.ui.setWidget("patchnet-scanlines", undefined);
				ctx.ui.setStatus("patchnet-status", undefined);
				ctx.ui.setStatus("patchnet-turn", undefined);
				ctx.ui.notify(`${limeMuted("patchnet CRT")} off`, "info");
				return;
			}

			if (cmd === "on" || cmd === "") {
				crtEnabled = true;
				await ctx.ui.setFooter((tui, theme, footerData) => {
					const unsub = footerData.onBranchChange(() => tui.requestRender());
					return {
						dispose: unsub,
						invalidate() {},
						render(width: number): string[] {
							return buildFooter(width, theme, footerData, ctx);
						},
					};
				});
				ctx.ui.setWidget(
					"patchnet-scanlines",
					(_tui, _theme) => ({
						render: (width: number) => renderScanlines(width),
						invalidate: () => {},
					}),
					{ placement: "belowEditor" },
				);
				applyCRT(ctx);
				ctx.ui.notify(
					`${LIME}◈${RESET} ${lime("patchnet CRT")} ${limeDim("on")}`,
					"info",
				);
				return;
			}

			if (cmd === "status") {
				ctx.ui.notify(
					[
						`${LIME}◈ patchnet${RESET} ${limeDim("CRT terminal")}`,
						`${limeDim("Status:")} ${crtEnabled ? lime("enabled") : limeMuted("disabled")}`,
						`${limeDim("Theme:")} ${lime("patchnet")}`,
						`${limeDim("Turns:")} ${lime(String(turnCount))}`,
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(
				`${limeDim("Usage:")} /patchnet ${limeMuted("[on|off|status]")}`,
				"warning",
			);
		},
	});
}
