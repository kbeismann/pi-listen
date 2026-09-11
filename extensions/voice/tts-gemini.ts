/**
 * Gemini Developer API text-to-speech client for Talk mode.
 *
 * The Interactions API currently delivers preview TTS audio slower than real
 * time for this workflow. Use the GenerateContent SSE endpoint instead: it
 * emits the same 24 kHz mono linear PCM quickly enough to feed Talk's existing
 * streaming player without underruns.
 *
 * Authentication is deliberately outside settings.json. The client first
 * checks GEMINI_API_KEY, then the exact generativelanguage.googleapis.com
 * machine entry in ~/.authinfo. Keeping the key out of Pi settings prevents a
 * project-scoped voice configuration from persisting a reusable secret.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlaybackStream } from "./tts-playback";

export const GEMINI_API_HOST = "generativelanguage.googleapis.com";
export const GEMINI_TTS_SAMPLE_RATE = 24_000;
export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
export const DEFAULT_GEMINI_TTS_VOICE = "Leda";

const GEMINI_API_ROOT = `https://${GEMINI_API_HOST}/v1beta`;
const GEMINI_TTS_MAX_AUDIO_BYTES = 75_000_000;
const GEMINI_TTS_MAX_SSE_EVENT_CHARS = 5_000_000;

export interface GeminiApiKeyOptions {
	env?: NodeJS.ProcessEnv;
	authinfoPath?: string;
}

export interface GeminiSpeakOpts {
	text: string;
	model: string;
	voiceId: string;
	signal?: AbortSignal;
	/** Optional caller-owned 24 kHz mono PCM sink for immediate playback. */
	sink?: PlaybackStream;
	/** Called immediately before the first PCM samples enter a streaming sink. */
	onAudioStart?: () => void;
}

export interface GeminiSpeakResult {
	/** Complete PCM for file-based fallback; omitted when audio streamed to sink. */
	samples?: Float32Array;
	sampleRate: number;
	audioDurationMs: number;
}

export interface GeminiSpeakDependencies {
	fetchImpl?: typeof fetch;
	resolveApiKey?: () => string | null;
}

/** Resolve the Developer API key without copying it into voice configuration. */
export function resolveGeminiApiKey(options: GeminiApiKeyOptions = {}): string | null {
	const env = options.env ?? process.env;
	const envKey = env.GEMINI_API_KEY?.trim();
	if (envKey) return envKey;

	const authinfoPath = options.authinfoPath ?? path.join(os.homedir(), ".authinfo");
	let authinfo: string;
	try {
		authinfo = fs.readFileSync(authinfoPath, "utf8");
	} catch {
		return null;
	}

	return findAuthinfoPassword(authinfo, GEMINI_API_HOST);
}

/** Return the configured key or fail before Talk starts capturing audio. */
export function requireGeminiApiKey(options: GeminiApiKeyOptions = {}): string {
	const apiKey = resolveGeminiApiKey(options);
	if (apiKey) return apiKey;
	throw missingGeminiApiKeyError();
}

