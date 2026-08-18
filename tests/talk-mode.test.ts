import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DEFAULT_CONFIG, type VoiceConfig } from "../extensions/voice/config";
import type { TalkAudioRoute } from "../extensions/voice/pipewire-aec";
import { createTalkMode, TALK_SYSTEM_PROMPT, type TalkCapture, type TalkModeDependencies } from "../extensions/voice/talk-mode";

class FakeCaptureProcess extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	killedWith: NodeJS.Signals | undefined;
	exitCode: number | null = null;

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killedWith = signal;
		this.exitCode = signal === "SIGKILL" ? 137 : 0;
		this.emit("exit", this.exitCode, signal);
		return true;
	}
}

class MockPi {
	readonly originalModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
	readonly talkModel = { provider: "openai-codex", id: "gpt-5.6-terra" };
	model: any = this.originalModel;
	thinkingLevel = "xhigh";
	activeTools = ["read", "grep", "find", "ls", "bash", "write"];
	allTools = this.activeTools.map((name) => ({ name }));
	sentMessages: Array<{ text: string; options: any }> = [];
	modelChanges: string[] = [];
	registerTalkModel = true;
	restoreFailures = 0;

	getThinkingLevel(): string { return this.thinkingLevel; }
	setThinkingLevel(level: string): void { this.thinkingLevel = level; }
	getActiveTools(): string[] { return [...this.activeTools]; }
	setActiveTools(tools: string[]): void { this.activeTools = [...tools]; }
	getAllTools(): Array<{ name: string }> { return [...this.allTools]; }
	async setModel(model: any): Promise<boolean> {
		if (model === this.originalModel && this.restoreFailures > 0) {
			this.restoreFailures -= 1;
			return false;
		}
		this.model = model;
		this.thinkingLevel = "off";
		this.modelChanges.push(`${model.provider}/${model.id}`);
		return true;
	}
	sendUserMessage(text: string, options: any): void {
		this.sentMessages.push({ text, options });
	}
}

function makeConfig(): VoiceConfig {
	const config = structuredClone(DEFAULT_CONFIG);
	config.backend = "local";
	config.localModel = "parakeet-v3";
	config.ttsBackend = "local";
	config.ttsLocalModel = "kokoro-en-v0_19";
	config.talk.modelProvider = "openai-codex";
	config.talk.modelId = "gpt-5.6-terra";
	config.talk.thinkingLevel = "low";
	config.talk.vad.hangoverMs = 300;
	return config;
}

function makeContext(pi: MockPi) {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	let abortCount = 0;
	return {
		hasUI: true,
		cwd: "/tmp/project",
		get model() { return pi.model; },
		modelRegistry: {
			find(provider: string, id: string) {
				return pi.registerTalkModel && provider === pi.talkModel.provider && id === pi.talkModel.id
					? pi.talkModel
					: undefined;
			},
		},
		isIdle: () => true,
		abort: () => { abortCount += 1; },
		waitForIdle: async () => {},
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
		},
		notifications,
		statuses,
		get abortCount() { return abortCount; },
	};
}

function toneFrame(amplitude = 8_000): Buffer {
	const frame = Buffer.alloc(1_024);
	for (let index = 0; index < 512; index++) {
		frame.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * index) / 16_000) * amplitude), index * 2);
	}
	return frame;
}

function utteranceAudio(): Buffer {
	return Buffer.concat([
		...Array.from({ length: 16 }, () => toneFrame()),
		...Array.from({ length: 12 }, () => Buffer.alloc(1_024)),
	]);
}

function feedInOddChunks(capture: FakeCaptureProcess, audio: Buffer): void {
	const widths = [137, 2_111, 509, 4_003, 997];
	let offset = 0;
	let index = 0;
	while (offset < audio.length) {
		const end = Math.min(audio.length, offset + widths[index % widths.length]!);
		capture.stdout.write(audio.subarray(offset, end));
		offset = end;
		index += 1;
	}
}

