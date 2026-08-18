import type { ChildProcess } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { ContinuousTalkConfig, VoiceConfig } from "./config";
import { createEnergyVad } from "./energy-vad";
import type { TalkAudioRoute } from "./pipewire-aec";
import { prepareForSpeech } from "./tts-text-filter";

type TalkContext = ExtensionContext | ExtensionCommandContext;
type TalkPhase = "off" | "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "stopping" | "error";

export interface TalkCapture {
	process: ChildProcess;
	tool: string;
}

export interface TalkModeDependencies {
	getConfig(): VoiceConfig;
	spawnCapture(audioRoute?: TalkAudioRoute): TalkCapture | null;
	prepare(config: VoiceConfig, signal: AbortSignal): Promise<void>;
	prepareAudio?(config: VoiceConfig, signal: AbortSignal): Promise<TalkAudioRoute>;
	transcribe(pcm: Buffer, config: VoiceConfig): Promise<string>;
	speak(
		text: string,
		config: VoiceConfig,
		ctx: TalkContext,
		signal: AbortSignal,
		audioRoute?: TalkAudioRoute,
		onPlaybackStart?: () => void,
	): Promise<void>;
	onAudioChunk?(chunk: Buffer): void;
}

interface TalkRun {
	id: number;
	talkScoped: boolean;
	acceptingEvents: boolean;
}

interface MessageStreamState {
	runId: number;
	spokenLength: number;
}

const STATUS_KEY = "continuous-talk";

export const TALK_SYSTEM_PROMPT = `[CONTINUOUS TALK MODE ACTIVE]
The user is having a spoken conversation with you. This mode is read-only and nondestructive. Do not edit files, run shell commands, install software, publish, delete data, or cause external side effects. If write-capable work is needed, ask the user to leave talk mode first with /talk off.

Your response is converted to speech. Write for listening rather than visual scanning. Use short, natural sentences in the user's language. Do not use headings, bullet lists, tables, Markdown, emoji, code blocks, raw URLs, file paths, or symbol-heavy identifiers. Describe those items conversationally instead. Keep each response focused enough for a natural spoken turn. Do not add confidence scores, report footers, sign-offs, or other written-document conventions.`;

function modelKey(model: any): string {
	return model ? `${model.provider ?? ""}/${model.id ?? ""}` : "";
}

function notify(ctx: TalkContext | undefined, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(message, level);
}

function makeAbortError(): Error {
	const error = new Error("Talk mode operation aborted");
	error.name = "AbortError";
	return error;
}

function extractAccumulatedText(message: any): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text as string)
		.join("");
}

function messageKey(message: any): string {
	if (typeof message?.responseId === "string" && message.responseId) return `response:${message.responseId}`;
	if (Number.isFinite(message?.timestamp)) return `timestamp:${message.timestamp}`;
	if (typeof message?.id === "string" && message.id) return `id:${message.id}`;
	return "current";
}

function lastSentenceEnd(text: string): number {
	const expression = /[.!?](?=\s|$)|\n+/g;
	let lastEnd = -1;
	let match: RegExpExecArray | null;
	while ((match = expression.exec(text)) !== null) {
		lastEnd = match.index + match[0].length;
	}
	return lastEnd;
}

function lastClauseEnd(text: string): number {
	const expression = /[,;:](?=\s)/g;
	let lastEnd = -1;
	let match: RegExpExecArray | null;
	while ((match = expression.exec(text)) !== null) {
		lastEnd = match.index + match[0].length;
	}
	return lastEnd;
}

function isValidTalkModel(config: ContinuousTalkConfig): boolean {
	return Boolean(config.modelProvider) === Boolean(config.modelId);
}

/**
 * Hands-free local-audio conversation controller.
 *
 * Capture remains active while the model is thinking so the user can add a
 * correction without waiting for a long reasoning turn. The loop still closes
 * capture before local TTS starts; speaker-safe playback remains half duplex
 * until an explicit barge-in mode opts into simultaneous capture and playback.
 */
