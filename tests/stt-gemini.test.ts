import { describe, expect, test } from "bun:test";
import {
	GEMINI_STT_URL,
	GeminiSttHttpError,
	GeminiSttServiceError,
	isGeminiSttFallbackError,
	transcribeGeminiPcm,
} from "../extensions/voice/stt-gemini";

function completedInteraction(text: string): Response {
	return Response.json({
		status: "completed",
		steps: [{
			type: "model_output",
			content: [{ type: "text", text }],
		}],
	});
}

describe("Gemini STT", () => {
	test("sends one inline WAV utterance in verbatim mode with vocabulary hints", async () => {
		const pcm = Buffer.from([0x34, 0x12, 0xcc, 0xff]);
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const transcript = await transcribeGeminiPcm({
			pcm,
			model: " models/gemini-3.5-transcribe ",
			vocabulary: [" Pi ", "chezmoi", "Pi"],
		}, {
			resolveApiKey: () => "secret-test-key",
			fetchImpl: (async (input, init) => {
				requestUrl = String(input);
				requestInit = init;
				return completedInteraction("  Keep the exact command.  ");
			}) as typeof fetch,
		});

		expect(transcript).toBe("Keep the exact command.");
		expect(requestUrl).toBe(GEMINI_STT_URL);
		expect(requestUrl).not.toContain("secret-test-key");
		expect(new Headers(requestInit?.headers).get("x-goog-api-key")).toBe("secret-test-key");
		const body = JSON.parse(String(requestInit?.body));
		expect(body.model).toBe("gemini-3.5-transcribe");
		expect(body.store).toBe(false);
		expect(body.generation_config.transcription_config).toEqual({
			language_codes: [],
			mode: { type: "verbatim" },
			custom_vocabulary: ["Pi", "chezmoi"],
		});
		expect(body.input[0].type).toBe("audio");
		expect(body.input[0].mime_type).toBe("audio/wav");

		const wav = Buffer.from(body.input[0].data, "base64");
		expect(wav.subarray(0, 4).toString()).toBe("RIFF");
		expect(wav.subarray(8, 12).toString()).toBe("WAVE");
		expect(wav.readUInt16LE(22)).toBe(1);
		expect(wav.readUInt32LE(24)).toBe(16_000);
		expect(wav.readUInt16LE(34)).toBe(16);
		expect(wav.readUInt32LE(40)).toBe(pcm.byteLength);
		expect(wav.subarray(44)).toEqual(pcm);
	});

	test("does not call Gemini for an empty utterance", async () => {
		let fetchCount = 0;
		expect(await transcribeGeminiPcm({
			pcm: Buffer.alloc(0),
			model: "gemini-3.5-transcribe",
		}, {
			resolveApiKey: () => null,
			fetchImpl: (async () => {
				fetchCount += 1;
				return completedInteraction("unexpected");
			}) as typeof fetch,
		})).toBe("");
		expect(fetchCount).toBe(0);
	});

	test("classifies quota, service, and network failures for local fallback", async () => {
		const quotaError = await transcribeGeminiPcm({
			pcm: Buffer.alloc(2),
			model: "gemini-3.5-transcribe",
		}, {
			resolveApiKey: () => "test-key",
			fetchImpl: (async () => new Response("quota exceeded", { status: 429 })) as typeof fetch,
		}).catch((error) => error);
		expect(quotaError).toBeInstanceOf(GeminiSttHttpError);
		expect(isGeminiSttFallbackError(quotaError)).toBe(true);
		expect(isGeminiSttFallbackError(new GeminiSttHttpError(503))).toBe(true);
		expect(isGeminiSttFallbackError(new GeminiSttHttpError(408))).toBe(false);
		expect(isGeminiSttFallbackError(new GeminiSttHttpError(403))).toBe(false);

		const networkError = await transcribeGeminiPcm({
			pcm: Buffer.alloc(2),
			model: "gemini-3.5-transcribe",
		}, {
			resolveApiKey: () => "test-key",
			fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch,
		}).catch((error) => error);
		expect(networkError).toBeInstanceOf(GeminiSttServiceError);
		expect(isGeminiSttFallbackError(networkError)).toBe(true);
	});

	test("treats a malformed successful response as a service failure", async () => {
		const error = await transcribeGeminiPcm({
			pcm: Buffer.alloc(2),
			model: "gemini-3.5-transcribe",
		}, {
			resolveApiKey: () => "test-key",
			fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(GeminiSttServiceError);
		expect(isGeminiSttFallbackError(error)).toBe(true);
	});

	test("falls back when a completed interaction contains no transcript", async () => {
		const error = await transcribeGeminiPcm({
			pcm: Buffer.alloc(2),
			model: "gemini-3.5-transcribe",
		}, {
			resolveApiKey: () => "test-key",
			fetchImpl: (async () => Response.json({ status: "completed", steps: [] })) as typeof fetch,
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(GeminiSttServiceError);
		expect(isGeminiSttFallbackError(error)).toBe(true);
	});

	test("preserves request cancellation instead of converting it to fallback", async () => {
		const controller = new AbortController();
		controller.abort();
		const error = await transcribeGeminiPcm({
			pcm: Buffer.alloc(2),
			model: "gemini-3.5-transcribe",
			signal: controller.signal,
		}, {
			resolveApiKey: () => "test-key",
		}).catch((caught) => caught);

		expect(error.name).toBe("AbortError");
		expect(isGeminiSttFallbackError(error)).toBe(false);
	});
});
