import type { VoiceConfig } from "./config";
import type { TalkAudioRoute } from "./pipewire-aec";
import { speak, type SpeakOpts } from "./speak";
import { getInstalledTtsModelDir, getTtsModel } from "./tts-local-models";
import {
	DEFAULT_GEMINI_TTS_MODEL,
	DEFAULT_GEMINI_TTS_VOICE,
	geminiSpeak,
	GEMINI_TTS_SAMPLE_RATE,
	type GeminiSpeakOpts,
	type GeminiSpeakResult,
} from "./tts-gemini";
import {
	openPlaybackStream,
	play,
	type OpenPlaybackStreamOpts,
	type PlaybackStream,
	type PlayOpts,
} from "./tts-playback";
import type { TalkSpeechResult } from "./talk-mode";

interface TalkSpeechOutputDependencies {
	speakText?: (opts: SpeakOpts) => Promise<{ audioDurationMs: number }>;
	geminiSpeakText?: (opts: GeminiSpeakOpts) => Promise<GeminiSpeakResult>;
	playAudio?: (opts: PlayOpts) => Promise<void>;
	openStream?: (opts: OpenPlaybackStreamOpts) => PlaybackStream | null;
}

export const GEMINI_TTS_STARTUP_BUFFER_MS = 1_200;

interface StartupBufferedPlaybackStream extends PlaybackStream {
	flushStartupBuffer(): Promise<void>;
}

/**
 * Hold the first remote PCM samples until the player has enough audio to
 * absorb ordinary network jitter. Later samples pass through directly so the
 * buffer adds startup latency only once per assistant turn.
 */
function createStartupBufferedPlaybackStream(
	playbackStream: PlaybackStream,
	sampleRate: number,
	onPlaybackStart?: () => void,
): StartupBufferedPlaybackStream {
	const targetSamples = Math.ceil((sampleRate * GEMINI_TTS_STARTUP_BUFFER_MS) / 1_000);
	let bufferedChunks: Int16Array[] = [];
	let bufferedSamples = 0;
	let started = false;
	let cancelled = false;

	async function flushStartupBuffer(): Promise<void> {
		if (started || cancelled || bufferedSamples === 0) return;
		started = true;
		const chunks = bufferedChunks;
		bufferedChunks = [];
		bufferedSamples = 0;
		onPlaybackStart?.();
		for (const chunk of chunks) await playbackStream.writePcm(chunk);
	}

	return {
		async writePcm(samples: Int16Array): Promise<void> {
			if (cancelled || samples.length === 0) return;
			if (started) {
				await playbackStream.writePcm(samples);
				return;
			}

			// Gemini owns the source chunks. Copy the bounded startup window so
			// later decoder work cannot change samples before they are flushed.
			bufferedChunks.push(samples.slice());
			bufferedSamples += samples.length;
			if (bufferedSamples >= targetSamples) await flushStartupBuffer();
		},
		async end(): Promise<void> {
			await flushStartupBuffer();
			await playbackStream.end();
		},
		cancel(): void {
			if (cancelled) return;
			cancelled = true;
			bufferedChunks = [];
			bufferedSamples = 0;
			playbackStream.cancel();
		},
		done: () => playbackStream.done(),
		flushStartupBuffer,
	};
}

/**
 * Own one streaming player for an assistant turn instead of opening a new
 * process for every sentence emitted by the model. The stream intentionally
 * has no fragment-scoped AbortSignal: Talk mode cancels it explicitly, while a
 * normal turn drains it only after all generated fragments have been queued.
 */