export function createTalkMode(pi: ExtensionAPI, dependencies: TalkModeDependencies) {
	const state = {
		enabled: false,
		phase: "off" as TalkPhase,
		lifecycleEpoch: 0,
		runCounter: 0,
		currentRun: undefined as TalkRun | undefined,
		agentActive: false,
		interruptionInProgress: false,
		pendingBargeTurn: false,
		bargeInGuardUntil: 0,
		generalSpeechSuppressed: false,
		config: undefined as VoiceConfig | undefined,
		audioRoute: undefined as TalkAudioRoute | undefined,
		ctx: undefined as TalkContext | undefined,
		capture: undefined as TalkCapture | undefined,
		captureDataHandler: undefined as ((chunk: Buffer) => void) | undefined,
		captureErrorHandler: undefined as ((error: Error) => void) | undefined,
		captureExitHandler: undefined as ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined,
		pcmRemainder: Buffer.alloc(0),
		vad: undefined as ReturnType<typeof createEnergyVad> | undefined,
		prepareAbort: undefined as AbortController | undefined,
		transcription: undefined as Promise<void> | undefined,
		speechAbort: undefined as AbortController | undefined,
		speechEpoch: 0,
		speechTail: Promise.resolve(),
		messageStreams: new Map<string, MessageStreamState>(),
		previousModel: undefined as any,
		previousThinkingLevel: undefined as string | undefined,
		previousActiveTools: undefined as string[] | undefined,
		targetModel: undefined as any,
		snapshotTaken: false,
	};

	function setPhase(phase: TalkPhase, ctx?: TalkContext): void {
		state.phase = phase;
		if (ctx) state.ctx = ctx;
		const target = ctx ?? state.ctx;
		if (!target?.hasUI || !target.ui?.setStatus) return;
		if (phase === "off") target.ui.setStatus(STATUS_KEY, undefined);
		else target.ui.setStatus(STATUS_KEY, `Talk: ${phase}`);
	}

	function talkConfig(): ContinuousTalkConfig {
		return state.config?.talk ?? dependencies.getConfig().talk;
	}

	function bargeInEnabled(): boolean {
		const mode = talkConfig().bargeIn.mode;
		if (mode === "headphones") return true;
		return mode === "pipewire-aec" && state.audioRoute?.echoCancelled === true;
	}

	function cancelSpeechQueue(): void {
		state.speechEpoch += 1;
		state.speechAbort?.abort();
	}

	function interruptForBargeIn(): void {
		if (
			!bargeInEnabled()
			|| Date.now() < state.bargeInGuardUntil
			|| !state.agentActive
			|| state.interruptionInProgress
		) return;
		state.interruptionInProgress = true;
		if (state.currentRun) state.currentRun.acceptingEvents = false;
		cancelSpeechQueue();
		try { (state.ctx as any)?.abort?.(); } catch {}
		setPhase("hearing");
	}

	function handlePlaybackStart(): void {
		if (talkConfig().bargeIn.mode !== "pipewire-aec" || !state.audioRoute?.echoCancelled) return;
		state.bargeInGuardUntil = Date.now() + talkConfig().bargeIn.guardMs;
		state.vad?.reset();
	}

	async function closeAudioRoute(ctx?: TalkContext): Promise<boolean> {
		const route = state.audioRoute;
		state.bargeInGuardUntil = 0;
		if (!route) return true;
		try {
			await route.close();
			if (state.audioRoute === route) state.audioRoute = undefined;
			return true;
		} catch (error) {
			notify(ctx, `Could not remove the /talk audio route: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		}
	}

	function effectiveAllowedTools(config: ContinuousTalkConfig): string[] {
		const requested = config.allowedTools;
		const allTools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : undefined;
		if (!Array.isArray(allTools) || allTools.length === 0) return [...requested];
		const known = new Set(allTools.map((tool: any) => tool?.name).filter((name: unknown) => typeof name === "string"));
		return requested.filter((name) => known.has(name));
	}

	function applyConstraints(ctx?: TalkContext): void {
		if (!state.enabled) return;
		const config = talkConfig();
		if (typeof (pi as any).setThinkingLevel === "function") {
			(pi as any).setThinkingLevel(config.thinkingLevel);
		}
		if (typeof (pi as any).setActiveTools === "function") {
			(pi as any).setActiveTools(effectiveAllowedTools(config));
		}
		if (ctx) setPhase(state.phase, ctx);
	}

	function stopCapture(signal: NodeJS.Signals = "SIGKILL"): void {
		const capture = state.capture;
		if (!capture) return;
		state.capture = undefined;
		if (state.captureDataHandler) capture.process.stdout?.off("data", state.captureDataHandler);
		if (state.captureErrorHandler) capture.process.off("error", state.captureErrorHandler);
		if (state.captureExitHandler) capture.process.off("exit", state.captureExitHandler);
		state.captureDataHandler = undefined;
		state.captureErrorHandler = undefined;
		state.captureExitHandler = undefined;
		state.pcmRemainder = Buffer.alloc(0);
		state.vad?.reset();
		try { capture.process.kill(signal); } catch {}
	}

	async function failAndStop(error: Error): Promise<void> {
		if (!state.enabled) return;
		notify(state.ctx, `Talk mode stopped: ${error.message}`, "error");
		await disable(state.ctx, { notify: false });
	}

	function consumeCaptureChunk(capture: TalkCapture, chunk: Buffer, epoch: number): void {
		if (!state.enabled || state.capture !== capture || state.lifecycleEpoch !== epoch || !state.vad) return;
		dependencies.onAudioChunk?.(chunk);
		const combined = state.pcmRemainder.length > 0
			? Buffer.concat([state.pcmRemainder, chunk])
			: chunk;
		const frameBytes = state.vad.frameBytes;
		let offset = 0;

		while (offset + frameBytes <= combined.length) {
			const frame = combined.subarray(offset, offset + frameBytes);
			offset += frameBytes;
			if (Date.now() < state.bargeInGuardUntil) continue;
			for (const event of state.vad.pushFrame(frame)) {
				if (event.type === "speech_start") setPhase("hearing");
				if (event.type === "speech_confirmed") interruptForBargeIn();
				if (event.type === "discarded") setPhase("listening");
				if (event.type === "speech_end") {
					stopCapture();
					const transcription = transcribeAndSubmit(event.pcm, epoch);
					state.transcription = transcription;
					void transcription.finally(() => {
						if (state.transcription === transcription) state.transcription = undefined;
					});
					return;
				}
			}
		}
		state.pcmRemainder = Buffer.from(combined.subarray(offset));
	}

	function startCapture(ctx?: TalkContext, options: { stopModeOnFailure?: boolean } = { stopModeOnFailure: true }): boolean {
		if (!state.enabled || state.capture) return false;
		const epoch = state.lifecycleEpoch;
		let capture: TalkCapture | null;
		try {
			capture = dependencies.spawnCapture(state.audioRoute);
		} catch (error) {
			if (options.stopModeOnFailure !== false) {
				void failAndStop(error instanceof Error ? error : new Error(String(error)));
			}
			return false;
		}
		if (!capture?.process.stdout) {
			if (options.stopModeOnFailure !== false) {
				void failAndStop(new Error("No local audio capture tool is available."));
			}
			return false;
		}

		const vadConfig = talkConfig().vad;
		state.vad = createEnergyVad({
			startDb: vadConfig.startDb,
			thresholdDb: vadConfig.thresholdDb,
			hangoverMs: vadConfig.hangoverMs,
			minSpeechMs: vadConfig.minSpeechMs,
			// Never abort a model run for audio that normal endpoint validation
			// would later discard as too short.
			confirmationMs: Math.max(talkConfig().bargeIn.minSpeechMs, vadConfig.minSpeechMs),
			maxUtteranceMs: vadConfig.maxUtteranceMs,
			preRollMs: vadConfig.preRollMs,
		});
		state.pcmRemainder = Buffer.alloc(0);
		state.capture = capture;
		state.captureDataHandler = (chunk: Buffer) => consumeCaptureChunk(capture, chunk, epoch);
		state.captureErrorHandler = (error: Error) => {
			if (state.capture === capture) void failAndStop(new Error(`Microphone capture failed: ${error.message}`));
		};
		state.captureExitHandler = (code, signal) => {
			if (state.capture !== capture || !state.enabled) return;
			state.capture = undefined;
			void failAndStop(new Error(`Microphone capture exited unexpectedly (${signal ?? code ?? "unknown"}).`));
		};
		capture.process.stdout.on("data", state.captureDataHandler);
		capture.process.on("error", state.captureErrorHandler);
		capture.process.on("exit", state.captureExitHandler);
		setPhase("listening", ctx);
		return true;
	}

	async function transcribeAndSubmit(pcm: Buffer, epoch: number): Promise<void> {
		if (!state.enabled || state.lifecycleEpoch !== epoch || !state.config) return;
		setPhase("transcribing");
		try {
			const text = (await dependencies.transcribe(pcm, state.config)).trim();
			if (!state.enabled || state.lifecycleEpoch !== epoch) return;
			if (!text) {
				state.interruptionInProgress = false;
				setPhase("listening");
				startCapture();
				return;
			}
			if (state.interruptionInProgress) state.pendingBargeTurn = true;
			setPhase("thinking");
			const result = (pi as any).sendUserMessage(text, { deliverAs: "steer" });
			if (result && typeof result.then === "function") await result;
		} catch (error) {
			if (!state.enabled || state.lifecycleEpoch !== epoch) return;
			state.interruptionInProgress = false;
			state.pendingBargeTurn = false;
			notify(state.ctx, `Talk transcription failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			startCapture();
		}
	}

	async function switchToTalkModel(ctx: TalkContext, config: ContinuousTalkConfig): Promise<void> {
		if (!isValidTalkModel(config)) {
			throw new Error("Talk modelProvider and modelId must either both be set or both be omitted.");
		}

		state.previousModel = (ctx as any).model;
		state.previousThinkingLevel = typeof (pi as any).getThinkingLevel === "function"
			? (pi as any).getThinkingLevel()
			: undefined;
		state.previousActiveTools = typeof (pi as any).getActiveTools === "function"
			? [...(pi as any).getActiveTools()]
			: undefined;
		state.snapshotTaken = true;

		if (!config.modelProvider || !config.modelId) return;
		const target = (ctx as any).modelRegistry?.find(config.modelProvider, config.modelId);
		if (!target) throw new Error(`Talk model ${config.modelProvider}/${config.modelId} is not registered.`);
		state.targetModel = target;
		if (modelKey(target) === modelKey(state.previousModel)) return;
		const changed = await (pi as any).setModel(target);
		if (!changed) throw new Error(`Talk model ${config.modelProvider}/${config.modelId} is unavailable or missing credentials.`);
	}

	async function restorePiState(ctx?: TalkContext): Promise<boolean> {
		if (!state.snapshotTaken) return true;
		const previousModel = state.previousModel;
		const previousThinkingLevel = state.previousThinkingLevel;
		const previousActiveTools = state.previousActiveTools;
		let modelRestored = true;

		if (previousModel && typeof (pi as any).setModel === "function") {
			try {
				const currentModel = (ctx as any)?.model;
				if (modelKey(currentModel) !== modelKey(previousModel)) {
					const restored = await (pi as any).setModel(previousModel);
					if (!restored) {
						modelRestored = false;
						notify(ctx, `Could not restore model ${modelKey(previousModel)}.`, "warning");
					}
				}
			} catch (error) {
				modelRestored = false;
				notify(ctx, `Could not restore the previous model: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		if (previousThinkingLevel !== undefined && typeof (pi as any).setThinkingLevel === "function") {
			(pi as any).setThinkingLevel(previousThinkingLevel);
		}
		if (previousActiveTools !== undefined && typeof (pi as any).setActiveTools === "function") {
			(pi as any).setActiveTools(previousActiveTools);
		}
		if (modelRestored) {
			state.snapshotTaken = false;
			state.previousModel = undefined;
			state.previousThinkingLevel = undefined;
			state.previousActiveTools = undefined;
		}
		return modelRestored;
	}

	async function enable(ctx: ExtensionCommandContext): Promise<boolean> {
		state.ctx = ctx;
		if (state.enabled || state.phase === "starting") {
			notify(ctx, "Talk mode is already on.");
			return false;
		}
		if (state.audioRoute && !await closeAudioRoute(ctx)) {
			notify(ctx, "Talk mode cannot restart until its previous PipeWire route is removed.", "error");
			return false;
		}
		if (typeof (ctx as any).isIdle === "function" && !(ctx as any).isIdle()) {
			notify(ctx, "Waiting for the current agent turn before starting talk mode.");
			await (ctx as any).waitForIdle?.();
		}
		if (state.snapshotTaken && !await restorePiState(ctx)) {
			notify(ctx, "Talk mode cannot restart until the previous model is restored.", "error");
			return false;
		}

		const epoch = ++state.lifecycleEpoch;
		state.config = structuredClone(dependencies.getConfig());
		state.prepareAbort = new AbortController();
		setPhase("starting", ctx);

		try {
			if (!isValidTalkModel(state.config.talk)) {
				throw new Error("Talk modelProvider and modelId must either both be set or both be omitted.");
			}
			if (state.transcription) await state.transcription;
			if (state.lifecycleEpoch !== epoch || state.prepareAbort.signal.aborted) throw makeAbortError();
			await dependencies.prepare(state.config, state.prepareAbort.signal);
			if (state.lifecycleEpoch !== epoch || state.prepareAbort.signal.aborted) throw makeAbortError();
			if (state.config.talk.bargeIn.mode === "pipewire-aec") {
				try {
					if (!dependencies.prepareAudio) throw new Error("The PipeWire audio adapter is unavailable.");
					state.audioRoute = await dependencies.prepareAudio(state.config, state.prepareAbort.signal);
				} catch (error) {
					if ((error as Error)?.name === "AbortError") throw error;
					const cleanupRoute = (error as { cleanupRoute?: TalkAudioRoute })?.cleanupRoute;
					if (cleanupRoute?.echoCancelled && typeof cleanupRoute.close === "function") {
						state.audioRoute = cleanupRoute;
					}
					if (!await closeAudioRoute(ctx)) {
						// Do not enter fallback while an incompletely removed AEC route can
						// still own virtual devices. Keep the handle for /talk off to retry.
						throw error;
					}
					notify(
						ctx,
						`PipeWire echo cancellation is unavailable; /talk will use speaker-safe playback. ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
			}
			await switchToTalkModel(ctx, state.config.talk);
			if (state.lifecycleEpoch !== epoch) throw makeAbortError();
			state.enabled = true;
			applyConstraints(ctx);
			if (!startCapture(ctx, { stopModeOnFailure: false })) throw new Error("Could not start microphone capture.");
			notify(
				ctx,
				`Talk mode on. Local ${state.config.talk.sttModel} input, local ${state.config.talk.ttsModel} speech, ${state.config.talk.thinkingLevel} thinking.`,
			);
			return true;
		} catch (error) {
			state.enabled = false;
			stopCapture("SIGKILL");
			await closeAudioRoute(ctx);
			await restorePiState(ctx);
			state.targetModel = undefined;
			setPhase("off", ctx);
			if ((error as Error)?.name !== "AbortError") {
				notify(ctx, `Could not start talk mode: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return false;
		} finally {
			state.prepareAbort = undefined;
		}
	}

	async function disable(
		ctx: TalkContext | undefined = state.ctx,
		options: { notify?: boolean; awaitTranscription?: boolean } = {},
	): Promise<boolean> {
		const wasActive = state.enabled || state.phase === "starting" || state.phase === "error";
		const hadPendingRestore = state.snapshotTaken;
		const hadAudioRoute = state.audioRoute !== undefined;
		if (!wasActive && !hadPendingRestore && !hadAudioRoute && state.phase === "off" && !(options.awaitTranscription && state.transcription)) {
			if (options.notify !== false) notify(ctx, "Talk mode is already off.");
			return false;
		}
		++state.lifecycleEpoch;
		state.enabled = false;
		state.agentActive = false;
		state.interruptionInProgress = false;
		state.pendingBargeTurn = false;
		state.bargeInGuardUntil = 0;
		setPhase("stopping", ctx);
		state.prepareAbort?.abort();
		cancelSpeechQueue();
		state.speechAbort = undefined;
		stopCapture("SIGKILL");
		state.messageStreams.clear();
		try { await state.speechTail; } catch {}
		if (options.awaitTranscription && state.transcription) {
			try { await state.transcription; } catch {}
		}
		if (typeof (ctx as any)?.isIdle === "function" && !(ctx as any).isIdle()) {
			try { (ctx as any).abort?.(); } catch {}
			try { await (ctx as any).waitForIdle?.(); } catch {}
		}
		await closeAudioRoute(ctx);
		state.currentRun = undefined;
		state.generalSpeechSuppressed = false;
		const restored = await restorePiState(ctx);
		state.targetModel = undefined;
		state.config = undefined;
		setPhase("off", ctx);
		if (options.notify !== false) {
			if (!wasActive && restored && hadPendingRestore) notify(ctx, "Previous model restored.");
			else if (!wasActive) notify(ctx, "Talk mode is already off.");
			else if (restored) notify(ctx, "Talk mode off. Previous model, thinking, and tools restored.");
			else notify(ctx, "Talk mode is off, but the previous model could not be restored. Run /talk off to retry.", "warning");
		}
		return wasActive;
	}

	async function beginAgentRun(systemPrompt: string, ctx: TalkContext): Promise<string | undefined> {
		state.ctx = ctx;
		state.runCounter += 1;
		const talkScoped = state.enabled;
		state.currentRun = { id: state.runCounter, talkScoped, acceptingEvents: talkScoped };
		state.agentActive = talkScoped;
		state.interruptionInProgress = false;
		state.pendingBargeTurn = false;
		state.bargeInGuardUntil = 0;
		state.generalSpeechSuppressed = talkScoped;
		state.messageStreams.clear();
		if (!talkScoped) return undefined;
		cancelSpeechQueue();
		if (state.targetModel && modelKey((ctx as any).model) !== modelKey(state.targetModel)) {
			try {
				const changed = await (pi as any).setModel(state.targetModel);
				if (!changed) notify(ctx, `Talk model ${modelKey(state.targetModel)} is unavailable; keeping the current model for this read-only turn.`, "warning");
			} catch (error) {
				notify(ctx, `Could not select talk model ${modelKey(state.targetModel)}: ${error instanceof Error ? error.message : String(error)}. Keeping the current model for this read-only turn.`, "warning");
			}
		}
		applyConstraints(ctx);
		setPhase("thinking", ctx);
		startCapture(ctx);
		return `${systemPrompt}\n\n${TALK_SYSTEM_PROMPT}`;
	}

	function handleTurnStart(ctx: TalkContext): void {
		if (!state.enabled) return;
		state.ctx = ctx;
		state.agentActive = true;
		if (state.pendingBargeTurn) {
			state.runCounter += 1;
			state.currentRun = { id: state.runCounter, talkScoped: true, acceptingEvents: true };
			state.pendingBargeTurn = false;
			state.interruptionInProgress = false;
			state.messageStreams.clear();
			cancelSpeechQueue();
		}
		applyConstraints(ctx);
		setPhase("thinking", ctx);
		startCapture(ctx);
	}

	function ownsCurrentRun(): boolean {
		return Boolean(state.enabled && state.currentRun?.talkScoped);
	}

	function currentRunAcceptsEvents(): boolean {
		return Boolean(ownsCurrentRun() && state.currentRun?.acceptingEvents);
	}

	function runIsCurrent(runId: number, lifecycleEpoch: number): boolean {
		return Boolean(
			state.enabled
			&& state.lifecycleEpoch === lifecycleEpoch
			&& state.currentRun?.talkScoped
			&& state.currentRun.id === runId,
		);
	}

	function enqueueSpeech(text: string, runId: number): void {
		const lifecycleEpoch = state.lifecycleEpoch;
		const speechEpoch = state.speechEpoch;
		state.speechTail = state.speechTail.catch(() => {}).then(async () => {
			if (speechEpoch !== state.speechEpoch || !runIsCurrent(runId, lifecycleEpoch) || !state.config || !state.ctx) return;
			// Headphone mode keeps capture open so sustained near-end speech can
			// cancel playback. The default remains feedback-safe half duplex.
			if (!bargeInEnabled()) stopCapture();
			const controller = new AbortController();
			state.speechAbort = controller;
			setPhase("speaking");
			try {
				await dependencies.speak(
					text,
					state.config,
					state.ctx,
					controller.signal,
					state.audioRoute,
					handlePlaybackStart,
				);
			} catch (error) {
				if ((error as Error)?.name !== "AbortError" && speechEpoch === state.speechEpoch && runIsCurrent(runId, lifecycleEpoch)) {
					notify(state.ctx, `Talk speech failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			} finally {
				if (state.speechAbort === controller) state.speechAbort = undefined;
				if (speechEpoch === state.speechEpoch && runIsCurrent(runId, lifecycleEpoch) && state.currentRun?.acceptingEvents) setPhase("thinking");
			}
		});
	}

	function maybeSpeakMessage(message: any, isFinal: boolean): void {
		if (!currentRunAcceptsEvents()) return;
		if (message?.role !== "assistant") return;
		const runId = state.currentRun!.id;
		const messageId = messageKey(message);
		const fullText = extractAccumulatedText(message);
		if (!fullText) return;

		let stream = state.messageStreams.get(messageId);
		if (!stream || stream.runId !== runId || fullText.length < stream.spokenLength) {
			stream = { runId, spokenLength: 0 };
			state.messageStreams.set(messageId, stream);
		}
		const newText = fullText.slice(stream.spokenLength);
		if (!newText) return;

		let speakLength = 0;
		if (isFinal) speakLength = newText.length;
		else {
			const sentenceEnd = lastSentenceEnd(newText);
			if (sentenceEnd > 0) speakLength = sentenceEnd;
			else if (newText.length >= 100) speakLength = Math.max(0, lastClauseEnd(newText));
		}
		if (speakLength <= 0) return;

		const chunk = newText.slice(0, speakLength).trim();
		stream.spokenLength += speakLength;
		if (!chunk) return;
		const prepared = prepareForSpeech(chunk, {
			maxChars: 2_000,
			stripCodeBlocks: true,
			collapseLinks: true,
		});
		if (!prepared.skipped && prepared.text.trim()) enqueueSpeech(prepared.text, runId);
	}

	function handleMessageUpdate(event: any): void {
		maybeSpeakMessage(event?.message, false);
	}

	function handleMessageEnd(event: any): void {
		maybeSpeakMessage(event?.message, true);
	}

	function handleTurnEnd(event: any): void {
		const message = event?.message;
		maybeSpeakMessage(message, true);
	}

	async function handleAgentSettled(): Promise<void> {
		if (!ownsCurrentRun() || !state.currentRun) return;
		const runId = state.currentRun.id;
		const lifecycleEpoch = state.lifecycleEpoch;
		state.currentRun.acceptingEvents = false;
		await Promise.resolve();
		const pendingSpeech = state.speechTail;
		try { await pendingSpeech; } catch {}
		if (!runIsCurrent(runId, lifecycleEpoch)) return;
		state.agentActive = false;
		startCapture();
	}

	function handleInput(ctx: TalkContext): void {
		if (!state.enabled) return;
		state.ctx = ctx;
		stopCapture();
		applyConstraints(ctx);
		setPhase("thinking", ctx);
	}

	function handleToolCall(event: any): { block: true; reason: string } | undefined {
		if (!state.enabled) return undefined;
		const allowed = new Set(effectiveAllowedTools(talkConfig()));
		const toolName = typeof event?.toolName === "string" ? event.toolName : "unknown";
		if (allowed.has(toolName)) return undefined;
		return {
			block: true,
			reason: `Talk mode is read-only; tool '${toolName}' is unavailable until /talk off.`,
		};
	}

	function handleUserBash(): any {
		if (!state.enabled) return undefined;
		return {
			result: {
				output: "Talk mode blocks shell commands. Use /talk off first.",
				exitCode: 126,
				cancelled: false,
				truncated: false,
			},
		};
	}

	function statusLines(): string[] {
		const config = state.config?.talk ?? dependencies.getConfig().talk;
		const bargeInStatus = state.enabled && config.bargeIn.mode === "pipewire-aec" && !state.audioRoute?.echoCancelled
			? "off (PipeWire fallback)"
			: config.bargeIn.mode;
		return [
			`Talk mode: ${state.enabled ? state.phase : "off"}`,
			`STT: local ${config.sttModel}`,
			`TTS: local ${config.ttsModel}, voice ${config.ttsVoiceId}`,
			`model: ${config.modelProvider && config.modelId ? `${config.modelProvider}/${config.modelId}` : "current"}`,
			`thinking: ${config.thinkingLevel}`,
			`barge-in: ${bargeInStatus}`,
			`endpoint silence: ${config.vad.hangoverMs} ms`,
		];
	}

	return {
		enable,
		disable,
		beginAgentRun,
		handleTurnStart,
		handleMessageUpdate,
		handleMessageEnd,
		handleTurnEnd,
		handleAgentSettled,
		handleInput,
		handleToolCall,
		handleUserBash,
		applyConstraints,
		ownsCurrentRun,
		suppressesGeneralSpeech: () => state.generalSpeechSuppressed,
		isEnabled: () => state.enabled,
		getPhase: () => state.phase,
		statusLines,
		_state: state,
	};
}
