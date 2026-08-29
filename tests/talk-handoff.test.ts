import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createTalkHandoffController,
	talkHandoffConfirmationText,
	TALK_TARGET_SERVICE_CHANNEL,
	TALK_TARGET_SERVICE_PROTOCOL,
	TALK_TO_RELAY_TOOL_NAME,
	TALK_TO_SESSION_TOOL_NAME,
	type TalkHandoffController,
	type TalkTargetRegistrationService,
} from "../extensions/voice/talk-handoff";

class FakeEventBus {
	private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? [];
		handlers.push(handler);
		this.handlers.set(channel, handlers);
		return () => {
			this.handlers.set(channel, (this.handlers.get(channel) ?? []).filter(
				(candidate) => candidate !== handler,
			));
		};
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

class FakePi {
	readonly events = new FakeEventBus();
	readonly tools = new Map<string, any>();

	registerTool(tool: { name: string }): void {
		this.tools.set(tool.name, tool);
	}
}

interface SessionHarness {
	pi: FakePi;
	context: ReturnType<typeof makeContext>;
	controller: TalkHandoffController;
	mode: {
		enabled: boolean;
		inputEnabled: boolean;
		outputEnabled: boolean;
		confirmations: string[];
		confirmationError?: Error;
		enable(ctx: unknown, options?: { inputEnabled?: boolean; outputEnabled?: boolean }): Promise<boolean>;
		speakConfirmation(text: string): Promise<boolean>;
		disable(): Promise<boolean>;
	};
}

const runtimeDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(runtimeDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function makeContext(options: {
	name?: string;
	cwd: string;
	recentUser?: string;
	recentAssistant?: string;
	idle?: boolean;
}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const branch = [
		...(options.recentUser
			? [{ type: "message", message: { role: "user", content: options.recentUser } }]
			: []),
		...(options.recentAssistant
			? [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: options.recentAssistant }] } }]
			: []),
	];
	return {
		hasUI: true,
		mode: "tui",
		cwd: options.cwd,
		isIdle: () => options.idle ?? true,
		sessionManager: {
			getBranch: () => branch,
			getSessionName: () => options.name,
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
		setIdle(idle: boolean) {
			options.idle = idle;
		},
		notifications,
	};
}

function makeSession(
	runtimeDirectory: string,
	options: Parameters<typeof makeContext>[0],
): SessionHarness {
	const pi = new FakePi();
	const context = makeContext(options);
	let controller: TalkHandoffController;
	const mode = {
		enabled: false,
		inputEnabled: false,
		outputEnabled: false,
		confirmations: [] as string[],
		confirmationError: undefined as Error | undefined,
		isEnabled: () => mode.enabled,
		isRequestedInputEnabled: () => mode.inputEnabled,
		isOutputEnabled: () => mode.outputEnabled,
		async enable(_ctx: unknown, enableOptions: { inputEnabled?: boolean; outputEnabled?: boolean } = {}) {
			if (mode.enabled) return false;
			await controller.claimOwnership();
			mode.enabled = true;
			mode.inputEnabled = enableOptions.inputEnabled ?? true;
			mode.outputEnabled = enableOptions.outputEnabled ?? true;
			return true;
		},
		async speakConfirmation(text: string) {
			if (!mode.outputEnabled) return false;
			if (mode.confirmationError) throw mode.confirmationError;
			mode.confirmations.push(text);
			return true;
		},
		async disable() {
			if (!mode.enabled) return false;
			mode.enabled = false;
			mode.inputEnabled = false;
			mode.outputEnabled = false;
			await controller.releaseOwnership();
			return true;
		},
	};
	controller = createTalkHandoffController(pi as any, mode as any, {
		runtimeDirectory,
		requestTimeoutMs: 500,
		activationTimeoutMs: 2_000,
	});
	return { pi, context, controller, mode };
}

async function makeRuntimeDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-talk-handoff-test-"));
	runtimeDirectories.push(directory);
	return directory;
}

