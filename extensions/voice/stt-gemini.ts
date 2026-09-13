/**
 * Gemini Developer API batch speech-to-text client for Talk mode.
 *
 * Talk completes local energy endpointing and Silero speech validation before
 * calling this client. The cheapest unary Transcribe endpoint therefore sees
 * only a completed speech utterance rather than an always-open microphone.
 * Small Talk recordings are sent inline as WAV data, avoiding temporary files
 * and the Gemini Files API's remote retention window.
 */

import { SAMPLE_RATE } from "./deepgram";
import { encodeMonoPcm16leWav } from "./pcm-wav";
import { GEMINI_API_HOST, resolveGeminiApiKey } from "./tts-gemini";

export const GEMINI_STT_URL = `https://${GEMINI_API_HOST}/v1beta/interactions`;

// Inline Interactions requests allow 20 MB in total. Talk's configurable
// 120-second ceiling is about 3.8 MB of PCM, but retain a defensive bound for
// direct callers before base64 expansion creates another full-size copy.
const GEMINI_STT_MAX_PCM_BYTES = 12_000_000;
const GEMINI_STT_MAX_REQUEST_BYTES = 20_000_000;
const GEMINI_STT_MAX_VOCABULARY_TERMS = 1_000;
const GEMINI_STT_MAX_RESPONSE_CHARS = 1_000_000;

export interface GeminiTranscribeOptions {
	pcm: Buffer;
	model: string;
	vocabulary?: readonly string[];
	signal?: AbortSignal;
}

export interface GeminiTranscribeDependencies {
	fetchImpl?: typeof fetch;
	resolveApiKey?: () => string | null;
}

/** Preserve HTTP status so Talk can distinguish transient remote failures. */
export class GeminiSttHttpError extends Error {
	constructor(
		readonly status: number,
		responseBody = "",
	) {
		super(`Gemini STT HTTP ${status}${responseBody ? `: ${responseBody}` : ""}`);
		this.name = "GeminiSttHttpError";
	}
}

/** A network or successful-response failure that local STT can safely cover. */
export class GeminiSttServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GeminiSttServiceError";
	}
}

/**
 * Fall back only when retrying the same remote configuration could reasonably
 * recover. Authentication and request errors stay visible instead of being
 * hidden behind a working local transcript.
 */
export function isGeminiSttFallbackError(error: unknown): boolean {
	return error instanceof GeminiSttServiceError
		|| (error instanceof GeminiSttHttpError
			&& (error.status === 429 || error.status >= 500));
}

