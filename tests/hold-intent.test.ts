import { describe, expect, test } from "bun:test";
import {
	HOLD_INTENT_DELAY_MS,
	remainingHoldIntentDelay,
} from "../extensions/voice/hold-intent";

describe("hold-to-talk intent delay", () => {
	test("waits 300ms before exposing warmup", () => {
		expect(HOLD_INTENT_DELAY_MS).toBe(300);
		expect(remainingHoldIntentDelay(1_000, 1_000, 1_200)).toBe(300);
		expect(remainingHoldIntentDelay(1_000, 1_299, 1_200)).toBe(1);
		expect(remainingHoldIntentDelay(1_000, 1_300, 1_200)).toBe(0);
		expect(remainingHoldIntentDelay(1_000, 1_500, 1_200)).toBe(0);
	});

	test("does not extend a shorter recording activation delay", () => {
		expect(remainingHoldIntentDelay(1_000, 1_000, 200)).toBe(200);
		expect(remainingHoldIntentDelay(1_000, 1_200, 200)).toBe(0);
	});
});