/** Build the tested SSE endpoint without placing the API key in the URL. */
export function buildGeminiTtsUrl(model: string): string {
	const normalized = model.trim().replace(/^models\//, "");
	if (!normalized) throw new Error("Gemini TTS model is required.");
	return `${GEMINI_API_ROOT}/models/${encodeURIComponent(normalized)}:streamGenerateContent?alt=sse`;
}

/**
 * Synthesize one text fragment and either stream its PCM to `sink` or return a
 * complete Float32 buffer for the existing file-based playback fallback.
 */
export async function geminiSpeak(
	opts: GeminiSpeakOpts,
	dependencies: GeminiSpeakDependencies = {},
): Promise<GeminiSpeakResult> {
	const text = validateNonEmptyString(opts.text, "text");
	const model = validateNonEmptyString(opts.model, "model");
	const voiceId = validateNonEmptyString(opts.voiceId, "voiceId");
	if (opts.signal?.aborted) throw makeAbortError();

	const apiKey = dependencies.resolveApiKey
		? dependencies.resolveApiKey()
		: resolveGeminiApiKey();
	if (!apiKey) throw missingGeminiApiKeyError();

	let response: Response;
	try {
		response = await (dependencies.fetchImpl ?? fetch)(buildGeminiTtsUrl(model), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "text/event-stream",
				"x-goog-api-key": apiKey,
			},
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text }] }],
				generationConfig: {
					responseModalities: ["AUDIO"],
					speechConfig: {
						voiceConfig: {
							prebuiltVoiceConfig: { voiceName: voiceId },
						},
					},
				},
			}),
			signal: opts.signal,
		});
	} catch (error: any) {
		if (error?.name === "AbortError") throw error;
		throw new Error(`Gemini TTS network error: ${error?.message ?? String(error)}`);
	}

	if (!response.ok) {
		let body = "";
		try { body = (await response.text()).trim().slice(0, 300); } catch { /* response body unavailable */ }
		throw new Error(`Gemini TTS HTTP ${response.status}${body ? `: ${body}` : ""}`);
	}

	const sampleChunks: Float32Array[] = [];
	let totalAudioBytes = 0;
	let totalSamples = 0;
	let pendingLowByte: number | undefined;
	let audioStarted = false;
	let finishReason: string | undefined;

	await consumeSse(response.body, async (payload) => {
		const apiError = readApiError(payload);
		if (apiError) throw new Error(`Gemini TTS API error: ${apiError}`);

		for (const candidate of readCandidates(payload)) {
			if (typeof candidate?.finishReason === "string") finishReason = candidate.finishReason;
			const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
			for (const part of parts) {
				const inlineData = part?.inlineData;
				if (!inlineData || typeof inlineData.data !== "string") continue;
				assertGeminiPcmMimeType(inlineData.mimeType);

				const bytes = decodeBase64(inlineData.data);
				totalAudioBytes += bytes.byteLength;
				if (totalAudioBytes > GEMINI_TTS_MAX_AUDIO_BYTES) {
					throw new Error(
						`Gemini TTS response exceeded ${GEMINI_TTS_MAX_AUDIO_BYTES} audio bytes.`,
					);
				}

				const decoded = decodeLinear16(bytes, pendingLowByte);
				pendingLowByte = decoded.pendingLowByte;
				if (decoded.samples.length === 0) continue;
				totalSamples += decoded.samples.length;

				if (opts.sink) {
					if (!audioStarted) {
						audioStarted = true;
						opts.onAudioStart?.();
					}
					await opts.sink.writePcm(decoded.samples);
				} else {
					sampleChunks.push(int16ToFloat32(decoded.samples));
				}
			}
		}
	});

	if (pendingLowByte !== undefined) {
		throw new Error("Gemini TTS returned an odd number of linear PCM bytes.");
	}
	if (totalSamples === 0) {
		throw new Error(
			`Gemini TTS returned no audio${finishReason ? ` (finish reason: ${finishReason})` : ""}.`,
		);
	}

	return {
		...(opts.sink ? {} : { samples: concatenateFloat32(sampleChunks, totalSamples) }),
		sampleRate: GEMINI_TTS_SAMPLE_RATE,
		audioDurationMs: (totalSamples / GEMINI_TTS_SAMPLE_RATE) * 1_000,
	};
}

