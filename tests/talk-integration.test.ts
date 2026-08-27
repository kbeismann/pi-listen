import { describe, expect, test } from "bun:test";
import {
	installTalkIntegration,
	TALK_SERVICE_CHANNEL,
	TALK_SERVICE_PROTOCOL,
	TALK_STATE_CHANNEL,
	type TalkIntegrationService,
	type TalkStateSnapshot,
} from "../extensions/voice/talk-integration";
import { TALK_SYSTEM_PROMPT, type TalkPhase } from "../extensions/voice/talk-mode";

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

describe("Talk integration service", () => {
	test("publishes v4 read-only state and the canonical active instructions", () => {
		const events = new FakeEventBus();
		let enabled = false;
		let inputEnabled = false;
		let outputEnabled = false;
		let phase: TalkPhase = "off";
		const mode = {
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
		expect(service!.getState()).toEqual({
			protocol: TALK_SERVICE_PROTOCOL,
			enabled: false,
			inputEnabled: false,
			outputEnabled: false,
			phase: "off",
		});
		expect(service!.getActiveConversationInstructions()).toBeUndefined();
		expect("enable" in service!).toBe(false);
		expect("disable" in service!).toBe(false);
		expect("setInputEnabled" in service!).toBe(false);
		expect("setOutputEnabled" in service!).toBe(false);

		enabled = true;
		inputEnabled = true;
		outputEnabled = true;
		phase = "listening";
		expect(service!.getActiveConversationInstructions()).toBe(TALK_SYSTEM_PROMPT);

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
});
