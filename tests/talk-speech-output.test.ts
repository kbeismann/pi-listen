import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../extensions/voice/config";
import { createTalkSpeechOutput } from "../extensions/voice/talk-speech-output";
import type { PlaybackStream } from "../extensions/voice/tts-playback";

function fakeStream() {
	let endCount = 0;
	let doneCount = 0;
	let cancelCount = 0;
	const stream: PlaybackStream = {
		writePcm: async () => {},
		end: async () => { endCount += 1; },
		done: async () => { doneCount += 1; },
		cancel: () => { cancelCount += 1; },
	};
	return {
		stream,
		counts: () => ({ endCount, doneCount, cancelCount }),
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
});
