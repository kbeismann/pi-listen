/**
 * Keep ordinary Space taps out of warmup without extending the configured
 * time from initial key-down to recording activation.
 */
export const HOLD_INTENT_DELAY_MS = 300;

/** Return the unelapsed portion of the warmup intent delay. */
export function remainingHoldIntentDelay(
	holdStartedAtMs: number,
	nowMs: number,
	activationDelayMs: number,
): number {
	const intentDelayMs = Math.min(
		HOLD_INTENT_DELAY_MS,
		Math.max(0, activationDelayMs),
	);
	const elapsedMs = Math.max(0, nowMs - holdStartedAtMs);
	return Math.max(0, intentDelayMs - elapsedMs);
}
