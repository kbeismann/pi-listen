import type { ChildProcess } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { ContinuousTalkConfig, VoiceConfig } from "./config";
import { createEnergyVad } from "./energy-vad";
import type { TalkAudioRoute } from "./pipewire-aec";
import type { SpeechDetector } from "./sherpa-vad";
import { prepareForSpeech } from "./tts-text-filter";

export type TalkContext = ExtensionContext | ExtensionCommandContext;
export type TalkPhase = "off" | "starting" | "standby" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "stopping" | "error";

export interface TalkEnableOptions {
	inputEnabled?: boolean;
	outputEnabled?: boolean;
	notify?: boolean;
}

export interface TalkControlOptions {
	notify?: boolean;
}

export interface TalkCapture {
	process: ChildProcess;
	tool: string;
}

export interface TalkSpeechResult {
	/** Duration represented by PCM queued during this call. */
	audioDurationMs: number;
	/** True when a shared player still owns and is draining the queued PCM. */
	playbackPending: boolean;
}

export interface TalkModeDependencies {
	getConfig(): VoiceConfig;
	spawnCapture(audioRoute?: TalkAudioRoute): TalkCapture | null;
	prepare(config: VoiceConfig, signal: AbortSignal): Promise<void>;
	createSpeechDetector(config: VoiceConfig): SpeechDetector;
	prepareAudio?(config: VoiceConfig, signal: AbortSignal): Promise<TalkAudioRoute>;
	transcribe(pcm: Buffer, config: VoiceConfig): Promise<string>;
	speak(
		text: string,
		config: VoiceConfig,
		ctx: TalkContext,
		signal: AbortSignal,
		audioRoute?: TalkAudioRoute,
		onPlaybackStart?: () => void,
	): Promise<void | TalkSpeechResult>;
	/** Drain a shared player after the assistant turn has queued all speech. */
	finishSpeech?(): Promise<void>;
	/** Cancel queued and active audio without affecting model generation. */
	cancelSpeech?(): void;
	onAudioChunk?(chunk: Buffer): void;
	getAdditionalAllowedTools?(): string[];
	onStateChange?(): void;
}

interface TalkRun {
	id: number;
	talkScoped: boolean;
	acceptingEvents: boolean;
}

interface MessageStreamState {
	runId: number;
	queuedLength: number;
	completedLength: number;
	latestText: string;
}

interface SpeechCompletion {
	messageId: string;
	completedLength: number;
}

interface UtteranceInterruption {
	verifyBeforeInterrupting: boolean;
	interruptedImmediately: boolean;
	energyConfirmed: boolean;
	speechValidated: boolean;
	confirmed: boolean;
	beganDuringPlayback: boolean;
}

const STATUS_KEY = "continuous-talk";
const TALK_MODE_HIGHLIGHT = "\x1b[0;1;38;2;0;0;0;48;2;255;0;255m";
const ANSI_RESET = "\x1b[0m";
const INTERRUPTION_ENTRY_TYPE = "pi-listen-talk-interruption";
const INTERRUPTED_AFTER_SPEECH = "[The user interrupted here; the remainder of the generated response was not heard.]";
const INTERRUPTED_BEFORE_SPEECH = "[The user interrupted before any of this response was heard.]";
const NON_INTERRUPTING_TALK_WORDS = new Set([
	"ah", "er", "erm", "hm", "hmm", "huh", "mhm", "mm", "oh", "okay", "ok", "right", "sure", "uh", "um", "yeah", "yep", "yes",
]);
const NON_INTERRUPTING_TALK_PHRASES = new Set([
	"continue", "go on", "got it", "i see", "keep going", "please continue", "take your time", "thank you", "thanks",
]);

