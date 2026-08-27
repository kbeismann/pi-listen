import type { TalkContext, TalkInputPreemptionLease } from "./talk-mode";

export interface TalkInputPreemptionController {
	acquireInputPreemption(ctx?: TalkContext): TalkInputPreemptionLease;
}

const inertLease: TalkInputPreemptionLease = { release() {} };

/**
 * Foreground dictation talks directly to the local Talk controller. A missing
 * controller means Talk cannot currently own the microphone, so no lease is
 * needed and no cross-extension event is emitted.
 */
export function acquireTalkInputPreemption(
	controller: TalkInputPreemptionController | null | undefined,
	ctx?: TalkContext,
): TalkInputPreemptionLease {
	return controller?.acquireInputPreemption(ctx) ?? inertLease;
}
