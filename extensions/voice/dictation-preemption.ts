import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const DICTATION_PREEMPTION_CHANNEL = "pi-listen:dictation-preemption:v1";
export const DICTATION_PREEMPTION_PROTOCOL = "pi-listen.dictation-preemption/v1";

export interface DictationPreemptionLease {
	release(): void;
}

export interface DictationPreemptionRequest {
	protocol: typeof DICTATION_PREEMPTION_PROTOCOL;
	accept(lease: Promise<DictationPreemptionLease | undefined>): void;
}

/**
 * Let trusted integrations pause a lower-priority microphone listener before
 * ordinary dictation starts. The returned lease combines every integration
 * that answered this in-process request and releases them in reverse order.
 */
export async function acquireDictationPreemption(
	pi: ExtensionAPI,
): Promise<DictationPreemptionLease> {
	const candidates: Array<Promise<DictationPreemptionLease | undefined>> = [];
	pi.events.emit(DICTATION_PREEMPTION_CHANNEL, {
		protocol: DICTATION_PREEMPTION_PROTOCOL,
		accept(lease: Promise<DictationPreemptionLease | undefined>) {
			candidates.push(lease);
		},
	} satisfies DictationPreemptionRequest);

	const results = await Promise.allSettled(candidates);
	const leases = results.flatMap((result) =>
		result.status === "fulfilled" && result.value ? [result.value] : []
	);
	const failure = results.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failure) {
		for (const lease of leases.reverse()) {
			try { lease.release(); } catch {}
		}
		throw failure.reason;
	}

	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			for (const lease of leases.reverse()) {
				try { lease.release(); } catch {}
			}
		},
	};
}
