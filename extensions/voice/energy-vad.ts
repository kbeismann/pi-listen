/**
 * Frame-based energy VAD for the hands-free /talk loop.
 *
 * Audio tools emit arbitrary chunk sizes, so callers must split raw s16le
 * mono audio into fixed frames before calling pushFrame(). All timing is
 * derived from frame counts rather than wall-clock time.
 */

export interface EnergyVadOptions {
	sampleRateHz?: number;
	frameSamples?: number;
	startDb?: number;
	thresholdDb?: number;
	hangoverMs?: number;
	minSpeechMs?: number;
	maxUtteranceMs?: number;
	preRollMs?: number;
	startFrames?: number;
	confirmationMs?: number;
	endDeltaDb?: number;
	noiseFloorDb?: number;
	floorAlpha?: number;
	floorMinDb?: number;
	floorMaxDb?: number;
}

export type EnergyVadEvent =
	| { type: "level"; rmsDb: number }
	| { type: "speech_start" }
	| { type: "speech_confirmed" }
	| { type: "speech_end"; pcm: Buffer; durationMs: number; forced: boolean }
	| { type: "discarded"; durationMs: number; reason: "too-short" };

export const ENERGY_VAD_DEFAULTS = Object.freeze({
	sampleRateHz: 16_000,
	frameSamples: 512,
	startDb: 9,
	thresholdDb: undefined as number | undefined,
	hangoverMs: 500,
	minSpeechMs: 300,
	maxUtteranceMs: 30_000,
	preRollMs: 300,
	startFrames: 3,
	confirmationMs: undefined as number | undefined,
	endDeltaDb: 3,
	noiseFloorDb: -50,
	floorAlpha: 0.05,
	floorMinDb: -70,
	floorMaxDb: -30,
});

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function asInt16(frame: Buffer | Int16Array): Int16Array {
	if (frame instanceof Int16Array) return frame;
	return new Int16Array(frame.buffer, frame.byteOffset, Math.floor(frame.byteLength / 2));
}

export function frameRmsDb(frame: Buffer | Int16Array): number {
	const samples = asInt16(frame);
	if (samples.length === 0) return -Infinity;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index++) {
		const normalized = samples[index]! / 32_768;
		sumSquares += normalized * normalized;
	}
	const rms = Math.sqrt(sumSquares / samples.length);
	return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export function createEnergyVad(options: EnergyVadOptions = {}) {
	const config = { ...ENERGY_VAD_DEFAULTS, ...options };
	const frameMs = (config.frameSamples / config.sampleRateHz) * 1_000;
	const preRollFrames = Math.max(1, Math.ceil(config.preRollMs / frameMs));
	const hangoverFramesNeeded = Math.max(1, Math.ceil(config.hangoverMs / frameMs));
	const minSpeechFrames = Math.max(1, Math.ceil(config.minSpeechMs / frameMs));
	const confirmationFrames = Math.max(
		config.startFrames,
		Math.ceil((config.confirmationMs ?? config.minSpeechMs) / frameMs),
	);
	const maxUtteranceFrames = Math.max(minSpeechFrames, Math.ceil(config.maxUtteranceMs / frameMs));

	let speaking = false;
	let speechConfirmed = false;
	let noiseFloorDb = clamp(config.noiseFloorDb, config.floorMinDb, config.floorMaxDb);
	let speechFloorDb = noiseFloorDb;
	let consecutiveAbove = 0;
	let hangoverFrames = 0;
	let speechFrames = 0;
	let preRoll: Buffer[] = [];
	let utteranceFrames: Buffer[] = [];

	function startThresholdDb(): number {
		return Number.isFinite(config.thresholdDb) ? config.thresholdDb! : noiseFloorDb + config.startDb;
	}

	function endThresholdDb(): number {
		return Number.isFinite(config.thresholdDb)
			? config.thresholdDb! - config.startDb + config.endDeltaDb
			: speechFloorDb + config.endDeltaDb;
	}

	function updateNoiseFloor(rmsDb: number): void {
		if (!Number.isFinite(rmsDb)) return;
		noiseFloorDb = clamp(
			noiseFloorDb + config.floorAlpha * (rmsDb - noiseFloorDb),
			config.floorMinDb,
			config.floorMaxDb,
		);
	}

	function resetUtterance(): void {
		speaking = false;
		speechConfirmed = false;
		consecutiveAbove = 0;
		hangoverFrames = 0;
		speechFrames = 0;
		preRoll = [];
		utteranceFrames = [];
	}

	function finish(events: EnergyVadEvent[], forced: boolean): void {
		const effectiveSpeechFrames = speechFrames - (forced ? 0 : hangoverFrames);
		const durationMs = Math.round(utteranceFrames.length * frameMs);
		if (effectiveSpeechFrames >= minSpeechFrames) {
			events.push({
				type: "speech_end",
				pcm: Buffer.concat(utteranceFrames),
				durationMs,
				forced,
			});
		} else {
			events.push({ type: "discarded", durationMs, reason: "too-short" });
		}
		resetUtterance();
	}

	function pushFrame(frame: Buffer | Int16Array): EnergyVadEvent[] {
		const frameBuffer = Buffer.from(
			frame.buffer,
			frame.byteOffset,
			frame.byteLength,
		);
		const ownedFrame = Buffer.from(frameBuffer);
		const rmsDb = frameRmsDb(ownedFrame);
		const events: EnergyVadEvent[] = [{ type: "level", rmsDb }];

		if (!speaking) {
			preRoll.push(ownedFrame);
			if (preRoll.length > preRollFrames + config.startFrames) preRoll.shift();

			if (rmsDb > startThresholdDb()) {
				consecutiveAbove += 1;
				if (consecutiveAbove >= config.startFrames) {
					speaking = true;
					speechFloorDb = noiseFloorDb;
					utteranceFrames = [...preRoll];
					speechFrames = config.startFrames;
					hangoverFrames = 0;
					events.push({ type: "speech_start" });
				}
			} else {
				consecutiveAbove = 0;
				updateNoiseFloor(rmsDb);
			}
			return events;
		}

		utteranceFrames.push(ownedFrame);
		speechFrames += 1;
		if (rmsDb > endThresholdDb()) hangoverFrames = 0;
		else hangoverFrames += 1;
		if (!speechConfirmed && speechFrames - hangoverFrames >= confirmationFrames) {
			speechConfirmed = true;
			events.push({ type: "speech_confirmed" });
		}

		if (hangoverFrames >= hangoverFramesNeeded) finish(events, false);
		else if (utteranceFrames.length >= maxUtteranceFrames) finish(events, true);
		return events;
	}

	function reset(options: { keepNoiseFloor?: boolean } = {}): void {
		if (options.keepNoiseFloor === false) {
			noiseFloorDb = clamp(config.noiseFloorDb, config.floorMinDb, config.floorMaxDb);
		}
		resetUtterance();
	}

	return {
		frameBytes: config.frameSamples * 2,
		frameMs,
		pushFrame,
		reset,
		isSpeaking: () => speaking,
		getNoiseFloorDb: () => noiseFloorDb,
	};
}
