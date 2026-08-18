import { describe, expect, test } from "bun:test";
import { createEnergyVad, frameRmsDb } from "../extensions/voice/energy-vad";

const FRAME_SAMPLES = 512;

function toneFrame(amplitude = 8_000): Buffer {
	const frame = Buffer.alloc(FRAME_SAMPLES * 2);
	for (let index = 0; index < FRAME_SAMPLES; index++) {
		const sample = Math.round(Math.sin((2 * Math.PI * 220 * index) / 16_000) * amplitude);
		frame.writeInt16LE(sample, index * 2);
	}
	return frame;
}

function silenceFrame(): Buffer {
	return Buffer.alloc(FRAME_SAMPLES * 2);
}

describe("energy VAD", () => {
	test("silence never starts an utterance", () => {
		const vad = createEnergyVad();
		const events = Array.from({ length: 100 }, () => silenceFrame())
			.flatMap((frame) => vad.pushFrame(frame))
			.filter((event) => event.type !== "level");
		expect(events).toEqual([]);
		expect(vad.isSpeaking()).toBe(false);
	});

	test("speech is emitted after the configured trailing silence", () => {
		const vad = createEnergyVad({ hangoverMs: 500, minSpeechMs: 300 });
		const events = [
			...Array.from({ length: 16 }, () => toneFrame()),
			...Array.from({ length: 18 }, () => silenceFrame()),
		].flatMap((frame) => vad.pushFrame(frame));
		const speechEnd = events.find((event) => event.type === "speech_end");

		expect(events.some((event) => event.type === "speech_start")).toBe(true);
		expect(speechEnd?.type).toBe("speech_end");
		if (speechEnd?.type === "speech_end") {
			expect(speechEnd.pcm.length).toBeGreaterThan(16 * FRAME_SAMPLES * 2);
			expect(speechEnd.forced).toBe(false);
		}
	});

	test("short noise is discarded instead of transcribed", () => {
		const vad = createEnergyVad({ hangoverMs: 300, minSpeechMs: 300 });
		const events = [
			...Array.from({ length: 3 }, () => toneFrame()),
			...Array.from({ length: 12 }, () => silenceFrame()),
		].flatMap((frame) => vad.pushFrame(frame));
		expect(events.some((event) => event.type === "discarded")).toBe(true);
		expect(events.some((event) => event.type === "speech_confirmed")).toBe(false);
		expect(events.some((event) => event.type === "speech_end")).toBe(false);
	});

	test("sustained speech emits one confirmation for barge-in", () => {
		const vad = createEnergyVad({ confirmationMs: 250 });
		const events = Array.from({ length: 20 }, () => toneFrame())
			.flatMap((frame) => vad.pushFrame(frame));
		expect(events.filter((event) => event.type === "speech_confirmed")).toHaveLength(1);
	});

	test("maximum duration forces an endpoint", () => {
		const vad = createEnergyVad({ maxUtteranceMs: 1_000 });
		const events = Array.from({ length: 40 }, () => toneFrame())
			.flatMap((frame) => vad.pushFrame(frame));
		const speechEnd = events.find((event) => event.type === "speech_end");
		expect(speechEnd?.type).toBe("speech_end");
		if (speechEnd?.type === "speech_end") expect(speechEnd.forced).toBe(true);
	});

	test("RMS level distinguishes speech from silence", () => {
		expect(frameRmsDb(silenceFrame())).toBe(-Infinity);
		expect(frameRmsDb(toneFrame())).toBeGreaterThan(-20);
	});
});
