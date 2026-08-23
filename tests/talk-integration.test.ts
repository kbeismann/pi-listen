import { describe, expect, test } from "bun:test";
import {
	installTalkIntegration,
	TALK_SERVICE_CHANNEL,
	TALK_SERVICE_PROTOCOL,
	TALK_STATE_CHANNEL,
	type TalkIntegrationService,
	type TalkStateSnapshot,
} from "../extensions/voice/talk-integration";
import type { TalkPhase } from "../extensions/voice/talk-mode";

class FakeEventBus {
	private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? [];
		handlers.push(handler);
		this.handlers.set(channel, handlers);
		return () => {
			this.handlers.set(
				channel,
				(this.handlers.get(channel) ?? []).filter(
					(candidate) => candidate !== handler,
				),
			);
		};
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

describe("talk integration service", () => {
	test("coordinates lifecycle, safe tools, and state through Pi's event bus", async () => {
		const events = new FakeEventBus();
		const safeToolsByOwner = new Map<string, Set<string>>();
		let enabled = false;
		let inputEnabled = false;
		let outputEnabled = false;
		let phase: TalkPhase = "off";
		let constraintsApplied = 0;
		const mode = {
			async enable(_ctx: unknown, options: { inputEnabled?: boolean; outputEnabled?: boolean } = {}): Promise<boolean> {
				enabled = true;
				inputEnabled = options.inputEnabled ?? true;
				outputEnabled = options.outputEnabled ?? true;
				phase = inputEnabled ? "listening" : "standby";
				return true;
			},
			async disable(): Promise<boolean> {
				enabled = false;
				inputEnabled = false;
				outputEnabled = false;
				phase = "off";
				return true;
			},
			setInputEnabled(value: boolean): boolean {
				inputEnabled = value;
				phase = value ? "listening" : "standby";
				return true;
			},
			setOutputEnabled(value: boolean): boolean {
				outputEnabled = value;
				return true;
			},
			applyConstraints(): void {
				constraintsApplied += 1;
			},
			isEnabled: () => enabled,
			isInputEnabled: () => inputEnabled,
			isOutputEnabled: () => outputEnabled,
			getPhase: () => phase,
		};
		const integration = installTalkIntegration(
			{ events } as any,
			mode,
			safeToolsByOwner,
		);

		let service: TalkIntegrationService | undefined;
		events.emit(TALK_SERVICE_CHANNEL, {
			protocol: TALK_SERVICE_PROTOCOL,
			accept(candidate: TalkIntegrationService) {
				service = candidate;
			},
		});
		expect(service).toBeDefined();
		expect(service!.getState()).toEqual({
			protocol: TALK_SERVICE_PROTOCOL,
			enabled: false,
			inputEnabled: false,
			outputEnabled: false,
			phase: "off",
		});

		service!.setSafeTools("pi-relay", ["pi_supervisor", "pi_supervisor"]);
		expect([...safeToolsByOwner.get("pi-relay")!]).toEqual(["pi_supervisor"]);
		expect(constraintsApplied).toBe(0);

		expect(await service!.enable({} as any, {
			inputEnabled: false,
			outputEnabled: false,
		})).toBe(true);
		expect(service!.setInputEnabled(true)).toBe(true);
		expect(service!.setOutputEnabled(true)).toBe(true);
		service!.setSafeTools("pi-relay", ["pi_supervisor"]);
		expect(constraintsApplied).toBe(1);

		let published: TalkStateSnapshot | undefined;
		events.on(TALK_STATE_CHANNEL, (data) => {
			published = data as TalkStateSnapshot;
		});
		integration.publishState();
		expect(published).toEqual({
			protocol: TALK_SERVICE_PROTOCOL,
			enabled: true,
			inputEnabled: true,
			outputEnabled: true,
			phase: "listening",
		});

		service!.clearSafeTools("pi-relay");
		expect(safeToolsByOwner.has("pi-relay")).toBe(false);
		expect(constraintsApplied).toBe(2);
		expect(await service!.disable()).toBe(true);

		integration.dispose();
		let rediscovered = false;
		events.emit(TALK_SERVICE_CHANNEL, {
			protocol: TALK_SERVICE_PROTOCOL,
			accept() {
				rediscovered = true;
			},
		});
		expect(rediscovered).toBe(false);
	});

	test("rejects malformed integration ownership and tool names", () => {
		const events = new FakeEventBus();
		const integrationTools = new Map<string, Set<string>>();
		installTalkIntegration(
			{ events } as any,
			{
				enable: async () => true,
				disable: async () => true,
				setInputEnabled: () => true,
				setOutputEnabled: () => true,
				applyConstraints() {},
				isEnabled: () => false,
				isInputEnabled: () => false,
				isOutputEnabled: () => false,
				getPhase: () => "off",
			},
			integrationTools,
		);
		let service: TalkIntegrationService | undefined;
		events.emit(TALK_SERVICE_CHANNEL, {
			protocol: TALK_SERVICE_PROTOCOL,
			accept(candidate: TalkIntegrationService) {
				service = candidate;
			},
		});

		expect(() => service!.setSafeTools("", ["pi_supervisor"])).toThrow();
		expect(() => service!.setSafeTools("pi-relay", [42] as any)).toThrow();
		expect(() => service!.setSafeTools("pi-relay", ["../bash"])).toThrow();
	});
});
