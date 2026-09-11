import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../extensions/voice/config";
import {
	createTalkSpeechOutput,
	GEMINI_TTS_STARTUP_BUFFER_MS,
} from "../extensions/voice/talk-speech-output";
import type { PlaybackStream } from "../extensions/voice/tts-playback";

function fakeStream() {
	let endCount = 0;
	let doneCount = 0;
	let cancelCount = 0;
	const writes: number[][] = [];
	const stream: PlaybackStream = {
		writePcm: async (samples) => { writes.push(Array.from(samples)); },
		end: async () => { endCount += 1; },
		done: async () => { doneCount += 1; },
		cancel: () => { cancelCount += 1; },
	};
	return {
		stream,
		counts: () => ({ endCount, doneCount, cancelCount }),
		writes: () => writes,
	};
}

describe("Talk speech output", () => {
	test("reuses one player for adjacent fragments and drains it once", async () => {
		const player = fakeStream();
		const receivedStreams: Array<PlaybackStream | undefined> = [];
		const output = createTalkSpeechOutput({
			openStream: () => player.stream,
			speakText: async (options) => {
				receivedStreams.push(options.playbackStream);
				return { audioDurationMs: 250 };
			},
		});
		const config = structuredClone(DEFAULT_CONFIG);
		const signal = new AbortController().signal;

		const first = await output.queue("First sentence.", config, signal);
		const second = await output.queue("Second sentence.", config, signal);

		expect(first).toEqual({ audioDurationMs: 250, playbackPending: true });
		expect(second).toEqual({ audioDurationMs: 250, playbackPending: true });
		expect(receivedStreams).toEqual([player.stream, player.stream]);
		expect(output.isActive()).toBe(true);

		await output.finish();
		expect(player.counts()).toEqual({ endCount: 1, doneCount: 1, cancelCount: 0 });
		expect(output.isActive()).toBe(false);
	});

	test("cancellation discards the player and the next turn opens another", async () => {
		const firstPlayer = fakeStream();
		const secondPlayer = fakeStream();
		const players = [firstPlayer, secondPlayer];
		const output = createTalkSpeechOutput({
			openStream: () => players.shift()!.stream,
			speakText: async () => ({ audioDurationMs: 100 }),
		});
		const config = structuredClone(DEFAULT_CONFIG);
		const signal = new AbortController().signal;

		await output.queue("Interrupted.", config, signal);
		output.cancel();
		await output.queue("New turn.", config, signal);

		expect(firstPlayer.counts().cancelCount).toBe(1);
		expect(secondPlayer.counts().cancelCount).toBe(0);
	});

	test("falls back to self-contained playback when no stream is available", async () => {
		let receivedStream: PlaybackStream | undefined;
		const output = createTalkSpeechOutput({
			openStream: () => null,
			speakText: async (options) => {
				receivedStream = options.playbackStream;
				return { audioDurationMs: 400 };
			},
		});

		const result = await output.queue(
			"Fallback playback.",
			structuredClone(DEFAULT_CONFIG),
			new AbortController().signal,
		);

		expect(receivedStream).toBeUndefined();
		expect(result).toEqual({ audioDurationMs: 400, playbackPending: false });
		await output.finish();
	});

	test("prebuffers Gemini audio before starting the shared player", async () => {
		const player = fakeStream();
		let playbackStarts = 0;
		let localSpeakCalls = 0;
		let openedSampleRate = 0;
		const received: Array<{ model: string; voiceId: string; sink?: PlaybackStream }> = [];
		const targetSamples = (24_000 * GEMINI_TTS_STARTUP_BUFFER_MS) / 1_000;
		const output = createTalkSpeechOutput({
			openStream: (options) => {
				openedSampleRate = options.sampleRate;
				return player.stream;
			},
			speakText: async () => {
				localSpeakCalls += 1;
				return { audioDurationMs: 0 };
			},
			geminiSpeakText: async (options) => {
				received.push({ model: options.model, voiceId: options.voiceId, sink: options.sink });
				expect(options.onAudioStart).toBeUndefined();
				await options.sink?.writePcm(new Int16Array(targetSamples - 1));
				expect(player.writes()).toEqual([]);
				expect(playbackStarts).toBe(0);
				await options.sink?.writePcm(new Int16Array([1, 2]));
				return { sampleRate: 24000, audioDurationMs: 500 };
			},
		});
		const config = structuredClone(DEFAULT_CONFIG);
		config.talk.ttsBackend = "gemini";
		config.talk.ttsGeminiModel = "gemini-3.1-flash-tts-preview";
		config.talk.ttsGeminiVoiceId = "Leda";

		const result = await output.queue(
			"Remote sentence.",
			config,
			new AbortController().signal,
			undefined,
			() => { playbackStarts += 1; },
		);

		expect(openedSampleRate).toBe(24000);
		expect(received).toHaveLength(1);
		expect(received[0]!.model).toBe("gemini-3.1-flash-tts-preview");
		expect(received[0]!.voiceId).toBe("Leda");
		expect(received[0]!.sink).toBeDefined();
		expect(received[0]!.sink).not.toBe(player.stream);
		expect(player.writes().map((samples) => samples.length)).toEqual([targetSamples - 1, 2]);
		expect(localSpeakCalls).toBe(0);
		expect(playbackStarts).toBe(1);
		expect(result).toEqual({ audioDurationMs: 500, playbackPending: true });
	});

	test("flushes a short Gemini response when its request completes", async () => {
		const player = fakeStream();
		let playbackStarts = 0;
		const output = createTalkSpeechOutput({
			openStream: () => player.stream,
			geminiSpeakText: async (options) => {
				await options.sink?.writePcm(new Int16Array([3, 4]));
				expect(player.writes()).toEqual([]);
				expect(playbackStarts).toBe(0);
				return { sampleRate: 24000, audioDurationMs: 100 };
			},
		});
		const config = structuredClone(DEFAULT_CONFIG);
		config.talk.ttsBackend = "gemini";

		const result = await output.queue(
			"Short remote response.",
			config,
			new AbortController().signal,
			undefined,
			() => { playbackStarts += 1; },
		);

		expect(player.writes()).toEqual([[3, 4]]);
		expect(playbackStarts).toBe(1);
		expect(result).toEqual({ audioDurationMs: 100, playbackPending: true });
		await output.finish();
		expect(player.counts()).toEqual({ endCount: 1, doneCount: 1, cancelCount: 0 });
	});

	test("plays buffered Gemini PCM when no streaming player is available", async () => {
		let playedSamples: Float32Array | undefined;
		let playbackStarts = 0;
		const output = createTalkSpeechOutput({
			openStream: () => null,
			geminiSpeakText: async (options) => {
				expect(options.sink).toBeUndefined();
				return {
					samples: new Float32Array([0, 0.5]),
					sampleRate: 24000,
					audioDurationMs: 250,
				};
			},
			playAudio: async (options) => {
				if ("samples" in options.source) playedSamples = options.source.samples;
			},
		});
		const config = structuredClone(DEFAULT_CONFIG);
		config.talk.ttsBackend = "gemini";

		const result = await output.queue(
			"Buffered remote sentence.",
			config,
			new AbortController().signal,
			undefined,
			() => { playbackStarts += 1; },
		);

		expect(Array.from(playedSamples ?? [])).toEqual([0, 0.5]);
		expect(playbackStarts).toBe(1);
		expect(result).toEqual({ audioDurationMs: 250, playbackPending: false });
	});
});