async function stopSessions(...sessions: SessionHarness[]): Promise<void> {
	await Promise.all(sessions.map((session) => session.controller.stop()));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test state.");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

describe("Talk session handoff", () => {
	test("builds a fixed local confirmation from target identity", () => {
		expect(talkHandoffConfirmationText({
			aliases: ["relay"],
			cwd: "/work/chezmoi",
			name: "A name Relay does not need",
		})).toBe("You're now talking to Relay.");
		expect(talkHandoffConfirmationText({
			aliases: [],
			cwd: "/work/payments",
			name: "API migration!",
		})).toBe("You're now talking to API migration.");
		expect(talkHandoffConfirmationText({
			aliases: [],
			cwd: "/work/payments",
		})).toBe("You're now talking to the payments project session.");
		expect(talkHandoffConfirmationText({
			aliases: [],
			cwd: "/",
		})).toBe("Talk is now active in this session.");
	});

	test("moves Talk directly to the live Relay target only after settlement", async () => {
		const runtimeDirectory = await makeRuntimeDirectory();
		const source = makeSession(runtimeDirectory, {
			name: "Voice planning",
			cwd: "/work/pi-listen",
			recentUser: "I want to talk to Relay",
		});
		const relay = makeSession(runtimeDirectory, {
			name: "Relay",
			cwd: "/work/chezmoi",
			recentAssistant: "Relay is waiting quietly.",
		});
		await source.controller.start(source.context as any);
		await relay.controller.start(relay.context as any);
		try {
			let targetService: TalkTargetRegistrationService | undefined;
			relay.pi.events.emit(TALK_TARGET_SERVICE_CHANNEL, {
				protocol: TALK_TARGET_SERVICE_PROTOCOL,
				accept(service: TalkTargetRegistrationService) {
					targetService = service;
				},
			});
			expect(targetService).toBeDefined();
			targetService!.registerAlias("relay");

			expect(await source.mode.enable(source.context, {
				inputEnabled: true,
				outputEnabled: false,
			})).toBe(true);
			const tool = source.pi.tools.get(TALK_TO_RELAY_TOOL_NAME);
			const result = await tool.execute("relay", {}, undefined, undefined, source.context);
			expect(result.content[0].text).toContain("queued");
			expect(source.mode.enabled).toBe(true);
			expect(relay.mode.enabled).toBe(false);

			await source.controller.completePendingHandoff();
			expect(source.mode.enabled).toBe(false);
			expect(relay.mode.enabled).toBe(true);
			expect(relay.mode.inputEnabled).toBe(true);
			expect(relay.mode.outputEnabled).toBe(false);
			expect(relay.mode.confirmations).toEqual([]);
			expect(source.context.notifications.at(-1)?.message).toContain("Talk moved to Relay");
			expect(relay.context.notifications.at(-1)?.message).toContain("Talk moved here from Voice planning");
			const alreadyThere = await relay.pi.tools.get(TALK_TO_RELAY_TOOL_NAME).execute(
				"already-relay",
				{},
				undefined,
				undefined,
				relay.context,
			);
			expect(alreadyThere.details.status).toBe("already-there");

			await expect(tool.execute("relay-again", {}, undefined, undefined, source.context)).rejects.toThrow(
				"Only the Pi session that currently owns Talk",
			);
		} finally {
			await stopSessions(source, relay);
		}
	});

	test("queues a Relay handoff while its target turn is active", async () => {
		const runtimeDirectory = await makeRuntimeDirectory();
		const source = makeSession(runtimeDirectory, {
			name: "Voice planning",
			cwd: "/work/pi-listen",
		});
		const relay = makeSession(runtimeDirectory, {
			name: "Relay",
			cwd: "/work/chezmoi",
			idle: false,
			recentAssistant: "Relay is assessing an autonomous cue.",
		});
		await source.controller.start(source.context as any);
		await relay.controller.start(relay.context as any);
		try {
			let targetService: TalkTargetRegistrationService | undefined;
			relay.pi.events.emit(TALK_TARGET_SERVICE_CHANNEL, {
				protocol: TALK_TARGET_SERVICE_PROTOCOL,
				accept(service: TalkTargetRegistrationService) {
					targetService = service;
				},
			});
			targetService!.registerAlias("relay");
			await source.mode.enable(source.context);

			const result = await source.pi.tools.get(TALK_TO_RELAY_TOOL_NAME).execute(
				"busy-relay",
				{},
				undefined,
				undefined,
				source.context,
			);
			expect(result.details.status).toBe("queued");
			expect(result.content[0].text).toContain("active target turn");

			const completion = source.controller.completePendingHandoff();
			await waitUntil(() => !source.mode.enabled);
			expect(relay.mode.enabled).toBe(false);

			relay.context.setIdle(true);
			await completion;
			expect(relay.mode.enabled).toBe(true);
			expect(source.context.notifications.at(-1)?.message).toContain("Talk moved to Relay");
		} finally {
			await stopSessions(source, relay);
		}
	});

	test("finds a session from bounded recent conversation text", async () => {
		const runtimeDirectory = await makeRuntimeDirectory();
		const source = makeSession(runtimeDirectory, {
			name: "Coordinator",
			cwd: "/work/home",
		});
		const billing = makeSession(runtimeDirectory, {
			name: "API work",
			cwd: "/work/payments",
			recentUser: "Implement the billing migration without changing invoices",
		});
		const documentation = makeSession(runtimeDirectory, {
			name: "Docs",
			cwd: "/work/site",
			recentUser: "Rewrite the installation tutorial",
		});
		await source.controller.start(source.context as any);
		await billing.controller.start(billing.context as any);
		await documentation.controller.start(documentation.context as any);
		try {
			await source.mode.enable(source.context);
			const tool = source.pi.tools.get(TALK_TO_SESSION_TOOL_NAME);
			const result = await tool.execute(
				"billing",
				{ description: "the one working on the billing migration" },
				undefined,
				undefined,
				source.context,
			);
			expect(result.details.target).toContain("API work");
			expect(result.content[0].text).not.toContain("session ID");

			await source.controller.completePendingHandoff();
			expect(billing.mode.enabled).toBe(true);
			expect(billing.mode.confirmations).toEqual(["You're now talking to API work."]);
			expect(documentation.mode.enabled).toBe(false);
		} finally {
			await stopSessions(source, billing, documentation);
		}
	});

	test("keeps a completed handoff when local confirmation fails", async () => {
		const runtimeDirectory = await makeRuntimeDirectory();
		const source = makeSession(runtimeDirectory, { name: "Source", cwd: "/work/source" });
		const target = makeSession(runtimeDirectory, { name: "Target", cwd: "/work/target" });
		await source.controller.start(source.context as any);
		await target.controller.start(target.context as any);
		try {
			await source.mode.enable(source.context);
			target.mode.confirmationError = new Error("speaker unavailable");
			await source.pi.tools.get(TALK_TO_SESSION_TOOL_NAME).execute(
				"target",
				{ description: "Target" },
				undefined,
				undefined,
				source.context,
			);

			await source.controller.completePendingHandoff();
			expect(source.mode.enabled).toBe(false);
			expect(target.mode.enabled).toBe(true);
			expect(target.context.notifications.at(-1)?.message).toContain("confirmation could not be spoken");
		} finally {
			await stopSessions(source, target);
		}
	});

	test("returns natural choices instead of guessing between equal matches", async () => {
		const runtimeDirectory = await makeRuntimeDirectory();
		const source = makeSession(runtimeDirectory, { name: "Source", cwd: "/work/source" });
		const first = makeSession(runtimeDirectory, { name: "First review", cwd: "/work/api" });
		const second = makeSession(runtimeDirectory, { name: "Second review", cwd: "/work/web" });
		await source.controller.start(source.context as any);
		await first.controller.start(first.context as any);
		await second.controller.start(second.context as any);
		try {
			await source.mode.enable(source.context);
			const tool = source.pi.tools.get(TALK_TO_SESSION_TOOL_NAME);
			const result = await tool.execute(
				"ambiguous",
				{ description: "the other session" },
				undefined,
				undefined,
				source.context,
			);
			expect(result.details.status).toBe("ambiguous");
			expect(result.details.candidates).toEqual(["First review (api)", "Second review (web)"]);
			expect(result.content[0].text).toContain("Ask the user which one");

			await source.controller.completePendingHandoff();
			expect(source.mode.enabled).toBe(true);
			expect(first.mode.enabled).toBe(false);
			expect(second.mode.enabled).toBe(false);
		} finally {
			await stopSessions(source, first, second);
		}
	});

	test("does not select a sole target that contradicts the description", async () => {
		const runtimeDirectory = await makeRuntimeDirectory();
		const source = makeSession(runtimeDirectory, { name: "Source", cwd: "/work/source" });
		const documentation = makeSession(runtimeDirectory, {
			name: "Documentation",
			cwd: "/work/site",
			recentUser: "Rewrite the installation tutorial",
		});
		await source.controller.start(source.context as any);
		await documentation.controller.start(documentation.context as any);
		try {
			await source.mode.enable(source.context);
			const result = await source.pi.tools.get(TALK_TO_SESSION_TOOL_NAME).execute(
				"wrong-sole-target",
				{ description: "the billing migration session" },
				undefined,
				undefined,
				source.context,
			);
			expect(result.details.status).toBe("no-match");
			await source.controller.completePendingHandoff();
			expect(source.mode.enabled).toBe(true);
			expect(documentation.mode.enabled).toBe(false);
		} finally {
			await stopSessions(source, documentation);
		}
	});

	test("prevents a second live session from claiming Talk", async () => {
		const runtimeDirectory = await makeRuntimeDirectory();
		const first = makeSession(runtimeDirectory, { name: "First", cwd: "/work/first" });
		const second = makeSession(runtimeDirectory, { name: "Second", cwd: "/work/second" });
		await first.controller.start(first.context as any);
		await second.controller.start(second.context as any);
		try {
			expect(await first.mode.enable(first.context)).toBe(true);
			await expect(second.mode.enable(second.context)).rejects.toThrow("Talk is already active in First");
			expect(second.mode.enabled).toBe(false);
		} finally {
			await stopSessions(first, second);
		}
	});
});