export const TALK_SYSTEM_PROMPT = `[CONTINUOUS TALK MODE ACTIVE]
The user is having a spoken conversation with you. This mode is read-only and nondestructive. Do not edit files, run shell commands, install software, publish, delete data, or cause external side effects. If write-capable work is needed, ask the user to leave talk mode first with /talk off.

Use the active read-only tools whenever inspection helps. Talk mode may read and search local files and configuration that those tools can access, including paths outside the current project, and trusted integrations may provide additional bounded read-only inspectors. Do not claim that Talk mode itself prevents such inspection. Arbitrary shell commands remain unavailable.

Your response is converted to speech. Write for listening rather than visual scanning. Use short, natural sentences in the user's language. Do not use headings, bullet lists, tables, Markdown, emoji, code blocks, raw URLs, file paths, or symbol-heavy identifiers. Describe those items conversationally instead. By default, aim for about three or four sentences so the response feels like a natural spoken turn. This is not a hard limit: use more sentences whenever correctness, safety, or a complete useful answer requires them. If the user explicitly asks for a longer, detailed, or step-by-step answer, honor that request without applying the short-response default. Do not add confidence scores, report footers, sign-offs, or other written-document conventions.`;

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

function isSubstantiveInterruption(text: string): boolean {
	const normalized = text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
	if (!normalized || NON_INTERRUPTING_TALK_PHRASES.has(normalized)) return false;
	return !normalized.split(/\s+/).every((word) => NON_INTERRUPTING_TALK_WORDS.has(word));
}

function talkStateLabel(
	phase: Exclude<TalkPhase, "off">,
	inputEnabled: boolean,
	outputEnabled: boolean,
): string {
	const phaseLabel = phase === "starting" || phase === "stopping" || phase === "error"
		? phase.toUpperCase()
		: `ON | ${phase.toUpperCase()}`;
	return `${phaseLabel} | INPUT ${inputEnabled ? "ON" : "OFF"} | OUTPUT ${outputEnabled ? "ON" : "OFF"}`;
}

/**
 * Keep a text badge for non-TUI clients, and replace Pi's normal footer with a
 * full-width banner in the interactive TUI. The fixed true-color neon magenta is
 * deliberately independent of the active theme so talk mode's microphone
 * ownership and read-only tool constraints are unmistakable at a glance.
 */
function formatTalkStatus(
	phase: Exclude<TalkPhase, "off">,
	inputEnabled: boolean,
	outputEnabled: boolean,
): string {
	return `${TALK_MODE_HIGHLIGHT} TALK MODE ${talkStateLabel(phase, inputEnabled, outputEnabled)} ${ANSI_RESET}`;
}

