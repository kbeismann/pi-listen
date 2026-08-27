import { describe, expect, test } from "bun:test";
import { acquireTalkInputPreemption } from "../extensions/voice/talk-input-preemption";

describe("Talk input preemption", () => {
	test("acquires foreground dictation directly from the active Talk controller", () => {
		let acquired = 0;
		let released = 0;
		const lease = acquireTalkInputPreemption({
			acquireInputPreemption() {
				acquired += 1;
				return { release() { released += 1; } };
			},
		});

		lease.release();
		expect(acquired).toBe(1);
		expect(released).toBe(1);
	});

	test("uses an inert lease when no Talk controller is active", () => {
		expect(() => acquireTalkInputPreemption(null).release()).not.toThrow();
	});
});
