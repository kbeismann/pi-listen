import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildGeminiTtsUrl,
	geminiSpeak,
	GEMINI_API_HOST,
	GEMINI_TTS_SAMPLE_RATE,
	GeminiTtsHttpError,
	isGeminiTtsQuotaError,
	resolveGeminiApiKey,
} from "../extensions/voice/tts-gemini";
import type { PlaybackStream } from "../extensions/voice/tts-playback";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function makeSseResponse(events: unknown[], transportChunkSize = 0): Response {
	const encoded = new TextEncoder().encode(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
	);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (transportChunkSize <= 0) {
				controller.enqueue(encoded);
			} else {
				for (let offset = 0; offset < encoded.length; offset += transportChunkSize) {
					controller.enqueue(encoded.slice(offset, offset + transportChunkSize));
				}
			}
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function audioEvent(bytes: number[], mimeType = "audio/L16;codec=pcm;rate=24000"): unknown {
	return {
		candidates: [{
			content: {
				parts: [{
					inlineData: {
						mimeType,
						data: Buffer.from(bytes).toString("base64"),
					},
				}],
			},
		}],
	};
}

describe("Gemini API key resolution", () => {
	test("prefers GEMINI_API_KEY over authinfo", () => {
		expect(resolveGeminiApiKey({
			env: { GEMINI_API_KEY: " environment-key " },
			authinfoPath: "/does/not/exist",
		})).toBe("environment-key");
	});

	test("reads the exact Gemini machine from authinfo", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-listen-gemini-key-"));
		tempDirs.push(directory);
		const authinfoPath = path.join(directory, "authinfo");
		fs.writeFileSync(authinfoPath, [
			"# -*- mode: authinfo; -*-",
			"machine example.com login apikey password wrong-key",
			`machine ${GEMINI_API_HOST} login apikey password stored-key`,
		].join("\n"));

		expect(resolveGeminiApiKey({ env: {}, authinfoPath })).toBe("stored-key");
	});
});

describe("Gemini TTS endpoint", () => {
	test("builds the tested GenerateContent SSE URL", () => {
		expect(buildGeminiTtsUrl("models/gemini-3.1-flash-tts-preview")).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/" +
			"gemini-3.1-flash-tts-preview:streamGenerateContent?alt=sse",
		);
	});

	test("streams linear PCM in order and sends the selected voice", async () => {
		const writes: number[][] = [];
		let starts = 0;
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const sink: PlaybackStream = {
			writePcm: async (samples) => { writes.push(Array.from(samples)); },
			end: async () => {},
			cancel: () => {},
			done: async () => {},
		};
		const response = makeSseResponse([
			audioEvent([0x00]),
			audioEvent([0x00, 0xff, 0x7f]),
			{ candidates: [{ finishReason: "STOP" }] },
		], 7);

		const result = await geminiSpeak({
			text: "Hello from Talk.",
			model: "gemini-3.1-flash-tts-preview",
			voiceId: "Leda",
			sink,
			onAudioStart: () => { starts += 1; },
		}, {
			resolveApiKey: () => "test-key",
			fetchImpl: (async (input, init) => {
				requestUrl = String(input);
				requestInit = init;
				return response;
			}) as typeof fetch,
		});

		expect(requestUrl).toBe(buildGeminiTtsUrl("gemini-3.1-flash-tts-preview"));
		expect(new Headers(requestInit?.headers).get("x-goog-api-key")).toBe("test-key");
		const requestBody = JSON.parse(String(requestInit?.body));
		expect(requestBody.contents[0].parts[0].text).toBe("Hello from Talk.");
		expect(
			requestBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
		).toBe("Leda");
		expect(writes).toEqual([[0, 32767]]);
		expect(starts).toBe(1);
		expect(result.samples).toBeUndefined();
		expect(result.sampleRate).toBe(GEMINI_TTS_SAMPLE_RATE);
		expect(result.audioDurationMs).toBeCloseTo((2 / GEMINI_TTS_SAMPLE_RATE) * 1_000);
	});

	test("returns Float32 samples when streaming playback is unavailable", async () => {
		const result = await geminiSpeak({
			text: "Buffered fallback.",
			model: "gemini-3.1-flash-tts-preview",
			voiceId: "Leda",
		}, {
			resolveApiKey: () => "test-key",
			fetchImpl: (async () => makeSseResponse([
				audioEvent([0x00, 0x80, 0x00, 0x40]),
			])) as typeof fetch,
		});

		expect(result.samples?.[0]).toBe(-1);
		expect(result.samples?.[1]).toBeCloseTo(16384 / 32767);
	});

	test("rejects a response whose PCM rate cannot feed the Talk player", async () => {
		expect(geminiSpeak({
			text: "Wrong rate.",
			model: "gemini-3.1-flash-tts-preview",
			voiceId: "Leda",
		}, {
			resolveApiKey: () => "test-key",
			fetchImpl: (async () => makeSseResponse([
				audioEvent([0, 0], "audio/L16;codec=pcm;rate=16000"),
			])) as typeof fetch,
		})).rejects.toThrow(/16000 Hz audio/);
	});

	test("surfaces bounded HTTP errors without putting the key in the URL", async () => {
		let requestUrl = "";
		const error = await geminiSpeak({
			text: "Unauthorized.",
			model: "gemini-3.1-flash-tts-preview",
			voiceId: "Leda",
		}, {
			resolveApiKey: () => "secret-test-key",
			fetchImpl: (async (input) => {
				requestUrl = String(input);
				return new Response('{"error":{"message":"permission denied"}}', { status: 403 });
			}) as typeof fetch,
		}).catch((caught) => caught);
		expect(error).toBeInstanceOf(GeminiTtsHttpError);
		expect(error.status).toBe(403);
		expect(error.message).toMatch(/Gemini TTS HTTP 403/);
		expect(isGeminiTtsQuotaError(error)).toBe(false);
		expect(requestUrl).not.toContain("secret-test-key");
	});

	test("identifies HTTP 429 as quota exhaustion", () => {
		expect(isGeminiTtsQuotaError(new GeminiTtsHttpError(429, "quota exceeded"))).toBe(true);
		expect(isGeminiTtsQuotaError(new GeminiTtsHttpError(500, "server error"))).toBe(false);
		expect(isGeminiTtsQuotaError(new Error("Gemini TTS HTTP 429"))).toBe(false);
	});

	test("rejects successful responses that contain no audio", async () => {
		expect(geminiSpeak({
			text: "No output.",
			model: "gemini-3.1-flash-tts-preview",
			voiceId: "Leda",
		}, {
			resolveApiKey: () => "test-key",
			fetchImpl: (async () => makeSseResponse([
				{ candidates: [{ finishReason: "SAFETY" }] },
			])) as typeof fetch,
		})).rejects.toThrow(/no audio.*SAFETY/);
	});
});