export function createTalkSpeechOutput(
	dependencies: TalkSpeechOutputDependencies = {},
) {
	const speakText = dependencies.speakText ?? speak;
	const geminiSpeakText = dependencies.geminiSpeakText ?? geminiSpeak;
	const playAudio = dependencies.playAudio ?? play;
	const openStream = dependencies.openStream ?? openPlaybackStream;
	let stream: PlaybackStream | null = null;
	let streamKey: string | undefined;
	let flushGeminiStartupBuffer: (() => Promise<void>) | undefined;

	function cancel(): void {
		const active = stream;
		stream = null;
		streamKey = undefined;
		flushGeminiStartupBuffer = undefined;
		try { active?.cancel(); } catch { /* already closed */ }
	}

	async function finish(): Promise<void> {
		const active = stream;
		if (!active) return;
		try {
			await active.end();
			await active.done();
		} finally {
			if (stream === active) {
				stream = null;
				streamKey = undefined;
				flushGeminiStartupBuffer = undefined;
			}
		}
	}

	async function queue(
		text: string,
		voiceConfig: VoiceConfig,
		signal: AbortSignal,
		audioRoute?: TalkAudioRoute,
		onPlaybackStart?: () => void,
	): Promise<TalkSpeechResult> {
		const useGemini = voiceConfig.talk.ttsBackend === "gemini";
		const localModel = useGemini ? undefined : getTtsModel(voiceConfig.talk.ttsModel);
		const geminiModel = voiceConfig.talk.ttsGeminiModel || DEFAULT_GEMINI_TTS_MODEL;
		const geminiVoiceId = voiceConfig.talk.ttsGeminiVoiceId || DEFAULT_GEMINI_TTS_VOICE;
		const sampleRate = useGemini ? GEMINI_TTS_SAMPLE_RATE : localModel!.sampleRate;
		const synthesisKey = useGemini
			? `gemini|${geminiModel}|${geminiVoiceId}`
			: `local|${localModel!.id}|${voiceConfig.talk.ttsVoiceId}`;
		const nextStreamKey = `${synthesisKey}|${audioRoute?.playbackSink ?? "default"}`;
		if (stream && streamKey !== nextStreamKey) cancel();
		if (!stream) {
			const openedStream = openStream({
				sampleRate,
				pulseSink: audioRoute?.playbackSink,
			});
			if (openedStream && useGemini) {
				const bufferedStream = createStartupBufferedPlaybackStream(
					openedStream,
					sampleRate,
					onPlaybackStart,
				);
				stream = bufferedStream;
				flushGeminiStartupBuffer = bufferedStream.flushStartupBuffer;
			} else {
				stream = openedStream;
				flushGeminiStartupBuffer = undefined;
			}
			streamKey = stream ? nextStreamKey : undefined;
		}

		try {
			if (useGemini) {
				const activeStream = stream;
				const result = await geminiSpeakText({
					text,
					model: geminiModel,
					voiceId: geminiVoiceId,
					signal,
					sink: activeStream ?? undefined,
				});
				if (activeStream && stream === activeStream) {
					// A short response may end before reaching the normal startup
					// threshold. Flush it now because no more PCM is coming from this
					// request to trigger the buffer automatically.
					await flushGeminiStartupBuffer?.();
				} else if (!activeStream) {
					if (!result.samples) {
						throw new Error("Gemini TTS did not return buffered audio for fallback playback.");
					}
					onPlaybackStart?.();
					await playAudio({
						source: { samples: result.samples, sampleRate: result.sampleRate },
						signal,
						pulseSink: audioRoute?.playbackSink,
					});
				}
				return {
					audioDurationMs: result.audioDurationMs,
					playbackPending: activeStream !== null,
				};
			}

			const talkVoiceConfig: VoiceConfig = {
				...voiceConfig,
				ttsEnabled: true,
				ttsAutoSpeak: false,
				ttsBackend: "local",
				ttsLocalModel: localModel!.id,
				ttsLocalVoiceId: voiceConfig.talk.ttsVoiceId,
			};
			const result = await speakText({
				text,
				config: talkVoiceConfig,
				signal,
				pulseSink: audioRoute?.playbackSink,
				onPlaybackStart,
				playbackStream: stream ?? undefined,
				resolveModelDir: (modelId) => getInstalledTtsModelDir(modelId),
			});
			return {
				audioDurationMs: result.audioDurationMs,
				playbackPending: stream !== null,
			};
		} catch (error) {
			cancel();
			throw error;
		}
	}

	return {
		queue,
		finish,
		cancel,
		isActive: () => stream !== null,
	};
}
