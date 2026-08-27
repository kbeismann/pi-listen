import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { TALK_SYSTEM_PROMPT, type TalkPhase } from "./talk-mode";

export const TALK_SERVICE_CHANNEL = "pi-listen:talk-service:v4";
export const TALK_STATE_CHANNEL = "pi-listen:talk-state:v4";
export const TALK_SERVICE_PROTOCOL = "pi-listen.talk-service/v4";

export type TalkIntegrationContext = ExtensionContext | ExtensionCommandContext;

export interface TalkStateSnapshot {
	protocol: typeof TALK_SERVICE_PROTOCOL;
	enabled: boolean;
	/** Latest requested gate state; foreground dictation may temporarily preempt capture. */
	inputEnabled: boolean;
	outputEnabled: boolean;
	phase: TalkPhase;
}

/**
 * Read-only discovery contract for layers that adapt their own interaction to
 * Talk. Lifecycle and microphone gates remain owned by the Talk controller.
 */
export interface TalkIntegrationService {
	protocol: typeof TALK_SERVICE_PROTOCOL;
	getState(): TalkStateSnapshot;
	getActiveConversationInstructions(): string | undefined;
}

export interface TalkServiceRequest {
	protocol: typeof TALK_SERVICE_PROTOCOL;
	accept(service: TalkIntegrationService): void;
}

interface TalkModeController {
	isEnabled(): boolean;
	isRequestedInputEnabled(): boolean;
	isOutputEnabled(): boolean;
	getPhase(): TalkPhase;
}

/**
 * Publish Talk's observable state and its active conversational contribution.
 * Consumers can apply the exact same instruction to custom turns without
 * receiving authority to change Talk's lifecycle or audio gates.
 */
export function installTalkIntegration(
	pi: ExtensionAPI,
	talkMode: TalkModeController,
): { publishState(): void; dispose(): void } {
	const getState = (): TalkStateSnapshot => ({
		protocol: TALK_SERVICE_PROTOCOL,
		enabled: talkMode.isEnabled(),
		inputEnabled: talkMode.isRequestedInputEnabled(),
		outputEnabled: talkMode.isOutputEnabled(),
		phase: talkMode.getPhase(),
	});

	const service: TalkIntegrationService = {
		protocol: TALK_SERVICE_PROTOCOL,
		getState,
		getActiveConversationInstructions: () => talkMode.isEnabled()
			? TALK_SYSTEM_PROMPT
			: undefined,
	};

	const unsubscribe = pi.events.on(TALK_SERVICE_CHANNEL, (data) => {
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
		dispose() {
			unsubscribe();
		},
	};
}
