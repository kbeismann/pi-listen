import type { VoiceConfig } from "./config";
import type { TalkAudioRoute } from "./pipewire-aec";
import { speak, type SpeakOpts } from "./speak";
import { getInstalledTtsModelDir, getTtsModel } from "./tts-local-models";
import { openPlaybackStream, type OpenPlaybackStreamOpts, type PlaybackStream } from "./tts-playback";
import type { TalkSpeechResult } from "./talk-mode";

interface TalkSpeechOutputDependencies {
	speakText?: (opts: SpeakOpts) => Promise<{ audioDurationMs: number }>;
	openStream?: (opts: OpenPlaybackStreamOpts) => PlaybackStream | null;
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
	const openStream = dependencies.openStream ?? openPlaybackStream;
	let stream: PlaybackStream | null = null;
	let streamKey: string | undefined;

	function cancel(): void {
		const active = stream;
		stream = null;
		streamKey = undefined;
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
		const model = getTtsModel(voiceConfig.talk.ttsModel);
		const nextStreamKey = `${model.id}|${audioRoute?.playbackSink ?? "default"}`;
		if (stream && streamKey !== nextStreamKey) cancel();
		if (!stream) {
			stream = openStream({
				sampleRate: model.sampleRate,
				pulseSink: audioRoute?.playbackSink,
			});
			streamKey = stream ? nextStreamKey : undefined;
		}

		const talkVoiceConfig: VoiceConfig = {
			...voiceConfig,
			ttsEnabled: true,
			ttsAutoSpeak: false,
			ttsBackend: "local",
			ttsLocalModel: model.id,
			ttsLocalVoiceId: voiceConfig.talk.ttsVoiceId,
		};
		try {
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
