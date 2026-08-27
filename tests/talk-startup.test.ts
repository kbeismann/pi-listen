import { describe, expect, test } from "bun:test";
import { createTalkMutedStartup } from "../extensions/voice/talk-startup";

function makeHarness(options: { requested?: boolean; enableResult?: boolean } = {}) {
	let enabled = false;
	const calls: Array<{ inputEnabled?: boolean; outputEnabled?: boolean }> = [];
	const startup = createTalkMutedStartup(
		() => options.requested ?? true,
		{
			isEnabled: () => enabled,
			async enable(_ctx, enableOptions = {}) {
				calls.push(enableOptions);
				enabled = options.enableResult ?? true;
				return enabled;
			},
		},
		{ suppressed: false },
	);
	return { startup, calls, isEnabled: () => enabled };
}

describe("Talk muted startup", () => {
	test("starts Talk with both gates disabled without other integrations", async () => {
		const harness = makeHarness();

		expect(await harness.startup.start({} as any)).toBe(true);
		expect(harness.calls).toEqual([{ inputEnabled: false, outputEnabled: false }]);
		expect(harness.isEnabled()).toBe(true);
	});

	test("reports a failed muted startup without changing suppression", async () => {
		const harness = makeHarness({ enableResult: false });

		expect(await harness.startup.start({} as any)).toBe(false);
		expect(harness.calls).toEqual([{ inputEnabled: false, outputEnabled: false }]);
		expect(harness.startup.isSuppressed()).toBe(false);
	});

	test("does not start when the flag was not requested or Talk is already active", async () => {
		const withoutFlag = makeHarness({ requested: false });
		expect(await withoutFlag.startup.start({} as any)).toBe(false);
		expect(withoutFlag.calls).toEqual([]);

		const active = makeHarness();
		await active.startup.start({} as any);
		expect(await active.startup.start({} as any)).toBe(false);
		expect(active.calls).toHaveLength(1);
	});

	test("keeps explicit Talk off from restarting on later lifecycle callbacks", async () => {
		const harness = makeHarness();
		harness.startup.suppress();

		expect(await harness.startup.start({} as any)).toBe(false);
		expect(await harness.startup.start({} as any)).toBe(false);
		expect(harness.calls).toEqual([]);
		expect(harness.startup.isSuppressed()).toBe(true);
	});

	test("retains explicit Talk off across replacement startup coordinators", async () => {
		const state = { suppressed: false };
		const controller = {
			isEnabled: () => false,
			enable: async () => true,
		};
		createTalkMutedStartup(() => true, controller, state).suppress();
		const replacement = createTalkMutedStartup(() => true, controller, state);

		expect(await replacement.start({} as any)).toBe(false);
		expect(replacement.isSuppressed()).toBe(true);
	});
});
