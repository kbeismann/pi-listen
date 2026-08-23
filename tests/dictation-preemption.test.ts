import { describe, expect, test } from "bun:test";
import {
	acquireDictationPreemption,
	DICTATION_PREEMPTION_CHANNEL,
	DICTATION_PREEMPTION_PROTOCOL,
	type DictationPreemptionRequest,
} from "../extensions/voice/dictation-preemption";

class FakeEventBus {
	private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): void {
		const handlers = this.handlers.get(channel) ?? [];
		handlers.push(handler);
		this.handlers.set(channel, handlers);
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

describe("dictation preemption", () => {
	test("combines accepted leases and releases them once in reverse order", async () => {
		const events = new FakeEventBus();
		const released: string[] = [];
		events.on(DICTATION_PREEMPTION_CHANNEL, (data) => {
			const request = data as DictationPreemptionRequest;
			expect(request.protocol).toBe(DICTATION_PREEMPTION_PROTOCOL);
			request.accept(Promise.resolve({ release: () => released.push("first") }));
			request.accept(Promise.resolve({ release: () => released.push("second") }));
		});

		const lease = await acquireDictationPreemption({ events } as any);
		lease.release();
		lease.release();

		expect(released).toEqual(["second", "first"]);
	});

	test("releases successful candidates when another acquisition fails", async () => {
		const events = new FakeEventBus();
		let released = false;
		events.on(DICTATION_PREEMPTION_CHANNEL, (data) => {
			const request = data as DictationPreemptionRequest;
			request.accept(Promise.resolve({ release: () => { released = true; } }));
			request.accept(Promise.reject(new Error("microphone owner did not pause")));
		});

		await expect(acquireDictationPreemption({ events } as any)).rejects.toThrow(
			"microphone owner did not pause",
		);
		expect(released).toBe(true);
	});

	test("returns an inert lease when no integration answers", async () => {
		const events = new FakeEventBus();
		const lease = await acquireDictationPreemption({ events } as any);
		expect(() => lease.release()).not.toThrow();
	});
});
