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
	entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
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
	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ type: "custom", customType, data });
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
	const footerUpdates: any[] = [];
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
		sessionManager: {
			getEntries: () => pi.entries,
		},
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
			setFooter(factory: any) { footerUpdates.push(factory); },
		},
		notifications,
		statuses,
		footerUpdates,
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

function createToneSpeechDetector() {
	return {
		frameBytes: 1_024,
		pushFrame(frame: Buffer): boolean {
			for (let offset = 0; offset < frame.length; offset += 2) {
				if (Math.abs(frame.readInt16LE(offset)) >= 1_000) return true;
			}
			return false;
		},
		reset() {},
	};
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
		createSpeechDetector: createToneSpeechDetector,
		transcribe: async () => "hello from the local microphone",
		speak: async (text) => { spoken.push(text); },
		...options,
	};
	const context = makeContext(pi);
	const mode = createTalkMode(pi as any, dependencies);
	return { pi, config, captures, captureRoutes, spoken, context, mode };
}

describe("continuous talk mode", () => {
	test("uses a soft short-response default that explicit detail requests override", () => {
		expect(TALK_SYSTEM_PROMPT).toContain("aim for about three or four sentences");
		expect(TALK_SYSTEM_PROMPT).toContain("This is not a hard limit");
		expect(TALK_SYSTEM_PROMPT).toContain("explicitly asks for a longer, detailed, or step-by-step answer");
	});

	test("distinguishes read-only inspection from blocked shell access", () => {
		expect(TALK_SYSTEM_PROMPT).toContain("read and search local files and configuration");
		expect(TALK_SYSTEM_PROMPT).toContain("additional bounded read-only inspectors");
		expect(TALK_SYSTEM_PROMPT).toContain("Arbitrary shell commands remain unavailable");
	});

	test("renders talk mode as a full-width neon-magenta footer", async () => {
		const { context, mode } = makeHarness();

		expect(await mode.enable(context as any)).toBe(true);
		const activeStatus = context.statuses.get("continuous-talk");
		expect(activeStatus).toStartWith("\x1b[0;1;38;2;0;0;0;48;2;255;0;255m");
		expect(activeStatus).toContain("TALK MODE ON | LISTENING | INPUT ON | OUTPUT ON");
		expect(activeStatus).toEndWith("\x1b[0m");

		const footerFactory = context.footerUpdates.find((update) => typeof update === "function");
		const footer = footerFactory({}, {}, {});
		const footerLine = footer.render(72)[0];
		const plainFooterLine = footerLine.replace(/\x1b\[[0-9;]*m/g, "");
		expect(footerLine).toStartWith("\x1b[0;1;38;2;0;0;0;48;2;255;0;255m");
		expect(footerLine).toEndWith("\x1b[0m");
		expect(plainFooterLine).toHaveLength(72);
		expect(plainFooterLine.trim()).toBe("TALK MODE ON | LISTENING | INPUT ON | OUTPUT ON");
		expect(context.footerUpdates).toHaveLength(1);

		mode.handleInput(context as any);
		const thinkingLine = footer.render(72)[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(thinkingLine.trim()).toBe("TALK MODE ON | THINKING | INPUT ON | OUTPUT ON");
		expect(context.footerUpdates).toHaveLength(1);

		await mode.disable(context as any, { notify: false });
		expect(context.statuses.get("continuous-talk")).toBeUndefined();
		expect(context.footerUpdates.at(-1)).toBeUndefined();
	});

	test("controls continuous input and spoken output independently", async () => {
		const harness = makeHarness();

		expect(await harness.mode.enable(harness.context as any, {
			inputEnabled: false,
			outputEnabled: false,
			notify: false,
		})).toBe(true);
		expect(harness.mode.getPhase()).toBe("standby");
		expect(harness.mode.isInputEnabled()).toBe(false);
		expect(harness.mode.isOutputEnabled()).toBe(false);
		expect(harness.captures).toEqual([]);

		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleMessageEnd({
			message: {
				id: "silent-answer",
				role: "assistant",
				content: [{ type: "text", text: "This response stays silent." }],
			},
		});
		await harness.mode.handleAgentSettled();
		expect(harness.spoken).toEqual([]);
		expect(harness.mode.getPhase()).toBe("standby");

		expect(harness.mode.setOutputEnabled(true, harness.context as any, {
			notify: false,
		})).toBe(true);
		harness.mode.handleTurnStart(harness.context as any);
		harness.mode.handleMessageEnd({
			message: {
				id: "spoken-answer",
				role: "assistant",
				content: [{ type: "text", text: "This response is spoken." }],
			},
		});
		await harness.mode.handleAgentSettled();
		expect(harness.spoken).toEqual(["This response is spoken."]);
		expect(harness.captures).toEqual([]);

		expect(harness.mode.setInputEnabled(true, harness.context as any, {
			notify: false,
		})).toBe(true);
		expect(harness.mode.getPhase()).toBe("listening");
		expect(harness.captures).toHaveLength(1);
		expect(harness.mode.setInputEnabled(false, harness.context as any, {
			notify: false,
		})).toBe(true);
		expect(harness.captures[0]!.killedWith).toBe("SIGKILL");
		expect(harness.mode.getPhase()).toBe("standby");
		expect(harness.mode.statusLines()).toContain("input: off");
		expect(harness.mode.statusLines()).toContain("output: on");

		await harness.mode.disable(harness.context as any, { notify: false });
	});

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

	test("drains shared playback once after every streamed fragment is heard", async () => {
		let finishCount = 0;
		let queuedCount = 0;
		const harness = makeHarness({
			speak: async (_text, _config, _ctx, _signal, _audioRoute, onPlaybackStart) => {
				queuedCount += 1;
				onPlaybackStart?.();
				return { audioDurationMs: 2, playbackPending: true };
			},
			finishSpeech: async () => { finishCount += 1; },
		});
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		harness.mode.handleMessageUpdate({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "First sentence. Trailing" }] },
		});
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "First sentence. Trailing words." }] },
		});
		await harness.mode.handleAgentSettled();

		expect(queuedCount).toBe(2);
		expect(finishCount).toBe(1);
		expect(harness.mode._state.messageStreams.get("id:answer")?.completedLength)
			.toBe("First sentence. Trailing words.".length);
		expect(harness.mode.getPhase()).toBe("listening");
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("allows exact read-only tools selected by a trusted integration", async () => {
		const harness = makeHarness({
			getAdditionalAllowedTools: () => ["pi_supervisor", "unknown_tool"],
		});
		harness.pi.allTools.push({ name: "pi_supervisor" });

		expect(await harness.mode.enable(harness.context as any)).toBe(true);
		expect(harness.pi.activeTools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"pi_supervisor",
		]);
		expect(
			harness.mode.handleToolCall({ toolName: "pi_supervisor" }),
		).toBeUndefined();
		expect(harness.mode.handleToolCall({ toolName: "bash" })).toEqual({
			block: true,
			reason: "Talk mode is read-only; tool 'bash' is unavailable until /talk off.",
		});

		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("returns to listening when headphone capture survives spoken output", async () => {
		const harness = makeHarness();
		harness.config.talk.bargeIn.mode = "headphones";
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleMessageEnd({
			message: {
				id: "headphone-answer",
				role: "assistant",
				content: [{ type: "text", text: "A selected Relay update." }],
			},
		});
		await harness.mode.handleAgentSettled();

		expect(harness.captures).toHaveLength(1);
		expect(harness.captures[0]!.killedWith).toBeUndefined();
		expect(harness.mode.getPhase()).toBe("listening");
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("speaks custom continuations that skip before_agent_start", async () => {
		const harness = makeHarness();
		await harness.mode.enable(harness.context as any);

		harness.mode.handleTurnStart(harness.context as any);
		const firstRunId = harness.mode._state.currentRun?.id;
		harness.mode.handleMessageEnd({
			message: {
				id: "first-continuation",
				role: "assistant",
				content: [{ type: "text", text: "The first autonomous update is spoken." }],
			},
		});
		await harness.mode.handleAgentSettled();

		expect(harness.spoken).toEqual(["The first autonomous update is spoken."]);
		expect(harness.mode._state.currentRun?.acceptingEvents).toBe(false);
		expect(harness.mode.suppressesGeneralSpeech()).toBe(true);

		harness.mode.handleTurnStart(harness.context as any);
		expect(harness.mode._state.currentRun?.id).toBeGreaterThan(firstRunId ?? 0);
		harness.mode.handleMessageEnd({
			message: {
				id: "second-continuation",
				role: "assistant",
				content: [{ type: "text", text: "The next autonomous update is also spoken." }],
			},
		});
		await harness.mode.handleAgentSettled();

		expect(harness.spoken).toEqual([
			"The first autonomous update is spoken.",
			"The next autonomous update is also spoken.",
		]);
		await harness.mode.disable(harness.context as any, { notify: false });
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

	test("talk off cancels pending local speech and prevents microphone restart", async () => {
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

	test("output off stops playback without disabling talk mode", async () => {
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
		await harness.mode.enable(harness.context as any, {
			inputEnabled: false,
			outputEnabled: true,
			notify: false,
		});
		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleMessageEnd({
			message: {
				id: "answer",
				role: "assistant",
				content: [{ type: "text", text: "Stop this spoken response." }],
			},
		});
		await Bun.sleep(5);

		expect(harness.mode.setOutputEnabled(false, harness.context as any, {
			notify: false,
		})).toBe(true);
		await harness.mode.handleAgentSettled();
		expect(speechAborted).toBe(true);
		expect(harness.mode.isEnabled()).toBe(true);
		expect(harness.mode.getPhase()).toBe("standby");

		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("talk off waits for active model work instead of aborting it", async () => {
		const harness = makeHarness();
		let idle = true;
		let waitForIdleCount = 0;
		(harness.context as any).isIdle = () => idle;
		(harness.context as any).waitForIdle = async () => {
			waitForIdleCount += 1;
			idle = true;
		};

		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);
		idle = false;
		await harness.mode.disable(harness.context as any, { notify: false });

		expect(waitForIdleCount).toBe(1);
		expect(harness.context.abortCount).toBe(0);
		expect(harness.mode.getPhase()).toBe("off");
	});

	test("headphone barge-in requires the configured continuous-speech interval", async () => {
		let speechAborted = false;
		const harness = makeHarness({
			speak: async (_text, _config, _ctx, signal, _audioRoute, onPlaybackStart) => new Promise<void>((_resolve, reject) => {
				onPlaybackStart?.();
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
		harness.config.talk.bargeIn.minSpeechMs = 1_000;

		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleTurnStart(harness.context as any);
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "This answer should be interrupted." }] },
		});
		await Bun.sleep(5);

		expect(harness.captures[0]!.killedWith).toBeUndefined();
		feedInOddChunks(harness.captures[0]!, Buffer.concat([
			...Array.from({ length: 28 }, () => toneFrame()),
			...Array.from({ length: 12 }, () => Buffer.alloc(1_024)),
		]));
		await Bun.sleep(10);
		expect(speechAborted).toBe(false);
		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([]);
		expect(harness.captures[0]!.killedWith).toBeUndefined();
		expect(harness.mode.getPhase()).toBe("speaking");

		feedInOddChunks(harness.captures[0]!, Buffer.concat(
			Array.from({ length: 34 }, () => toneFrame()),
		));
		await Bun.sleep(10);

		expect(speechAborted).toBe(true);
		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([]);

		feedInOddChunks(harness.captures[0]!, Buffer.concat(
			Array.from({ length: 12 }, () => Buffer.alloc(1_024)),
		));
		await Bun.sleep(10);

		expect(harness.pi.sentMessages).toEqual([
			{ text: "hello from the local microphone", options: { deliverAs: "steer" } },
		]);
		expect(harness.captures[0]!.killedWith).toBe("SIGKILL");
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("confirmed thinking speech interrupts when playback starts before its endpoint", async () => {
		let speechAborted = false;
		const route: TalkAudioRoute = {
			mode: "pipewire-aec",
			echoCancelled: true,
			captureSource: "talk_aec_source",
			playbackSink: "talk_aec_sink",
			close: async () => {},
		};
		const harness = makeHarness({
			prepareAudio: async () => route,
			speak: async (_text, _config, _ctx, signal, _audioRoute, onPlaybackStart) => new Promise<void>((_resolve, reject) => {
				onPlaybackStart?.();
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
		harness.config.talk.bargeIn.mode = "pipewire-aec";
		harness.config.talk.bargeIn.guardMs = 0;
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		feedInOddChunks(harness.captures[0]!, Buffer.concat(
			Array.from({ length: 16 }, () => toneFrame()),
		));
		await Bun.sleep(10);
		expect(harness.context.abortCount).toBe(0);

		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "Playback began while the user was speaking." }] },
		});
		await Bun.sleep(10);

		expect(speechAborted).toBe(true);
		expect(harness.context.abortCount).toBe(0);
		expect(harness.captures[0]!.killedWith).toBeUndefined();
		expect(harness.pi.sentMessages).toEqual([]);

		feedInOddChunks(harness.captures[0]!, Buffer.concat(
			Array.from({ length: 12 }, () => Buffer.alloc(1_024)),
		));
		await Bun.sleep(10);

		expect(harness.pi.sentMessages).toEqual([
			{ text: "hello from the local microphone", options: { deliverAs: "steer" } },
		]);
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("thinking barge-in waits for substantive transcription without aborting the model", async () => {
		let resolveTranscription: ((text: string) => void) | undefined;
		const harness = makeHarness({
			transcribe: async () => new Promise<string>((resolve) => {
				resolveTranscription = resolve;
			}),
		});
		harness.config.talk.bargeIn.mode = "headphones";
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);

		expect(resolveTranscription).toBeDefined();
		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([]);

		resolveTranscription?.("Actually, compare it with my current sword.");
		await Bun.sleep(10);

		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([
			{ text: "Actually, compare it with my current sword.", options: { deliverAs: "steer" } },
		]);
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("verified thinking speech bypasses a playback guard that starts during transcription", async () => {
		let resolveTranscription: ((text: string) => void) | undefined;
		let speechAborted = false;
		const route: TalkAudioRoute = {
			mode: "pipewire-aec",
			echoCancelled: true,
			captureSource: "talk_aec_source",
			playbackSink: "talk_aec_sink",
			close: async () => {},
		};
		const harness = makeHarness({
			prepareAudio: async () => route,
			transcribe: async () => new Promise<string>((resolve) => {
				resolveTranscription = resolve;
			}),
			speak: async (_text, _config, _ctx, signal, _audioRoute, onPlaybackStart) => new Promise<void>((_resolve, reject) => {
				onPlaybackStart?.();
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
		harness.config.talk.bargeIn.mode = "pipewire-aec";
		harness.config.talk.bargeIn.guardMs = 10_000;
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);
		expect(resolveTranscription).toBeDefined();
		expect(harness.context.abortCount).toBe(0);

		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "Playback started during local transcription." }] },
		});
		await Bun.sleep(10);
		expect(speechAborted).toBe(false);

		resolveTranscription?.("Actually, answer a different question.");
		await Bun.sleep(10);

		expect(speechAborted).toBe(true);
		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([
			{ text: "Actually, answer a different question.", options: { deliverAs: "steer" } },
		]);
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("thinking barge-in ignores conversational backchannels", async () => {
		const route: TalkAudioRoute = {
			mode: "pipewire-aec",
			echoCancelled: true,
			captureSource: "talk_aec_source",
			playbackSink: "talk_aec_sink",
			close: async () => {},
		};
		const harness = makeHarness({
			prepareAudio: async () => route,
			transcribe: async () => "Mm-hmm.",
		});
		harness.config.talk.bargeIn.mode = "pipewire-aec";
		harness.config.talk.bargeIn.guardMs = 0;
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);

		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([]);
		expect(harness.captures).toHaveLength(2);
		expect(harness.captures[1]!.killedWith).toBeUndefined();
		expect(harness.mode._state.currentRun?.acceptingEvents).toBe(true);
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("thinking barge-in ignores an empty transcription", async () => {
		const harness = makeHarness({ transcribe: async () => "" });
		harness.config.talk.bargeIn.mode = "headphones";
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);

		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([]);
		expect(harness.captures).toHaveLength(2);
		expect(harness.mode._state.currentRun?.acceptingEvents).toBe(true);
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("thinking barge-in keeps the model running when transcription fails", async () => {
		const harness = makeHarness({
			transcribe: async () => { throw new Error("unintelligible audio"); },
		});
		harness.config.talk.bargeIn.mode = "headphones";
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);

		expect(harness.context.abortCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([]);
		expect(harness.captures).toHaveLength(2);
		expect(harness.context.notifications.some(({ message }) => message.includes("unintelligible audio"))).toBe(true);
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("headphone barge-in does not cancel TTS for audio too short for transcription", async () => {
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

	test("neural VAD rejects energetic non-speech before interruption and STT", async () => {
		let speechCancelled = false;
		let transcriptionCount = 0;
		const harness = makeHarness({
			createSpeechDetector: () => ({
				frameBytes: 1_024,
				pushFrame: () => false,
				reset() {},
			}),
			transcribe: async () => {
				transcriptionCount += 1;
				return "invented speech";
			},
			speak: async (_text, _config, _ctx, signal, _audioRoute, onPlaybackStart) => new Promise<void>((_resolve, reject) => {
				onPlaybackStart?.();
				const cancel = () => {
					speechCancelled = true;
					const error = new Error("cancelled");
					error.name = "AbortError";
					reject(error);
				};
				if (signal.aborted) cancel();
				else signal.addEventListener("abort", cancel, { once: true });
			}),
		});
		harness.config.talk.bargeIn.mode = "headphones";
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "Keep speaking through non-speech noise." }] },
		});
		await Bun.sleep(5);

		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);

		expect(speechCancelled).toBe(false);
		expect(transcriptionCount).toBe(0);
		expect(harness.pi.sentMessages).toEqual([]);
		expect(harness.mode._state.currentRun?.acceptingEvents).toBe(true);
		expect(harness.mode.getPhase()).toBe("speaking");
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

	test("interrupted context retains only completed speech", async () => {
		let speechCall = 0;
		const harness = makeHarness({
			speak: async (_text, _config, _ctx, signal) => {
				speechCall += 1;
				if (speechCall === 1) return;
				return new Promise<void>((_resolve, reject) => {
					const abort = () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						reject(error);
					};
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
				});
			},
		});
		harness.config.talk.bargeIn.mode = "headphones";
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		harness.mode.handleMessageUpdate({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "Heard sentence. Unheard" }] },
		});
		await Bun.sleep(5);
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "Heard sentence. Unheard sentence." }] },
		});
		await Bun.sleep(5);
		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);

		const result = harness.mode.handleContext({
			messages: [
				{ id: "answer", role: "assistant", content: [{ type: "text", text: "Heard sentence. Unheard sentence." }] },
			],
		});
		const contextText = result?.messages[0].content
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join(" ");
		expect(contextText).toContain("Heard sentence.");
		expect(contextText).not.toContain("Unheard sentence.");
		expect(contextText).toContain("remainder of the generated response was not heard");
		expect(harness.pi.entries).toHaveLength(1);

		const restored = makeHarness();
		restored.pi.entries.push(...harness.pi.entries);
		restored.mode.restoreInterruptedContext(restored.context as any);
		expect(restored.mode.handleContext({
			messages: [
				{ id: "answer", role: "assistant", content: [{ type: "text", text: "Heard sentence. Unheard sentence." }] },
			],
		})?.messages[0].content.map((block: any) => block.text).join(" ")).not.toContain("Unheard sentence.");

		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("shared playback cancellation retains only elapsed fragments", async () => {
		let speechCall = 0;
		let cancelCount = 0;
		const harness = makeHarness({
			speak: async (_text, _config, _ctx, _signal, _audioRoute, onPlaybackStart) => {
				speechCall += 1;
				onPlaybackStart?.();
				return {
					audioDurationMs: speechCall === 1 ? 1 : 60_000,
					playbackPending: true,
				};
			},
			finishSpeech: async () => {},
			cancelSpeech: () => { cancelCount += 1; },
		});
		harness.config.talk.bargeIn.mode = "headphones";
		harness.config.talk.bargeIn.minSpeechMs = 1_000;
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);
		cancelCount = 0;

		harness.mode.handleMessageUpdate({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "Heard sentence. Unheard" }] },
		});
		await Bun.sleep(5);
		harness.mode.handleMessageEnd({
			message: { id: "answer", role: "assistant", content: [{ type: "text", text: "Heard sentence. Unheard sentence." }] },
		});
		await Bun.sleep(5);

		feedInOddChunks(harness.captures[0]!, Buffer.concat([
			...Array.from({ length: 34 }, () => toneFrame()),
			...Array.from({ length: 12 }, () => Buffer.alloc(1_024)),
		]));
		await Bun.sleep(15);

		const result = harness.mode.handleContext({
			messages: [
				{ id: "answer", role: "assistant", content: [{ type: "text", text: "Heard sentence. Unheard sentence." }] },
			],
		});
		const contextText = result?.messages[0].content
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join(" ");
		expect(cancelCount).toBe(1);
		expect(contextText).toContain("Heard sentence.");
		expect(contextText).not.toContain("Unheard sentence.");
		await harness.mode.disable(harness.context as any, { notify: false });
	});

	test("interrupted context trims every assistant message with unheard speech", async () => {
		let speechCall = 0;
		const harness = makeHarness({
			speak: async (_text, _config, _ctx, signal) => {
				speechCall += 1;
				if (speechCall === 1) return;
				return new Promise<void>((_resolve, reject) => {
					const abort = () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						reject(error);
					};
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
				});
			},
		});
		harness.config.talk.bargeIn.mode = "headphones";
		await harness.mode.enable(harness.context as any);
		await harness.mode.beginAgentRun("base", harness.context as any);

		harness.mode.handleMessageUpdate({
			message: { id: "first", role: "assistant", content: [{ type: "text", text: "First heard. First unheard" }] },
		});
		await Bun.sleep(5);
		harness.mode.handleMessageEnd({
			message: { id: "first", role: "assistant", content: [{ type: "text", text: "First heard. First unheard." }] },
		});
		harness.mode.handleMessageEnd({
			message: { id: "second", role: "assistant", content: [{ type: "text", text: "Second unheard." }] },
		});
		await Bun.sleep(5);
		feedInOddChunks(harness.captures[0]!, utteranceAudio());
		await Bun.sleep(10);

		const result = harness.mode.handleContext({
			messages: [
				{ id: "first", role: "assistant", content: [{ type: "text", text: "First heard. First unheard." }] },
				{ id: "second", role: "assistant", content: [{ type: "text", text: "Second unheard." }] },
			],
		});
		const firstText = result?.messages[0].content.map((block: any) => block.text).join(" ");
		const secondText = result?.messages[1].content.map((block: any) => block.text).join(" ");
		expect(firstText).toContain("First heard.");
		expect(firstText).not.toContain("First unheard.");
		expect(secondText).not.toContain("Second unheard.");
		expect(harness.pi.entries).toHaveLength(2);
		await harness.mode.disable(harness.context as any, { notify: false });
	});
});
