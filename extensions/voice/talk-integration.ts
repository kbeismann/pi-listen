import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { TalkPhase } from "./talk-mode";

export const TALK_SERVICE_CHANNEL = "pi-listen:talk-service:v1";
export const TALK_STATE_CHANNEL = "pi-listen:talk-state:v1";
export const TALK_SERVICE_PROTOCOL = "pi-listen.talk-service/v1";

export type TalkIntegrationContext = ExtensionContext | ExtensionCommandContext;

export interface TalkStateSnapshot {
	protocol: typeof TALK_SERVICE_PROTOCOL;
	enabled: boolean;
	phase: TalkPhase;
}

export interface TalkIntegrationService {
	protocol: typeof TALK_SERVICE_PROTOCOL;
	getState(): TalkStateSnapshot;
	enable(ctx: TalkIntegrationContext): Promise<boolean>;
	disable(
		ctx?: TalkIntegrationContext,
		options?: { notify?: boolean; awaitTranscription?: boolean },
	): Promise<boolean>;
	setSafeTools(
		owner: string,
		toolNames: string[],
		ctx?: TalkIntegrationContext,
	): void;
	clearSafeTools(owner: string, ctx?: TalkIntegrationContext): void;
}

export interface TalkServiceRequest {
	protocol: typeof TALK_SERVICE_PROTOCOL;
	accept(service: TalkIntegrationService): void;
}

interface TalkModeController {
	enable(ctx: TalkIntegrationContext): Promise<boolean>;
	disable(
		ctx?: TalkIntegrationContext,
		options?: { notify?: boolean; awaitTranscription?: boolean },
	): Promise<boolean>;
	applyConstraints(ctx?: TalkIntegrationContext): void;
	isEnabled(): boolean;
	getPhase(): TalkPhase;
}

function validOwner(owner: string): boolean {
	return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(owner);
}

function validToolName(toolName: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(toolName);
}

/**
 * Publish a narrow in-process service for trusted extensions that compose
 * `/talk`. Pi extensions already execute with the user's full permissions, so
 * the explicit owner and exact tool names provide lifecycle isolation rather
 * than a security boundary. Talk still rejects every tool that neither its
 * built-in allowlist nor a current integration owner has selected.
 */
export function installTalkIntegration(
	pi: ExtensionAPI,
	talkMode: TalkModeController,
	safeToolsByOwner: Map<string, Set<string>>,
): { publishState(): void } {
	const getState = (): TalkStateSnapshot => ({
		protocol: TALK_SERVICE_PROTOCOL,
		enabled: talkMode.isEnabled(),
		phase: talkMode.getPhase(),
	});

	const service: TalkIntegrationService = {
		protocol: TALK_SERVICE_PROTOCOL,
		getState,
		enable: (ctx) => talkMode.enable(ctx),
		disable: (ctx, options) => talkMode.disable(ctx, options),
		setSafeTools(owner, toolNames, ctx) {
			if (!validOwner(owner)) throw new Error("Invalid talk integration owner.");
			if (
				!Array.isArray(toolNames)
				|| toolNames.some((name) => typeof name !== "string")
			) {
				throw new Error("Invalid talk integration tool names.");
			}
			const normalized = [...new Set(toolNames.map((name) => name.trim()))];
			if (normalized.some((name) => !validToolName(name))) {
				throw new Error("Invalid talk integration tool name.");
			}
			safeToolsByOwner.set(owner, new Set(normalized));
			if (talkMode.isEnabled()) talkMode.applyConstraints(ctx);
		},
		clearSafeTools(owner, ctx) {
			if (!validOwner(owner)) throw new Error("Invalid talk integration owner.");
			safeToolsByOwner.delete(owner);
			if (talkMode.isEnabled()) talkMode.applyConstraints(ctx);
		},
	};

	pi.events.on(TALK_SERVICE_CHANNEL, (data) => {
		const request = data as Partial<TalkServiceRequest> | undefined;
		if (
			request?.protocol === TALK_SERVICE_PROTOCOL
			&& typeof request.accept === "function"
		) {
			request.accept(service);
		}
	});

	return {
		publishState() {
			pi.events.emit(TALK_STATE_CHANNEL, getState());
		},
	};
}
