import { describe, expect, test } from "bun:test";
import {
	formatTalkStatus,
	formatTalkWidgetLine,
	formatVoiceStatus,
	formatVoiceWidgetLine,
	PersistentDockStatus,
	type DockStatusContext,
} from "../extensions/voice/dock-status";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function dimTheme() {
	return {
		fg(role: string, text: string): string {
			return role === "dim" ? `\x1b[2m${text}\x1b[22m` : text;
		},
	};
}

function makeContext(mode: "tui" | "rpc") {
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const widgets: Array<{ key: string; content: any; options: any }> = [];
	let renderRequests = 0;
	const context: DockStatusContext = {
		hasUI: true,
		mode,
		ui: {
			setStatus(key, value) { statuses.push({ key, value }); },
			setWidget(key, content, options) { widgets.push({ key, content, options }); },
		},
	};
	return {
		context,
		statuses,
		widgets,
		createWidget() {
			const factory = widgets.at(-1)?.content;
			return factory?.({ requestRender: () => { renderRequests += 1; } }, dimTheme());
		},
		get renderRequests() { return renderRequests; },
	};
}

describe("bottom-dock status formatting", () => {
	test("formats Talk in lowercase key-value text and highlights the complete row", () => {
		const line = formatTalkWidgetLine("standby", false, false, 120);
		expect(stripAnsi(line)).toBe("talk: on | phase: standby | output: off | input: off");
		expect(line).toBe(
			"\x1b[0;1;38;2;0;0;0;48;2;255;0;255mtalk: on | phase: standby | output: off | input: off\x1b[0m",
		);
		expect(stripAnsi(formatTalkStatus("LISTENING", true, true))).toBe(
			"talk: on | phase: listening | output: on | input: on",
		);
		const narrowLine = formatTalkWidgetLine("standby", false, false, 20);
		expect(stripAnsi(narrowLine).length).toBeLessThanOrEqual(20);
		expect(narrowLine).toEndWith("\x1b[0m");
	});

	test("formats voice setup, local, streaming, and transition states", () => {
		expect(formatVoiceStatus({ state: "idle", transcription: "setup", recordingSeconds: 0, meter: "" }))
			.toBe("voice input: setup | transcription: setup");
		expect(formatVoiceStatus({ state: "idle", transcription: "local", recordingSeconds: 0, meter: "" }))
			.toBe("voice input: ready | transcription: local");
		expect(formatVoiceStatus({ state: "idle", transcription: "streaming", recordingSeconds: 0, meter: "" }))
			.toBe("voice input: ready | transcription: streaming");
		expect(formatVoiceStatus({ state: "warmup", transcription: "local", recordingSeconds: 0, meter: "" }))
			.toBe("voice input: warming up");
		expect(formatVoiceStatus({ state: "recording", transcription: "local", recordingSeconds: 2.8, meter: "██░░" }))
			.toBe("voice input: recording | 2s | ██░░");
		expect(formatVoiceStatus({ state: "finalizing", transcription: "local", recordingSeconds: 2, meter: "" }))
			.toBe("voice input: transcribing");
		expect(formatVoiceStatus({ state: "idle", transcription: "local", recordingSeconds: 0, meter: "" }))
			.toBe("voice input: ready | transcription: local");
	});

	test("styles the full voice row dim and truncates it safely", () => {
		const status = { state: "recording" as const, transcription: "local" as const, recordingSeconds: 2, meter: "██░░" };
		const line = formatVoiceWidgetLine(status, 120, dimTheme());
		expect(line).toBe("\x1b[2mvoice input: recording | 2s | ██░░\x1b[22m");
		const narrowLine = formatVoiceWidgetLine(status, 16, dimTheme());
		expect(stripAnsi(narrowLine).length).toBeLessThanOrEqual(16);
		expect(narrowLine).toEndWith("\x1b[0m");
	});
});

describe("PersistentDockStatus", () => {
	test("mounts a TUI row once, rerenders changed state in place, then clears it", () => {
		let state = "voice input: ready | transcription: local";
		const dockStatus = new PersistentDockStatus("voice", (width) => state.slice(0, width));
		const harness = makeContext("tui");

		dockStatus.refresh(harness.context, { visible: true, fallbackText: state });
		expect(harness.statuses).toEqual([]);
		expect(harness.widgets).toEqual([{ key: "voice", content: expect.any(Function), options: { placement: "belowEditor" } }]);
		const widget = harness.createWidget();
		expect(widget.render(80)).toEqual([state]);

		state = "voice input: recording | 2s | ██░░";
		dockStatus.refresh(harness.context, { visible: true, fallbackText: state });
		expect(harness.widgets).toHaveLength(1);
		expect(harness.renderRequests).toBe(1);
		expect(widget.render(80)).toEqual([state]);

		dockStatus.refresh(harness.context, { visible: false, fallbackText: state });
		expect(harness.widgets.at(-1)).toEqual({ key: "voice", content: undefined, options: undefined });
	});

	test("uses setStatus only in RPC mode and switches cleanly into a TUI widget", () => {
		let state = "talk: on | phase: standby | output: off | input: off";
		const dockStatus = new PersistentDockStatus("continuous-talk", () => state);
		const rpc = makeContext("rpc");

		dockStatus.refresh(rpc.context, { visible: true, fallbackText: state });
		expect(rpc.widgets).toEqual([]);
		expect(rpc.statuses).toEqual([{ key: "continuous-talk", value: state }]);

		const tui = makeContext("tui");
		state = "talk: on | phase: listening | output: on | input: on";
		dockStatus.refresh(tui.context, { visible: true, fallbackText: state });
		expect(rpc.statuses.at(-1)).toEqual({ key: "continuous-talk", value: undefined });
		expect(tui.widgets).toEqual([{ key: "continuous-talk", content: expect.any(Function), options: { placement: "belowEditor" } }]);
	});
});
