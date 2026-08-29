import { truncateToWidth } from "@mariozechner/pi-tui";

export const TALK_DOCK_KEY = "continuous-talk";
export const VOICE_DOCK_KEY = "voice";

const TALK_MODE_HIGHLIGHT = "\x1b[0;1;38;2;0;0;0;48;2;255;0;255m";
const ANSI_RESET = "\x1b[0m";

export interface DockTheme {
	fg?(role: string, text: string): string;
}

interface DockWidget {
	invalidate(): void;
	render(width: number): string[];
}

interface DockTui {
	requestRender(): void;
}

type DockWidgetFactory = (tui: DockTui, theme: DockTheme) => DockWidget;

interface DockUi {
	setStatus(key: string, value: string | undefined): void;
	setWidget(key: string, content: DockWidgetFactory | undefined, options?: { placement: "belowEditor" }): void;
}

export interface DockStatusContext {
	hasUI?: boolean;
	mode?: string;
	ui?: DockUi;
}

export interface DockStatusOptions {
	visible: boolean;
	fallbackText: string;
}

/** Return whether a Pi context exposes an interactive TUI widget surface. */
export function isTuiContext(context: DockStatusContext | undefined): boolean {
	return Boolean(
		context?.hasUI
		&& context.ui
		// Older Pi releases did not expose mode on interactive contexts.
		&& (context.mode === undefined || context.mode === "tui"),
	);
}

function applyDim(theme: DockTheme, text: string): string {
	return theme.fg?.("dim", text) ?? text;
}

/** Format Talk's non-TUI status fallback without relying on a theme object. */
export function formatTalkStatus(
	phase: string,
	outputEnabled: boolean,
	inputEnabled: boolean,
): string {
	const text = `talk: on | phase: ${phase.toLowerCase()} | output: ${outputEnabled ? "on" : "off"} | input: ${inputEnabled ? "on" : "off"}`;
	return `${TALK_MODE_HIGHLIGHT}${text}${ANSI_RESET}`;
}

/** Format Talk's complete one-line TUI state with its magenta marker. */
export function formatTalkWidgetLine(
	phase: string,
	outputEnabled: boolean,
	inputEnabled: boolean,
	width: number,
): string {
	return truncateToWidth(
		formatTalkStatus(phase, outputEnabled, inputEnabled),
		Math.max(0, Math.floor(width)),
		"",
	);
}

export type VoiceDockState = "idle" | "warmup" | "recording" | "finalizing";
export type VoiceTranscriptionMode = "setup" | "local" | "streaming";

export interface VoiceDockStatus {
	state: VoiceDockState;
	transcription: VoiceTranscriptionMode;
	recordingSeconds: number;
	meter: string;
}

/**
 * Keep the status words useful in every backend: setup and streaming remain
 * explicit while local idle/transcription stays concise for ordinary dictation.
 */
export function formatVoiceStatus(status: VoiceDockStatus): string {
	switch (status.state) {
		case "idle":
			return status.transcription === "setup"
				? "voice input: setup | transcription: setup"
				: `voice input: ready | transcription: ${status.transcription}`;
		case "warmup":
			return "voice input: warming up";
		case "recording":
			return `voice input: recording | ${Math.max(0, Math.floor(status.recordingSeconds))}s | ${status.meter}`;
		case "finalizing":
			return "voice input: transcribing";
	}
}

/** Format voice input's one-line TUI row in the active theme's dim color. */
export function formatVoiceWidgetLine(status: VoiceDockStatus, width: number, theme: DockTheme): string {
	return truncateToWidth(
		applyDim(theme, formatVoiceStatus(status)),
		Math.max(0, Math.floor(width)),
		"",
	);
}

/**
 * Mount one stable below-editor widget for a feature and only request renders
 * thereafter. Pi joins every setStatus value into one footer line, so setStatus
 * remains only the RPC/non-TUI fallback where Pi cannot host a widget.
 *
 * The managed Pi configuration pins this package and combines these Talk and
 * voice rows with locally owned session, role, persona, supervisor, and Relay
 * rows. Coordinate presentation-contract changes with that configuration and
 * its package pin; Relay's distinct cyan highlighted row belongs to its owning
 * package.
 */
export class PersistentDockStatus {
	private widgetUi: DockUi | undefined;
	private statusUi: DockUi | undefined;
	private requestRender: (() => void) | undefined;

	constructor(
		private readonly key: string,
		private readonly renderLine: (width: number, theme: DockTheme) => string,
	) {}

	refresh(context: DockStatusContext | undefined, options: DockStatusOptions): void {
		const ui = context?.ui;
		if (!options.visible) {
			this.clear();
			return;
		}
		if (!ui) return;

		if (!isTuiContext(context)) {
			this.clearWidget();
			if (this.statusUi && this.statusUi !== ui) this.statusUi.setStatus(this.key, undefined);
			ui.setStatus(this.key, options.fallbackText);
			this.statusUi = ui;
			return;
		}

		this.clearStatus();
		if (this.widgetUi && this.widgetUi !== ui) this.clearWidget();
		if (!this.widgetUi) {
			ui.setWidget(
				this.key,
				(tui, theme) => {
					this.requestRender = () => tui.requestRender();
					return {
						invalidate() {},
						render: (width: number): string[] => [this.renderLine(width, theme)],
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetUi = ui;
			return;
		}
		this.requestRender?.();
	}

	clear(): void {
		this.clearWidget();
		this.clearStatus();
	}

	private clearWidget(): void {
		if (!this.widgetUi) return;
		this.widgetUi.setWidget(this.key, undefined);
		this.widgetUi = undefined;
		this.requestRender = undefined;
	}

	private clearStatus(): void {
		if (!this.statusUi) return;
		this.statusUi.setStatus(this.key, undefined);
		this.statusUi = undefined;
	}
}
