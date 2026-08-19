import { describe, expect, test } from "bun:test";
import {
	createSherpaSpeechDetector,
	getSherpaVadModelPath,
	SHERPA_VAD_MODEL,
} from "../extensions/voice/sherpa-vad";

class FakeNativeVad {
	accepted: Float32Array[] = [];
	detected = false;
	queuedSegments = 0;
	resetCount = 0;

	acceptWaveform(samples: Float32Array): void {
		this.accepted.push(samples);
	}
	isDetected(): boolean { return this.detected; }
	isEmpty(): boolean { return this.queuedSegments === 0; }
	pop(): void { this.queuedSegments -= 1; }
	reset(): void { this.resetCount += 1; }
}

function makeDetector() {
	const nativeVad = new FakeNativeVad();
	let nativeConfig: Record<string, any> | undefined;
	let bufferSizeInSeconds: number | undefined;
	const detector = createSherpaSpeechDetector({
		modelPath: "/tmp/silero_vad.onnx",
		minSpeechMs: 300,
		minSilenceMs: 900,
		maxSpeechMs: 30_000,
	}, {
		fileExists: () => true,
		createVad(config, bufferSize) {
			nativeConfig = config;
			bufferSizeInSeconds = bufferSize;
			return nativeVad;
		},
	});
	return { detector, nativeVad, get nativeConfig() { return nativeConfig; }, get bufferSizeInSeconds() { return bufferSizeInSeconds; } };
}

describe("Sherpa neural VAD", () => {
	test("uses the official local Silero model artifact", () => {
		expect(SHERPA_VAD_MODEL.url).toBe(
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
		);
		expect(SHERPA_VAD_MODEL.sizeBytes).toBeGreaterThan(0);
		expect(getSherpaVadModelPath()).toEndWith("silero-vad/silero_vad.onnx");
	});

	test("maps talk endpoint timing into the native Silero configuration", () => {
		const harness = makeDetector();

		expect(harness.nativeConfig?.sileroVad).toMatchObject({
			model: "/tmp/silero_vad.onnx",
			threshold: 0.5,
			minSpeechDuration: 0.3,
			minSilenceDuration: 0.9,
			maxSpeechDuration: 30,
			windowSize: 512,
		});
		expect(harness.nativeConfig?.sampleRate).toBe(16_000);
		expect(harness.bufferSizeInSeconds).toBeGreaterThan(30);
	});

	test("converts one s16le frame and drains completed native segments", () => {
		const { detector, nativeVad } = makeDetector();
		const frame = Buffer.alloc(detector.frameBytes);
		frame.writeInt16LE(-32_768, 0);
		frame.writeInt16LE(16_384, 2);
		frame.writeInt16LE(32_767, 4);
		nativeVad.detected = true;
		nativeVad.queuedSegments = 2;

		expect(detector.pushFrame(frame)).toBe(true);
		expect(nativeVad.accepted).toHaveLength(1);
		expect(nativeVad.accepted[0]![0]).toBe(-1);
		expect(nativeVad.accepted[0]![1]).toBe(0.5);
		expect(nativeVad.accepted[0]![2]).toBeCloseTo(32_767 / 32_768);
		expect(nativeVad.queuedSegments).toBe(0);
	});

	test("resets native state and rejects mismatched frames", () => {
		const { detector, nativeVad } = makeDetector();

		expect(() => detector.pushFrame(Buffer.alloc(100))).toThrow("1024-byte frames");
		detector.reset();
		expect(nativeVad.resetCount).toBe(1);
	});
});