function formatTalkFooterLine(
	phase: Exclude<TalkPhase, "off">,
	inputEnabled: boolean,
	outputEnabled: boolean,
	width: number,
): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const label = ` TALK MODE ${talkStateLabel(phase, inputEnabled, outputEnabled)} `;
	const visibleLabel = label.slice(0, targetWidth);
	const availablePadding = targetWidth - visibleLabel.length;
	const leftPadding = Math.floor(availablePadding / 2);
	const rightPadding = availablePadding - leftPadding;
	const line = `${" ".repeat(leftPadding)}${visibleLabel}${" ".repeat(rightPadding)}`;
	return `${TALK_MODE_HIGHLIGHT}${line}${ANSI_RESET}`;
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
		inputEnabled: false,
		outputEnabled: false,
		phase: "off" as TalkPhase,
		talkFooterActive: false,
		lifecycleEpoch: 0,
		runCounter: 0,
		currentRun: undefined as TalkRun | undefined,
		agentActive: false,
		interruptionInProgress: false,
		pendingBargeTurn: false,
		bargeInGuardUntil: 0,
		playbackActive: false,
		sharedPlaybackActive: false,
		utteranceInterruption: undefined as UtteranceInterruption | undefined,
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
		speechDetector: undefined as SpeechDetector | undefined,
		prepareAbort: undefined as AbortController | undefined,
		transcription: undefined as Promise<void> | undefined,
		speechAbort: undefined as AbortController | undefined,
		speechEpoch: 0,
		speechTail: Promise.resolve(),
		speechCompletionTail: Promise.resolve(),
		speechTimingAbort: undefined as AbortController | undefined,
		messageStreams: new Map<string, MessageStreamState>(),
		interruptedMessages: new Map<string, string>(),
		previousModel: undefined as any,
		previousThinkingLevel: undefined as string | undefined,
		previousActiveTools: undefined as string[] | undefined,
		targetModel: undefined as any,
		snapshotTaken: false,
	};

	function setPhase(phase: TalkPhase, ctx?: TalkContext): void {
		state.phase = phase;
		if (ctx) state.ctx = ctx;
		dependencies.onStateChange?.();
		const target = ctx ?? state.ctx;
		if (!target?.hasUI || !target.ui) return;
		if (phase === "off") {
			if (state.talkFooterActive) {
				target.ui.setFooter(undefined);
				state.talkFooterActive = false;
			}
			target.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!state.talkFooterActive) {
			target.ui.setFooter(() => ({
				invalidate() {},
				render(width: number): string[] {
					const visiblePhase = state.phase === "off" ? "stopping" : state.phase;
					return [formatTalkFooterLine(
						visiblePhase,
						state.inputEnabled,
						state.outputEnabled,
						width,
					)];
				},
			}));
			state.talkFooterActive = true;
		}
		target.ui.setStatus(
			STATUS_KEY,
			formatTalkStatus(phase, state.inputEnabled, state.outputEnabled),
		);
	}

	function readyPhase(): "listening" | "standby" {
		return state.inputEnabled ? "listening" : "standby";
	}

	function talkConfig(): ContinuousTalkConfig {
		return state.config?.talk ?? dependencies.getConfig().talk;
	}

	function bargeInEnabled(): boolean {
		if (!state.inputEnabled) return false;
		const mode = talkConfig().bargeIn.mode;
		if (mode === "headphones") return true;
		return mode === "pipewire-aec" && state.audioRoute?.echoCancelled === true;
	}

	function resetSharedSpeechOutput(): void {
		state.sharedPlaybackActive = false;
		state.playbackActive = false;
		state.speechTimingAbort?.abort();
		state.speechTimingAbort = undefined;
		state.speechCompletionTail = Promise.resolve();
		dependencies.cancelSpeech?.();
	}

	function cancelSpeechQueue(): void {
		state.speechEpoch += 1;
		state.speechAbort?.abort();
		resetSharedSpeechOutput();
	}

	function markSpeechComplete(runId: number, completion: SpeechCompletion): void {
		const stream = state.messageStreams.get(completion.messageId);
		if (stream?.runId === runId) {
			stream.completedLength = Math.max(stream.completedLength, completion.completedLength);
		}
	}

	function waitForPlaybackDuration(durationMs: number, signal: AbortSignal): Promise<void> {
		if (durationMs <= 0 || signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(done, durationMs);
			function done() {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
		});
	}

	function queueSpeechCompletion(
		runId: number,
		lifecycleEpoch: number,
		speechEpoch: number,
		completion: SpeechCompletion,
		durationMs: number,
	): void {
		const timing = state.speechTimingAbort ??= new AbortController();
		state.speechCompletionTail = state.speechCompletionTail.catch(() => {}).then(async () => {
			await waitForPlaybackDuration(Math.max(0, durationMs), timing.signal);
			if (
				timing.signal.aborted
				|| speechEpoch !== state.speechEpoch
				|| !runIsCurrent(runId, lifecycleEpoch)
			) return;
			markSpeechComplete(runId, completion);
		});
	}

	function restorePhaseAfterIgnoredAudio(): void {
		setPhase(state.playbackActive ? "speaking" : state.agentActive ? "thinking" : readyPhase());
	}

	function recordInterruptedContext(): void {
		const runId = state.currentRun?.id;
		if (runId === undefined) return;
		const streams: Array<[string, MessageStreamState]> = [];
		for (const [key, stream] of state.messageStreams) {
			if (stream.runId === runId) streams.push([key, stream]);
		}
		const latestKey = streams.at(-1)?.[0];
		for (const [key, stream] of streams) {
			// Fully heard earlier messages need no marker. Always snapshot the
			// latest message. Model generation deliberately continues after TTS is
			// cancelled, but later provider deltas remain unheard and must not be
			// added beyond the audible prefix in the next model context.
			if (key !== latestKey && stream.completedLength >= stream.latestText.length) continue;
			const heardText = stream.latestText.slice(0, stream.completedLength);
			state.interruptedMessages.set(key, heardText);
			try {
				(pi as any).appendEntry?.(INTERRUPTION_ENTRY_TYPE, { messageKey: key, heardText });
			} catch {}
		}
	}

	function interruptSpeechForBargeIn(options: { ignorePlaybackGuard?: boolean } = {}): boolean {
		if (
			!bargeInEnabled()
			|| (!options.ignorePlaybackGuard && Date.now() < state.bargeInGuardUntil)
			|| !state.agentActive
			|| state.interruptionInProgress
		) return false;
		recordInterruptedContext();
		state.interruptionInProgress = true;
		if (state.currentRun) state.currentRun.acceptingEvents = false;
		// Spoken input is steering for the current agent loop. Cancel queued and
		// active TTS so the user is heard immediately, but never abort model
		// reasoning or tool work; Pi delivers the steer at its next safe boundary.
		cancelSpeechQueue();
		setPhase("hearing");
		return true;
	}

	function confirmValidatedUtterance(): void {
		const utteranceInterruption = state.utteranceInterruption;
		if (
			!utteranceInterruption
			|| utteranceInterruption.confirmed
			|| !utteranceInterruption.energyConfirmed
			|| !utteranceInterruption.speechValidated
		) return;
		utteranceInterruption.confirmed = true;
		if (state.playbackActive || !utteranceInterruption.verifyBeforeInterrupting) {
			utteranceInterruption.interruptedImmediately = interruptSpeechForBargeIn();
		}
	}

	function validateCurrentUtteranceAsSpeech(): void {
		const utteranceInterruption = state.utteranceInterruption;
		if (!utteranceInterruption || utteranceInterruption.speechValidated) return;
		utteranceInterruption.speechValidated = true;
		setPhase("hearing");
		confirmValidatedUtterance();
	}

	function handlePlaybackStart(): void {
		state.playbackActive = true;
		const utteranceInterruption = state.utteranceInterruption;
		if (utteranceInterruption?.confirmed && utteranceInterruption.verifyBeforeInterrupting) {
			utteranceInterruption.verifyBeforeInterrupting = false;
			utteranceInterruption.interruptedImmediately = interruptSpeechForBargeIn();
			// The user's sustained speech predates playback. Preserve its VAD
			// state so it can finish and transcribe after the queued audio stops.
			if (utteranceInterruption.interruptedImmediately) return;
		}
		if (talkConfig().bargeIn.mode !== "pipewire-aec" || !state.audioRoute?.echoCancelled) return;
		state.bargeInGuardUntil = Date.now() + talkConfig().bargeIn.guardMs;
		state.utteranceInterruption = undefined;
		state.vad?.reset();
		state.speechDetector?.reset();
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
		const requested = [
			...config.allowedTools,
			...(dependencies.getAdditionalAllowedTools?.() ?? []),
		];
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
		if (!capture) {
			state.speechDetector?.reset();
			return;
		}
		state.capture = undefined;
		if (state.captureDataHandler) capture.process.stdout?.off("data", state.captureDataHandler);
		if (state.captureErrorHandler) capture.process.off("error", state.captureErrorHandler);
		if (state.captureExitHandler) capture.process.off("exit", state.captureExitHandler);
		state.captureDataHandler = undefined;
		state.captureErrorHandler = undefined;
		state.captureExitHandler = undefined;
		state.pcmRemainder = Buffer.alloc(0);
		state.utteranceInterruption = undefined;
		state.vad?.reset();
		state.speechDetector?.reset();
		try { capture.process.kill(signal); } catch {}
	}

	async function failAndStop(error: Error): Promise<void> {
		if (!state.enabled) return;
		notify(state.ctx, `Talk mode stopped: ${error.message}`, "error");
		await disable(state.ctx, { notify: false });
	}

	function consumeCaptureChunk(capture: TalkCapture, chunk: Buffer, epoch: number): void {
		if (
			!state.enabled
			|| !state.inputEnabled
			|| state.capture !== capture
			|| state.lifecycleEpoch !== epoch
			|| !state.vad
			|| !state.speechDetector
		) return;
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
			let neuralSpeechDetected: boolean;
			try {
				neuralSpeechDetected = state.speechDetector.pushFrame(frame);
			} catch (error) {
				void failAndStop(new Error(`Neural speech detection failed: ${error instanceof Error ? error.message : String(error)}`));
				return;
			}
			if (neuralSpeechDetected) validateCurrentUtteranceAsSpeech();
			for (const event of state.vad.pushFrame(frame)) {
				if (event.type === "speech_start") {
					const duringPlayback = state.playbackActive;
					state.utteranceInterruption = {
						// During model-only thinking, wait for local transcription so
						// conversational backchannels do not suppress the current response.
						verifyBeforeInterrupting: bargeInEnabled() && state.agentActive && !duringPlayback,
						interruptedImmediately: false,
						energyConfirmed: false,
						speechValidated: false,
						confirmed: false,
						beganDuringPlayback: duringPlayback,
					};
					if (neuralSpeechDetected) validateCurrentUtteranceAsSpeech();
				}
				if (event.type === "speech_confirmed") {
					if (state.utteranceInterruption) state.utteranceInterruption.energyConfirmed = true;
					confirmValidatedUtterance();
				}
				if (event.type === "discarded") {
					state.utteranceInterruption = undefined;
					state.speechDetector.reset();
					restorePhaseAfterIgnoredAudio();
				}
				if (event.type === "speech_end") {
					const utteranceInterruption = state.utteranceInterruption;
					if (!utteranceInterruption?.speechValidated) {
						// Energy alone also reacts to breathing, keyboard noise, and audio
						// leakage. Never send those segments to an ASR model that could turn
						// ambiguous sound into a confident-looking command.
						state.utteranceInterruption = undefined;
						state.speechDetector.reset();
						restorePhaseAfterIgnoredAudio();
						continue;
					}
					if (utteranceInterruption?.beganDuringPlayback && !utteranceInterruption.confirmed) {
						// Playback-time audio is an interruption gesture, not a second
						// user-input channel. Ignore speech that ends before the configured
						// continuous-speech threshold instead of steering with a backchannel.
						state.utteranceInterruption = undefined;
						state.speechDetector.reset();
						restorePhaseAfterIgnoredAudio();
						continue;
					}
					stopCapture();
					const transcription = transcribeAndSubmit(event.pcm, epoch, {
						verifyBeforeInterrupting: utteranceInterruption?.verifyBeforeInterrupting === true
							&& utteranceInterruption.interruptedImmediately === false,
					});
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

	function startCapture(
		ctx?: TalkContext,
		options: { stopModeOnFailure?: boolean; updatePhase?: boolean } = {
			stopModeOnFailure: true,
			updatePhase: true,
		},
	): boolean {
		if (!state.enabled || !state.inputEnabled || state.capture || !state.speechDetector) return false;
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
			// Do not cancel TTS for audio that endpoint validation would later
			// discard as too short.
			confirmationMs: Math.max(talkConfig().bargeIn.minSpeechMs, vadConfig.minSpeechMs),
			maxUtteranceMs: vadConfig.maxUtteranceMs,
			preRollMs: vadConfig.preRollMs,
		});
		if (state.speechDetector.frameBytes !== state.vad.frameBytes) {
			try { capture.process.kill("SIGKILL"); } catch {}
			if (options.stopModeOnFailure !== false) {
				void failAndStop(new Error(
					`Speech detectors disagree on frame size (${state.speechDetector.frameBytes} and ${state.vad.frameBytes} bytes).`,
				));
			}
			return false;
		}
		state.speechDetector.reset();
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
		if (options.updatePhase !== false) setPhase("listening", ctx);
		return true;
	}

	async function transcribeAndSubmit(
		pcm: Buffer,
		epoch: number,
		options: { verifyBeforeInterrupting?: boolean } = {},
	): Promise<void> {
		if (!state.enabled || state.lifecycleEpoch !== epoch || !state.config) return;
		setPhase("transcribing");
		try {
			const text = (await dependencies.transcribe(pcm, state.config)).trim();
			if (!state.enabled || state.lifecycleEpoch !== epoch) return;
			if (!text || (options.verifyBeforeInterrupting && !isSubstantiveInterruption(text))) {
				state.interruptionInProgress = false;
				state.pendingBargeTurn = false;
				setPhase(readyPhase());
				if (state.inputEnabled) startCapture();
				return;
			}
			// The audio ended before transcription began, so it cannot be echo
			// from playback that started while local STT was running.
			if (options.verifyBeforeInterrupting) interruptSpeechForBargeIn({ ignorePlaybackGuard: true });
			if (state.interruptionInProgress) state.pendingBargeTurn = true;
			setPhase("thinking");
			const result = (pi as any).sendUserMessage(text, { deliverAs: "steer" });
			if (result && typeof result.then === "function") await result;
		} catch (error) {
			if (!state.enabled || state.lifecycleEpoch !== epoch) return;
			state.interruptionInProgress = false;
			state.pendingBargeTurn = false;
			notify(state.ctx, `Talk transcription failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			setPhase(readyPhase());
			if (state.inputEnabled) startCapture();
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

	function setInputEnabled(
		enabled: boolean,
		ctx: TalkContext | undefined = state.ctx,
		options: TalkControlOptions = {},
	): boolean {
		if (!state.enabled) {
			if (options.notify !== false) notify(ctx, "Talk mode is off. Use /talk on first.", "warning");
			return false;
		}
		if (state.inputEnabled === enabled) {
			if (options.notify !== false) notify(ctx, `Talk input is already ${enabled ? "on" : "off"}.`);
			return false;
		}

		state.inputEnabled = enabled;
		if (!enabled) {
			stopCapture();
			if (state.phase === "listening" || state.phase === "hearing") {
				setPhase(state.agentActive ? "thinking" : "standby", ctx);
			} else {
				setPhase(state.phase, ctx);
			}
		} else {
			const captureMayStart = !state.playbackActive || bargeInEnabled();
			if (
				captureMayStart
				&& state.phase !== "starting"
				&& state.phase !== "transcribing"
				&& state.phase !== "stopping"
				&& state.phase !== "error"
			) {
				const started = startCapture(ctx, {
					stopModeOnFailure: false,
					updatePhase: state.phase === "standby" || state.phase === "listening",
				});
				if (!started && !state.capture) {
					state.inputEnabled = false;
					setPhase(state.agentActive ? "thinking" : "standby", ctx);
					notify(ctx, "Could not start microphone capture.", "error");
					return false;
				}
			} else {
				setPhase(state.phase, ctx);
			}
		}
		if (options.notify !== false) notify(ctx, `Talk input ${enabled ? "on" : "off"}.`);
		return true;
	}

	function setOutputEnabled(
		enabled: boolean,
		ctx: TalkContext | undefined = state.ctx,
		options: TalkControlOptions = {},
	): boolean {
		if (!state.enabled) {
			if (options.notify !== false) notify(ctx, "Talk mode is off. Use /talk on first.", "warning");
			return false;
		}
		if (state.outputEnabled === enabled) {
			if (options.notify !== false) notify(ctx, `Talk output is already ${enabled ? "on" : "off"}.`);
			return false;
		}

		state.outputEnabled = enabled;
		if (!enabled) {
			const wasSpeaking = state.phase === "speaking" || state.playbackActive || state.sharedPlaybackActive;
			cancelSpeechQueue();
			if (wasSpeaking) {
				if (state.inputEnabled && !state.capture) {
					startCapture(ctx, {
						stopModeOnFailure: false,
						updatePhase: false,
					});
				}
				setPhase(state.agentActive ? "thinking" : readyPhase(), ctx);
			} else {
				setPhase(state.phase, ctx);
			}
		} else {
			setPhase(state.phase, ctx);
		}
		if (options.notify !== false) notify(ctx, `Talk output ${enabled ? "on" : "off"}.`);
		return true;
	}

	async function enable(
		ctx: TalkContext,
		options: TalkEnableOptions = {},
	): Promise<boolean> {
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
		state.inputEnabled = options.inputEnabled ?? true;
		state.outputEnabled = options.outputEnabled ?? true;
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
			state.speechDetector = dependencies.createSpeechDetector(state.config);
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
			if (state.inputEnabled) {
				if (!startCapture(ctx, { stopModeOnFailure: false })) throw new Error("Could not start microphone capture.");
			} else {
				setPhase("standby", ctx);
			}
			if (options.notify !== false) {
				notify(
					ctx,
					`Talk mode on. Input ${state.inputEnabled ? "on" : "off"}, output ${state.outputEnabled ? "on" : "off"}, ${state.config.talk.thinkingLevel} thinking.`,
				);
			}
			return true;
		} catch (error) {
			state.enabled = false;
			state.inputEnabled = false;
			state.outputEnabled = false;
			stopCapture("SIGKILL");
			state.speechDetector = undefined;
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
		state.inputEnabled = false;
		state.outputEnabled = false;
		state.agentActive = false;
		state.interruptionInProgress = false;
		state.pendingBargeTurn = false;
		state.bargeInGuardUntil = 0;
		state.playbackActive = false;
		state.utteranceInterruption = undefined;
		setPhase("stopping", ctx);
		state.prepareAbort?.abort();
		cancelSpeechQueue();
		state.speechAbort = undefined;
		stopCapture("SIGKILL");
		state.speechDetector = undefined;
		state.messageStreams.clear();
		try { await state.speechTail; } catch {}
		if (options.awaitTranscription && state.transcription) {
			try { await state.transcription; } catch {}
		}
		if (typeof (ctx as any)?.isIdle === "function" && !(ctx as any).isIdle()) {
			// Capture and TTS are already stopped above. Let the active model turn
			// reach its normal boundary before restoring the previous model and
			// tools; leaving talk mode must not cancel reasoning or tool work.
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
		// Pi can start a custom triggerTurn continuation without first emitting
		// before_agent_start. Claim only an otherwise unowned turn here so tool
		// continuations remain part of the current speech run.
		if (
			state.pendingBargeTurn
			|| !state.currentRun?.talkScoped
			|| !state.currentRun.acceptingEvents
		) {
			state.runCounter += 1;
			state.currentRun = { id: state.runCounter, talkScoped: true, acceptingEvents: true };
			state.pendingBargeTurn = false;
			state.interruptionInProgress = false;
			state.generalSpeechSuppressed = true;
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

	function enqueueSpeech(
		text: string,
		runId: number,
		completion: SpeechCompletion,
	): void {
		const lifecycleEpoch = state.lifecycleEpoch;
		const speechEpoch = state.speechEpoch;
		state.speechTail = state.speechTail.catch(() => {}).then(async () => {
			if (
				!state.outputEnabled
				|| speechEpoch !== state.speechEpoch
				|| !runIsCurrent(runId, lifecycleEpoch)
				|| !state.config
				|| !state.ctx
			) return;
			// Headphone mode keeps capture open so sustained near-end speech can
			// cancel playback. The default remains feedback-safe half duplex.
			if (!bargeInEnabled()) stopCapture();
			const controller = new AbortController();
			state.speechAbort = controller;
			setPhase("speaking");
			try {
				const result = await dependencies.speak(
					text,
					state.config,
					state.ctx,
					controller.signal,
					state.audioRoute,
					handlePlaybackStart,
				);
				// Cancellation can race with a player accepting its final buffer.
				// Never promote that stale completion into heard context after the
				// speech epoch or run has changed.
				if (speechEpoch !== state.speechEpoch || !runIsCurrent(runId, lifecycleEpoch)) return;
				if (result?.playbackPending) {
					state.sharedPlaybackActive = true;
					queueSpeechCompletion(
						runId,
						lifecycleEpoch,
						speechEpoch,
						completion,
						result.audioDurationMs,
					);
				} else {
					markSpeechComplete(runId, completion);
				}
			} catch (error) {
				if (state.sharedPlaybackActive) resetSharedSpeechOutput();
				if ((error as Error)?.name !== "AbortError" && speechEpoch === state.speechEpoch && runIsCurrent(runId, lifecycleEpoch)) {
					notify(state.ctx, `Talk speech failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			} finally {
				if (state.speechAbort === controller) state.speechAbort = undefined;
				if (!state.sharedPlaybackActive) state.playbackActive = false;
				if (speechEpoch === state.speechEpoch && runIsCurrent(runId, lifecycleEpoch) && state.currentRun?.acceptingEvents) {
					setPhase(state.sharedPlaybackActive ? "speaking" : "thinking");
				}
			}
		});
	}

	function maybeSpeakMessage(message: any, isFinal: boolean): void {
		if (!state.outputEnabled || !currentRunAcceptsEvents()) return;
		if (message?.role !== "assistant") return;
		const runId = state.currentRun!.id;
		const messageId = messageKey(message);
		const fullText = extractAccumulatedText(message);
		if (!fullText) return;

		let stream = state.messageStreams.get(messageId);
		if (!stream || stream.runId !== runId || fullText.length < stream.queuedLength) {
			stream = { runId, queuedLength: 0, completedLength: 0, latestText: fullText };
			state.messageStreams.set(messageId, stream);
		}
		stream.latestText = fullText;
		const newText = fullText.slice(stream.queuedLength);
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
		stream.queuedLength += speakLength;
		if (!chunk) return;
		const prepared = prepareForSpeech(chunk, {
			maxChars: 2_000,
			stripCodeBlocks: true,
			collapseLinks: true,
		});
		if (!prepared.skipped && prepared.text.trim()) {
			enqueueSpeech(prepared.text, runId, {
				messageId,
				completedLength: stream.queuedLength,
			});
		}
	}

	function truncateInterruptedMessage(message: any, heardText: string): any {
		let remaining = heardText.length;
		const content: any[] = [];
		for (const block of Array.isArray(message?.content) ? message.content : []) {
			if (block?.type !== "text" || typeof block.text !== "string") {
				content.push(block);
				continue;
			}
			if (remaining <= 0) continue;
			const text = block.text.slice(0, remaining);
			remaining -= text.length;
			if (text) content.push({ ...block, text });
		}
		content.push({
			type: "text",
			text: heardText.trim() ? INTERRUPTED_AFTER_SPEECH : INTERRUPTED_BEFORE_SPEECH,
		});
		return { ...message, content };
	}

	function handleContext(event: any): { messages: any[] } | undefined {
		if (state.interruptedMessages.size === 0 || !Array.isArray(event?.messages)) return undefined;
		let changed = false;
		const messages = event.messages.map((message: any) => {
			if (message?.role !== "assistant") return message;
			const heardText = state.interruptedMessages.get(messageKey(message));
			if (heardText === undefined) return message;
			changed = true;
			return truncateInterruptedMessage(message, heardText);
		});
		return changed ? { messages } : undefined;
	}

	function restoreInterruptedContext(ctx: TalkContext): void {
		const entries = (ctx as any).sessionManager?.getEntries?.();
		if (!Array.isArray(entries)) return;
		for (const entry of entries) {
			if (entry?.type !== "custom" || entry.customType !== INTERRUPTION_ENTRY_TYPE) continue;
			const key = entry.data?.messageKey;
			const heardText = entry.data?.heardText;
			if (typeof key === "string" && typeof heardText === "string") {
				state.interruptedMessages.set(key, heardText);
			}
		}
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
		const speechEpoch = state.speechEpoch;
		state.currentRun.acceptingEvents = false;
		await Promise.resolve();
		const pendingSpeech = state.speechTail;
		try { await pendingSpeech; } catch {}
		if (!runIsCurrent(runId, lifecycleEpoch) || speechEpoch !== state.speechEpoch) return;
		if (state.sharedPlaybackActive) {
			const pendingCompletion = state.speechCompletionTail;
			try { await pendingCompletion; } catch {}
			if (!runIsCurrent(runId, lifecycleEpoch) || speechEpoch !== state.speechEpoch) return;
			try {
				await dependencies.finishSpeech?.();
			} catch (error) {
				if ((error as Error)?.name !== "AbortError") {
					notify(state.ctx, `Talk playback failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
			state.sharedPlaybackActive = false;
			state.playbackActive = false;
			state.speechTimingAbort = undefined;
			state.speechCompletionTail = Promise.resolve();
		}
		if (!runIsCurrent(runId, lifecycleEpoch) || speechEpoch !== state.speechEpoch) return;
		state.agentActive = false;
		if (state.capture) setPhase("listening");
		else if (state.inputEnabled) startCapture();
		else setPhase("standby");
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
			`input: ${state.inputEnabled ? "on" : "off"}`,
			`output: ${state.outputEnabled ? "on" : "off"}`,
			`STT: local ${config.sttModel}`,
			"speech validation: local Silero VAD",
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
		setInputEnabled,
		setOutputEnabled,
		beginAgentRun,
		handleTurnStart,
		handleMessageUpdate,
		handleMessageEnd,
		handleTurnEnd,
		handleContext,
		restoreInterruptedContext,
		handleAgentSettled,
		handleInput,
		handleToolCall,
		handleUserBash,
		applyConstraints,
		ownsCurrentRun,
		suppressesGeneralSpeech: () => state.generalSpeechSuppressed,
		isEnabled: () => state.enabled,
		isInputEnabled: () => state.inputEnabled,
		isOutputEnabled: () => state.outputEnabled,
		getPhase: () => state.phase,
		statusLines,
		_state: state,
	};
}