function makeHarness(options: Partial<TalkModeDependencies> = {}) {
	const pi = new MockPi();
	const config = makeConfig();
	const captures: FakeCaptureProcess[] = [];
	const captureRoutes: Array<TalkAudioRoute | undefined> = [];
	const spoken: string[] = [];
	const dependencies: TalkModeDependencies = {
		getConfig: () => config,
		spawnCapture: (audioRoute) => {
			captureRoutes.push(audioRoute);
			const process = new FakeCaptureProcess();
			captures.push(process);
			return { process, tool: "fake" } as unknown as TalkCapture;
		},
		prepare: async () => {},
		transcribe: async () => "hello from the local microphone",
		speak: async (text) => { spoken.push(text); },
		...options,
	};
	const context = makeContext(pi);
	const mode = createTalkMode(pi as any, dependencies);
	return { pi, config, captures, captureRoutes, spoken, context, mode };
}

describe("continuous talk mode", () => {
	test("runs a local hands-free turn and restores the exact Pi state", async () => {
		const { pi, captures, spoken, context, mode } = makeHarness();
		const originalTools = [...pi.activeTools];

		expect(await mode.enable(context as any)).toBe(true);
		expect(pi.model).toBe(pi.talkModel);
		expect(pi.thinkingLevel).toBe("low");
		expect(pi.activeTools).toEqual(["read", "grep", "find", "ls"]);
		expect(mode.getPhase()).toBe("listening");
		expect(captures).toHaveLength(1);

		feedInOddChunks(captures[0]!, utteranceAudio());
		await Bun.sleep(10);
		expect(captures[0]!.killedWith).toBe("SIGKILL");
		expect(pi.sentMessages).toEqual([
			{ text: "hello from the local microphone", options: { deliverAs: "steer" } },
		]);

		const systemPrompt = await mode.beginAgentRun("base prompt", context as any);
		expect(systemPrompt).toContain(TALK_SYSTEM_PROMPT);
		expect(captures).toHaveLength(2);
		expect(captures[1]!.killedWith).toBeUndefined();
		expect(mode.getPhase()).toBe("listening");
		mode.handleMessageUpdate({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "First spoken sentence. Trailing" }] },
		});
		mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "First spoken sentence. Trailing words." }] },
		});
		await mode.handleAgentSettled();

		expect(spoken.join(" ")).toContain("First spoken sentence");
		expect(spoken.join(" ")).toContain("Trailing words");
		expect(captures[1]!.killedWith).toBe("SIGKILL");
		expect(captures).toHaveLength(3);
		expect(mode.getPhase()).toBe("listening");

		expect(await mode.disable(context as any)).toBe(true);
		expect(pi.model).toBe(pi.originalModel);
		expect(pi.thinkingLevel).toBe("xhigh");
		expect(pi.activeTools).toEqual(originalTools);
		expect(captures[2]!.killedWith).toBe("SIGKILL");
		expect(mode.getPhase()).toBe("off");
	});

	test("does not shape or speak a run that began before talk mode", async () => {
		const { context, mode, spoken } = makeHarness();
		expect(await mode.beginAgentRun("normal", context as any)).toBeUndefined();
		await mode.enable(context as any);

		mode.handleMessageEnd({
			message: { id: "old", role: "assistant", content: [{ type: "text", text: "This old response must stay silent." }] },
		});
		await Bun.sleep(5);
		expect(spoken).toEqual([]);
		await mode.disable(context as any, { notify: false });
	});

	test("speaks assistant messages only", async () => {
		const { context, mode, spoken } = makeHarness();
		await mode.enable(context as any);
		await mode.beginAgentRun("base", context as any);
		mode.handleMessageEnd({
			message: { id: "user", role: "user", content: [{ type: "text", text: "Do not repeat my transcript." }] },
		});
		mode.handleMessageEnd({
			message: { id: "tool", role: "toolResult", content: [{ type: "text", text: "Do not read tool output." }] },
		});
		await Bun.sleep(5);
		expect(spoken).toEqual([]);
		await mode.disable(context as any, { notify: false });
	});

	test("tracks separate assistant messages by timestamp when no id is present", async () => {
		const { context, mode, spoken } = makeHarness();
		await mode.enable(context as any);
		await mode.beginAgentRun("base", context as any);
		mode.handleMessageEnd({
			message: { timestamp: 100, role: "assistant", content: [{ type: "text", text: "Short first response." }] },
		});
		mode.handleMessageEnd({
			message: { timestamp: 200, role: "assistant", content: [{ type: "text", text: "A separate and substantially longer second response." }] },
		});
		await mode.handleAgentSettled();
		expect(spoken.join(" ")).toContain("Short first response");
		expect(spoken.join(" ")).toContain("A separate and substantially longer second response");
		await mode.disable(context as any, { notify: false });
	});

	test("rolls back when the configured Terra model is unavailable", async () => {
		const { pi, captures, context, mode } = makeHarness();
		pi.registerTalkModel = false;
		const originalTools = [...pi.activeTools];

		expect(await mode.enable(context as any)).toBe(false);
		expect(pi.model).toBe(pi.originalModel);
		expect(pi.thinkingLevel).toBe("xhigh");
		expect(pi.activeTools).toEqual(originalTools);
		expect(captures).toHaveLength(0);
		expect(mode.getPhase()).toBe("off");
	});

	test("retains the previous model snapshot until restoration succeeds", async () => {
		const { pi, context, mode } = makeHarness();
		await mode.enable(context as any);
		pi.restoreFailures = 1;

		await mode.disable(context as any, { notify: false });
		expect(pi.model).toBe(pi.talkModel);
		expect(mode._state.snapshotTaken).toBe(true);

		await mode.disable(context as any, { notify: false });
		expect(pi.model).toBe(pi.originalModel);
		expect(pi.thinkingLevel).toBe("xhigh");
		expect(mode._state.snapshotTaken).toBe(false);
	});

	test("talk off aborts pending local speech and prevents microphone restart", async () => {
		let speechAborted = false;
		const harness = makeHarness({
			speak: async (_text, _config, _ctx, signal) => new Promise<void>((resolve, reject) => {
				const abort = () => {
					speechAborted = true;
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				};
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}),
		});
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "A response that is still speaking." }] },
		});
		await Bun.sleep(5);
		await harness.mode.disable(harness.context as any, { notify: false });

		expect(speechAborted).toBe(true);
		expect(harness.captures).toHaveLength(1);
		expect(harness.mode.getPhase()).toBe("off");
	});

	test("headphone barge-in aborts speech and the active model run", async () => {
		let speechAborted = false;
		const harness = makeHarness({
			speak: async (_text, _config, _ctx, signal) => new Promise<void>((_resolve, reject) => {
				const abort = () => {
					speechAborted = true;
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				};
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}),
		});
		harness.config.talk.bargeIn.mode = "headphones";

		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleTurnStart(harness.context as any);
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "This answer should be interrupted." }] },
		});
		await Bun.sleep(5);

		expect(harness.captures[0]!.killedWith).toBeUndefined();
		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);

		expect(speechAborted).toBe(true);
		expect(harness.context.abortCount).toBe(1);
		expect(harness.pi.sentMessages).toEqual([
			{ text: "hello from the local microphone", options: { deliverAs: "steer" } },
		]);
		expect(harness.captures[0]!.killedWith).toBe("SIGKILL");
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("headphone barge-in does not abort audio too short for transcription", async () => {
		const harness = makeHarness();
		harness.config.talk.bargeIn.mode = "headphones";
		harness.config.talk.bargeIn.minSpeechMs = 100;
		harness.config.talk.vad.minSpeechMs = 300;
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		feedInOddChunks(harness.captures[0]!, Buffer.concat([
			...Array.from({ length: 8 }, () => toneFrame()),
			...Array.from({ length: 12 }, () => Buffer.alloc(1_024)),
		]));
		await Bun.sleep(10);

		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([]);
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("PipeWire AEC keeps its routed microphone open through speech", async () => {
		let closeCount = 0;
		const route: TalkAudioRoute = {
			mode: "pipewire-aec",
			echoCancelled: true,
			captureSource: "talk_aec_source",
			playbackSink: "talk_aec_sink",
			close: async () => { closeCount += 1; },
		};
		const harness = makeHarness({ prepareAudio: async () => route });
		harness.config.talk.bargeIn.mode = "pipewire-aec";
		harness.config.talk.bargeIn.guardMs = 0;

		await harness.mode.enable(harness.context as any);
		expect(harness.captureRoutes).toEqual([route]);
		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "AEC-routed response." }] },
		});
		await harness.mode.handleAgentSettled();

		expect(harness.captures[0]!.killedWith).toBeUndefined();
		expect(harness.mode.statusLines()).toContain("barge-in: pipewire-aec");
		await harness.mode.disable(harness.context as any, { notify: false });
		expect(closeCount).toBe(1);
	});

	test("PipeWire AEC failure falls back to speaker-safe playback", async () => {
		const harness = makeHarness({
			prepareAudio: async () => { throw new Error("echo module missing"); },
		});
		harness.config.talk.bargeIn.mode = "pipewire-aec";

		expect(await harness.mode.enable(harness.context as any)).toBe(true);
		expect(harness.mode.statusLines()).toContain("barge-in: off (PipeWire fallback)");
		expect(harness.context.notifications.some(({ message }) => message.includes("speaker-safe playback"))).toBe(true);
		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "Fallback response." }] },
		});
		await harness.mode.handleAgentSettled();

		expect(harness.captures[0]!.killedWith).toBe("SIGKILL");
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("retries PipeWire route cleanup after talk mode stops", async () => {
		let closeCount = 0;
		const route: TalkAudioRoute = {
			mode: "pipewire-aec",
			echoCancelled: true,
			captureSource: "talk_aec_source",
			playbackSink: "talk_aec_sink",
			close: async () => {
				closeCount += 1;
				if (closeCount === 1) throw new Error("temporary unload failure");
			},
		};
		const harness = makeHarness({ prepareAudio: async () => route });
		harness.config.talk.bargeIn.mode = "pipewire-aec";
		await harness.mode.enable(harness.context as any);

		await harness.mode.disable(harness.context as any, { notify: false });
		expect(harness.mode._state.audioRoute).toBe(route);
		await harness.mode.disable(harness.context as any, { notify: false });
		expect(harness.mode._state.audioRoute).toBeUndefined();
		expect(closeCount).toBe(2);
	});

	test("does not fall back while partial PipeWire setup still needs cleanup", async () => {
		let closeCount = 0;
		const route: TalkAudioRoute = {
			mode: "pipewire-aec",
			echoCancelled: true,
			captureSource: "partial_aec_source",
			playbackSink: "partial_aec_sink",
			close: async () => {
				closeCount += 1;
				if (closeCount <= 2) throw new Error("persistent unload failure");
			},
		};
		const setupError = Object.assign(new Error("partial setup failed"), { cleanupRoute: route });
		const harness = makeHarness({ prepareAudio: async () => { throw setupError; } });
		harness.config.talk.bargeIn.mode = "pipewire-aec";

		expect(await harness.mode.enable(harness.context as any)).toBe(false);
		expect(harness.captures).toHaveLength(0);
		expect(harness.mode._state.audioRoute).toBe(route);
		await harness.mode.disable(harness.context as any, { notify: false });
		expect(harness.mode._state.audioRoute).toBeUndefined();
		expect(closeCount).toBe(3);
	});
});
