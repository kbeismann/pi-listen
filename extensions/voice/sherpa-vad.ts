/**
 * Neural speech validation for /talk using sherpa-onnx's Silero VAD.
 *
 * Energy remains useful for inexpensive buffering and endpoint timing, but it
 * cannot distinguish speech from breathing, typing, or other sustained sound.
 * This detector runs beside the energy endpoint and must recognize speech
 * before audio may cancel TTS or reach the transcription model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureModelDownloaded, getModelDir } from "./model-download";
import { getSherpaError, getSherpaModule, loadSherpa } from "./sherpa-loader";

export const SHERPA_VAD_MODEL = Object.freeze({
	id: "silero-vad",
	fileName: "silero_vad.onnx",
	url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
	sizeBytes: 643_854,
});

const SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 512;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const DEFAULT_THRESHOLD = 0.5;

export interface SpeechDetector {
	readonly frameBytes: number;
	/** Accept one 16 kHz mono s16le frame and report current neural speech detection. */
	pushFrame(frame: Buffer): boolean;
	reset(): void;
}

export interface SherpaSpeechDetectorOptions {
	modelPath?: string;
	threshold?: number;
	minSpeechMs: number;
	minSilenceMs: number;
	maxSpeechMs: number;
}

interface NativeVad {
	acceptWaveform(samples: Float32Array): void;
	isDetected(): boolean;
	isEmpty(): boolean;
	pop(): void;
	reset(): void;
}

interface SherpaVadRuntime {
	fileExists(filePath: string): boolean;
	createVad(config: Record<string, unknown>, bufferSizeInSeconds: number): NativeVad;
}

function defaultRuntime(): SherpaVadRuntime {
	return {
		fileExists: fs.existsSync,
		createVad(config, bufferSizeInSeconds) {
			const sherpa = getSherpaModule();
			if (typeof sherpa?.Vad !== "function") {
				throw new Error("The installed sherpa-onnx runtime does not expose neural VAD support.");
			}
			return new sherpa.Vad(config, bufferSizeInSeconds) as NativeVad;
		},
	};
}

export function getSherpaVadModelPath(): string {
	return path.join(getModelDir(SHERPA_VAD_MODEL.id), SHERPA_VAD_MODEL.fileName);
}

/** Ensure the small local VAD model and native runtime are ready before capture starts. */
export async function prepareSherpaVad(signal?: AbortSignal): Promise<string> {
	if (!await loadSherpa()) {
		throw new Error(`sherpa-onnx VAD is unavailable: ${getSherpaError() ?? "unknown error"}`);
	}
	const modelDir = await ensureModelDownloaded(
		SHERPA_VAD_MODEL.id,
		{ model: SHERPA_VAD_MODEL.url },
		SHERPA_VAD_MODEL.sizeBytes,
		undefined,
		signal,
	);
	return path.join(modelDir, SHERPA_VAD_MODEL.fileName);
}

/** Create the continuously reused detector after prepareSherpaVad() succeeds. */
export function createSherpaSpeechDetector(
	options: SherpaSpeechDetectorOptions,
	runtime: SherpaVadRuntime = defaultRuntime(),
): SpeechDetector {
	const modelPath = options.modelPath ?? getSherpaVadModelPath();
	if (!runtime.fileExists(modelPath)) {
		throw new Error(`Silero VAD model is missing at ${modelPath}. Run /talk on again to download it.`);
	}

	const minSpeechSeconds = options.minSpeechMs / 1_000;
	const minSilenceSeconds = options.minSilenceMs / 1_000;
	const maxSpeechSeconds = options.maxSpeechMs / 1_000;
	const bufferSizeInSeconds = Math.max(
		10,
		Math.ceil(maxSpeechSeconds + minSilenceSeconds + 1),
	);
	const vad = runtime.createVad({
		sileroVad: {
			model: modelPath,
			threshold: options.threshold ?? DEFAULT_THRESHOLD,
			minSilenceDuration: minSilenceSeconds,
			minSpeechDuration: minSpeechSeconds,
			windowSize: FRAME_SAMPLES,
			maxSpeechDuration: maxSpeechSeconds,
		},
		sampleRate: SAMPLE_RATE_HZ,
		numThreads: 1,
		provider: "cpu",
	}, bufferSizeInSeconds);

	function drainCompletedSegments(): void {
		// /talk's energy endpoint owns PCM buffering. Drain native segments so
		// the classifier's circular buffer cannot grow across many utterances.
		while (!vad.isEmpty()) vad.pop();
	}

	return {
		frameBytes: FRAME_BYTES,
		pushFrame(frame: Buffer): boolean {
			if (frame.byteLength !== FRAME_BYTES) {
				throw new Error(`Silero VAD requires ${FRAME_BYTES}-byte frames; received ${frame.byteLength}.`);
			}
			const samples = new Float32Array(FRAME_SAMPLES);
			for (let index = 0; index < FRAME_SAMPLES; index++) {
				samples[index] = frame.readInt16LE(index * 2) / 32_768;
			}
			vad.acceptWaveform(samples);
			const detected = vad.isDetected();
			drainCompletedSegments();
			return detected;
		},
		reset(): void {
			vad.reset();
			drainCompletedSegments();
		},
	};
}