function validateNonEmptyString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Gemini TTS ${name} is required.`);
	}
	return value.trim();
}

function findAuthinfoPassword(authinfo: string, machine: string): string | null {
	const tokens = authinfo
		.split(/\r?\n/)
		.filter((line) => !line.trimStart().startsWith("#"))
		.flatMap((line) => line.trim().split(/\s+/).filter(Boolean));

	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index] !== "machine" || tokens[index + 1] !== machine) continue;
		for (
			let field = index + 2;
			field < tokens.length && tokens[field] !== "machine" && tokens[field] !== "default";
			field++
		) {
			if (tokens[field] === "password") {
				const password = tokens[field + 1]?.trim();
				return password || null;
			}
		}
	}
	return null;
}

function missingGeminiApiKeyError(): Error {
	return new Error(
		"Gemini API key not found. Export GEMINI_API_KEY or add the " +
		`${GEMINI_API_HOST} machine entry to ~/.authinfo.`,
	);
}

function assertGeminiPcmMimeType(value: unknown): void {
	if (typeof value !== "string" || !/^audio\/L16(?:;|$)/i.test(value)) {
		throw new Error(`Gemini TTS returned unsupported audio type: ${String(value)}`);
	}
	const rate = /(?:^|;)\s*rate=(\d+)(?:;|$)/i.exec(value)?.[1];
	if (Number(rate) !== GEMINI_TTS_SAMPLE_RATE) {
		throw new Error(
			`Gemini TTS returned ${rate ?? "unknown"} Hz audio; expected ${GEMINI_TTS_SAMPLE_RATE} Hz.`,
		);
	}
}

function decodeBase64(value: string): Uint8Array {
	const encoded = value.trim();
	if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
		throw new Error("Gemini TTS returned invalid base64 audio.");
	}
	return Buffer.from(encoded, "base64");
}

function decodeLinear16(
	bytes: Uint8Array,
	pendingLowByte: number | undefined,
): { samples: Int16Array; pendingLowByte: number | undefined } {
	const combinedLength = bytes.length + (pendingLowByte === undefined ? 0 : 1);
	const completeLength = combinedLength - (combinedLength % 2);
	const completeBytes = new Uint8Array(completeLength);
	let sourceOffset = 0;
	let targetOffset = 0;
	if (pendingLowByte !== undefined && completeLength > 0) {
		completeBytes[0] = pendingLowByte;
		targetOffset = 1;
	}
	const copyLength = completeLength - targetOffset;
	completeBytes.set(bytes.subarray(0, copyLength), targetOffset);
	sourceOffset = copyLength;

	const nextPendingLowByte = sourceOffset < bytes.length
		? bytes[sourceOffset]
		: undefined;
	const view = new DataView(completeBytes.buffer);
	const samples = new Int16Array(completeLength / 2);
	for (let index = 0; index < samples.length; index++) {
		samples[index] = view.getInt16(index * 2, true);
	}
	return { samples, pendingLowByte: nextPendingLowByte };
}

function int16ToFloat32(samples: Int16Array): Float32Array {
	const output = new Float32Array(samples.length);
	for (let index = 0; index < samples.length; index++) {
		const sample = samples[index]!;
		output[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
	}
	return output;
}

function concatenateFloat32(chunks: Float32Array[], totalSamples: number): Float32Array {
	const output = new Float32Array(totalSamples);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

async function consumeSse(
	body: ReadableStream<Uint8Array> | null,
	onPayload: (payload: unknown) => Promise<void>,
): Promise<void> {
	if (!body) throw new Error("Gemini TTS response had no event stream.");
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) buffer += decoder.decode(value, { stream: true });
			buffer = await consumeCompleteEvents(buffer, onPayload);
			if (buffer.length > GEMINI_TTS_MAX_SSE_EVENT_CHARS) {
				throw new Error("Gemini TTS returned an oversized SSE event.");
			}
		}
		buffer += decoder.decode();
		buffer = await consumeCompleteEvents(buffer, onPayload);
		if (buffer.trim()) await consumeEvent(buffer, onPayload);
	} catch (error) {
		try { await reader.cancel(); } catch { /* stream already closed */ }
		throw error;
	} finally {
		try { reader.releaseLock(); } catch { /* stream already released */ }
	}
}

async function consumeCompleteEvents(
	buffer: string,
	onPayload: (payload: unknown) => Promise<void>,
): Promise<string> {
	while (true) {
		const boundary = findEventBoundary(buffer);
		if (!boundary) return buffer;
		await consumeEvent(buffer.slice(0, boundary.index), onPayload);
		buffer = buffer.slice(boundary.index + boundary.length);
	}
}

function findEventBoundary(buffer: string): { index: number; length: number } | null {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf < 0 && crlf < 0) return null;
	if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
	return { index: lf, length: 2 };
}

async function consumeEvent(
	event: string,
	onPayload: (payload: unknown) => Promise<void>,
): Promise<void> {
	const data = event
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n");
	if (!data || data === "[DONE]") return;
	let payload: unknown;
	try {
		payload = JSON.parse(data);
	} catch {
		throw new Error("Gemini TTS returned malformed SSE JSON.");
	}
	await onPayload(payload);
}

function readCandidates(payload: unknown): any[] {
	if (!payload || typeof payload !== "object") return [];
	const candidates = (payload as any).candidates;
	return Array.isArray(candidates) ? candidates : [];
}

function readApiError(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const error = (payload as any).error;
	if (!error) return null;
	if (typeof error === "string") return error.slice(0, 300);
	if (typeof error.message === "string") return error.message.slice(0, 300);
	return "unknown error";
}

function makeAbortError(): Error {
	if (typeof DOMException === "function") {
		return new DOMException("Gemini TTS aborted", "AbortError");
	}
	const error = new Error("Gemini TTS aborted");
	(error as any).name = "AbortError";
	return error;
}
