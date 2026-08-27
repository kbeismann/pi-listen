import { describe, expect, test } from "bun:test";
import {
	installTalkIntegration,
	TALK_SERVICE_CHANNEL,
	TALK_SERVICE_CHANNEL_V2,
	TALK_SERVICE_PROTOCOL,
	TALK_SERVICE_PROTOCOL_V2,
	TALK_STATE_CHANNEL,
	TALK_STATE_CHANNEL_V2,
	type TalkIntegrationService,
	type TalkIntegrationServiceV2,
	type TalkStateSnapshot,
	type TalkStateSnapshotV2,
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
	test("coordinates v3 and v2 interaction services through Pi's event bus", async () => {
		const events = new FakeEventBus();
		let enabled = false;
		let inputEnabled = false;
		let outputEnabled = false;
		let phase: TalkPhase = "off";
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
			isEnabled: () => enabled,
			isInputEnabled: () => inputEnabled,
			isOutputEnabled: () => outputEnabled,
			getPhase: () => phase,
		};
		const integration = installTalkIntegration({ events } as any, mode);

		let service: TalkIntegrationService | undefined;
		events.emit(TALK_SERVICE_CHANNEL, {
			protocol: TALK_SERVICE_PROTOCOL,
			accept(candidate: TalkIntegrationService) {
				service = candidate;
			},
		});
		expect(service).toBeDefined();
		expect("setSafeTools" in service!).toBe(false);
		expect("clearSafeTools" in service!).toBe(false);
		expect(service!.getState()).toEqual({
			protocol: TALK_SERVICE_PROTOCOL,
			enabled: false,
			inputEnabled: false,
			outputEnabled: false,
			phase: "off",
		});

		let compatibilityService: TalkIntegrationServiceV2 | undefined;
		events.emit(TALK_SERVICE_CHANNEL_V2, {
			protocol: TALK_SERVICE_PROTOCOL_V2,
			accept(candidate: TalkIntegrationServiceV2) {
				compatibilityService = candidate;
			},
		});
		expect(compatibilityService).toBeDefined();
		expect(compatibilityService!.protocol).toBe(TALK_SERVICE_PROTOCOL_V2);
		expect(compatibilityService!.getState()).toEqual({
			protocol: TALK_SERVICE_PROTOCOL_V2,
			enabled: false,
			inputEnabled: false,
			outputEnabled: false,
			phase: "off",
		});

		expect(() => compatibilityService!.setSafeTools(
			"pi-relay",
			["pi_supervisor"],
			{} as any,
		)).not.toThrow();
		expect(() => compatibilityService!.clearSafeTools(
			"pi-relay",
			{} as any,
		)).not.toThrow();
		expect(service!.getState()).toEqual({
			protocol: TALK_SERVICE_PROTOCOL,
			enabled: false,
			inputEnabled: false,
			outputEnabled: false,
			phase: "off",
		});

		expect(await compatibilityService!.enable({} as any, {
			inputEnabled: false,
			outputEnabled: false,
		})).toBe(true);
		expect(compatibilityService!.setInputEnabled(true)).toBe(true);
		expect(compatibilityService!.setOutputEnabled(true)).toBe(true);
		expect(service!.getState()).toEqual({
			protocol: TALK_SERVICE_PROTOCOL,
			enabled: true,
			inputEnabled: true,
			outputEnabled: true,
			phase: "listening",
		});
		expect(() => compatibilityService!.setSafeTools("pi-relay", [])).not.toThrow();
		expect(() => compatibilityService!.clearSafeTools("pi-relay")).not.toThrow();
		expect(service!.getState()).toEqual({
			protocol: TALK_SERVICE_PROTOCOL,
			enabled: true,
			inputEnabled: true,
			outputEnabled: true,
			phase: "listening",
		});

		let publishedV3: TalkStateSnapshot | undefined;
		events.on(TALK_STATE_CHANNEL, (data) => {
			publishedV3 = data as TalkStateSnapshot;
		});
		let publishedV2: TalkStateSnapshotV2 | undefined;
		events.on(TALK_STATE_CHANNEL_V2, (data) => {
			publishedV2 = data as TalkStateSnapshotV2;
		});
		integration.publishState();
		expect(publishedV3).toEqual({
			protocol: TALK_SERVICE_PROTOCOL,
			enabled: true,
			inputEnabled: true,
			outputEnabled: true,
			phase: "listening",
		});
		expect(publishedV2).toEqual({
			protocol: TALK_SERVICE_PROTOCOL_V2,
			enabled: true,
			inputEnabled: true,
			outputEnabled: true,
			phase: "listening",
		});

		expect(await compatibilityService!.disable()).toBe(true);

		integration.dispose();
		let rediscoveredV3 = false;
		events.emit(TALK_SERVICE_CHANNEL, {
			protocol: TALK_SERVICE_PROTOCOL,
			accept() {
				rediscoveredV3 = true;
			},
		});
		let rediscoveredV2 = false;
		events.emit(TALK_SERVICE_CHANNEL_V2, {
			protocol: TALK_SERVICE_PROTOCOL_V2,
			accept() {
				rediscoveredV2 = true;
			},
		});
		expect(rediscoveredV3).toBe(false);
		expect(rediscoveredV2).toBe(false);
	});
});