/** Transcribe one locally validated 16 kHz mono s16le utterance. */
export async function transcribeGeminiPcm(
	options: GeminiTranscribeOptions,
	dependencies: GeminiTranscribeDependencies = {},
): Promise<string> {
	if (options.pcm.byteLength === 0) return "";
	if (options.pcm.byteLength > GEMINI_STT_MAX_PCM_BYTES) {
		throw new Error(
			`Gemini STT audio exceeds the ${GEMINI_STT_MAX_PCM_BYTES}-byte inline limit.`,
		);
	}
	if (options.signal?.aborted) throw makeAbortError();

	const model = validateModel(options.model);
	const vocabulary = normalizeVocabulary(options.vocabulary);
	const apiKey = dependencies.resolveApiKey
		? dependencies.resolveApiKey()
		: resolveGeminiApiKey();
	if (!apiKey) {
		throw new Error(
			"Gemini API key not found. Export GEMINI_API_KEY or add the "
			+ `${GEMINI_API_HOST} machine entry to ~/.authinfo.`,
		);
	}

	const wav = encodeMonoPcm16leWav(options.pcm, SAMPLE_RATE);
	const transcriptionConfig: Record<string, unknown> = {
		language_codes: [],
		// Verbatim preserves corrections and command wording instead of asking an
		// LLM-oriented cleanup pass to reinterpret coding instructions.
		mode: { type: "verbatim" },
	};
	if (vocabulary.length > 0) transcriptionConfig.custom_vocabulary = vocabulary;

	const requestBody = JSON.stringify({
		model,
		// The interaction is used only for this utterance; do not retain it for
		// later retrieval through the Interactions API.
		store: false,
		input: [{
			type: "audio",
			data: wav.toString("base64"),
			mime_type: "audio/wav",
		}],
		generation_config: {
			transcription_config: transcriptionConfig,
		},
	});
	if (Buffer.byteLength(requestBody) > GEMINI_STT_MAX_REQUEST_BYTES) {
		throw new Error("Gemini STT request exceeds the 20 MB inline limit.");
	}

	let response: Response;
	try {
		response = await (dependencies.fetchImpl ?? fetch)(GEMINI_STT_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-goog-api-key": apiKey,
			},
			body: requestBody,
			signal: options.signal,
		});
	} catch (error: any) {
		if (error?.name === "AbortError") throw error;
		throw new GeminiSttServiceError(
			`Gemini STT network error: ${error?.message ?? String(error)}`,
		);
	}

	let responseText: string;
	try {
		responseText = await response.text();
	} catch (error: any) {
		if (error?.name === "AbortError") throw error;
		throw new GeminiSttServiceError(
			`Gemini STT response error: ${error?.message ?? String(error)}`,
		);
	}

	if (!response.ok) {
		throw new GeminiSttHttpError(response.status, responseText.trim().slice(0, 300));
	}
	if (responseText.length > GEMINI_STT_MAX_RESPONSE_CHARS) {
		throw new GeminiSttServiceError("Gemini STT returned an oversized response.");
	}

	let interaction: unknown;
	try {
		interaction = JSON.parse(responseText);
	} catch {
		throw new GeminiSttServiceError("Gemini STT returned malformed JSON.");
	}

	const status = readStringField(interaction, "status");
	if (status === "failed" || status === "cancelled") {
		const detail = readInteractionError(interaction);
		throw new GeminiSttServiceError(
			`Gemini STT interaction ${status}${detail ? `: ${detail}` : "."}`,
		);
	}
	if (status && status !== "completed" && status !== "incomplete") {
		throw new GeminiSttServiceError(`Gemini STT returned unexpected status ${status}.`);
	}

	const text = extractInteractionText(interaction).trim();
	if (!text) {
		throw new GeminiSttServiceError("Gemini STT returned no transcript.");
	}
	return text;
}

function validateModel(value: unknown): string {
	if (typeof value !== "string") throw new Error("Gemini STT model is required.");
	const model = value.trim().replace(/^models\//, "");
	if (!model) throw new Error("Gemini STT model is required.");
	return model;
}

function normalizeVocabulary(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	if (values.length > GEMINI_STT_MAX_VOCABULARY_TERMS) {
		throw new Error(
			`Gemini STT vocabulary exceeds ${GEMINI_STT_MAX_VOCABULARY_TERMS} terms.`,
		);
	}
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const term = value.trim();
		if (!term || seen.has(term)) continue;
		seen.add(term);
		normalized.push(term);
	}
	return normalized;
}

function extractInteractionText(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const interaction = value as any;
	if (typeof interaction.output_text === "string") return interaction.output_text;

	const textBlocks: string[] = [];
	const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
	for (const step of steps) {
		if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
		for (const content of step.content) {
			if (content?.type === "text" && typeof content.text === "string") {
				textBlocks.push(content.text);
			}
		}
	}
	if (textBlocks.length > 0) return textBlocks.join("");

	// Early Interactions examples called the same collection `outputs`.
	const outputs = Array.isArray(interaction.outputs) ? interaction.outputs : [];
	return outputs
		.filter((output: any) => output?.type === "text" && typeof output.text === "string")
		.map((output: any) => output.text as string)
		.join("");
}

function readStringField(value: unknown, field: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = (value as Record<string, unknown>)[field];
	return typeof candidate === "string" ? candidate : undefined;
}

function readInteractionError(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const errors = (value as any).errors;
	if (!Array.isArray(errors)) return undefined;
	for (const error of errors) {
		if (typeof error?.message === "string" && error.message.trim()) {
			return error.message.trim().slice(0, 300);
		}
	}
	return undefined;
}

function makeAbortError(): Error {
	if (typeof DOMException === "function") {
		return new DOMException("Gemini STT aborted", "AbortError");
	}
	const error = new Error("Gemini STT aborted");
	error.name = "AbortError";
	return error;
}
