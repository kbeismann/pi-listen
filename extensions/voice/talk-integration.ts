import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type {
	TalkControlOptions,
	TalkEnableOptions,
	TalkPhase,
} from "./talk-mode";

export const TALK_SERVICE_CHANNEL = "pi-listen:talk-service:v3";
export const TALK_STATE_CHANNEL = "pi-listen:talk-state:v3";
export const TALK_SERVICE_PROTOCOL = "pi-listen.talk-service/v3";
/** @deprecated Compatibility channel for Relay producers that still speak v2. */
export const TALK_SERVICE_CHANNEL_V2 = "pi-listen:talk-service:v2";
/** @deprecated Compatibility channel for Relay consumers that still speak v2. */
export const TALK_STATE_CHANNEL_V2 = "pi-listen:talk-state:v2";
/** @deprecated Compatibility protocol for Relay producers that still speak v2. */
export const TALK_SERVICE_PROTOCOL_V2 = "pi-listen.talk-service/v2";

export type TalkIntegrationContext = ExtensionContext | ExtensionCommandContext;

export interface TalkStateSnapshot {
	protocol: typeof TALK_SERVICE_PROTOCOL;
	enabled: boolean;
	inputEnabled: boolean;
	outputEnabled: boolean;
	phase: TalkPhase;
}

/** @deprecated Snapshot shape emitted on the v2 compatibility state channel. */
export interface TalkStateSnapshotV2 {
	protocol: typeof TALK_SERVICE_PROTOCOL_V2;
	enabled: boolean;
	inputEnabled: boolean;
	outputEnabled: boolean;
	phase: TalkPhase;
}

interface TalkIntegrationOperations {
	enable(
		ctx: TalkIntegrationContext,
		options?: TalkEnableOptions,
	): Promise<boolean>;
	disable(
		ctx?: TalkIntegrationContext,
		options?: { notify?: boolean; awaitTranscription?: boolean },
	): Promise<boolean>;
	setInputEnabled(
		enabled: boolean,
		ctx?: TalkIntegrationContext,
		options?: TalkControlOptions,
	): boolean;
	setOutputEnabled(
		enabled: boolean,
		ctx?: TalkIntegrationContext,
		options?: TalkControlOptions,
	): boolean;
}

export interface TalkIntegrationService extends TalkIntegrationOperations {
	protocol: typeof TALK_SERVICE_PROTOCOL;
	getState(): TalkStateSnapshot;
}

/** @deprecated v2 service shape retained for the producer-first rollout. */
export interface TalkIntegrationServiceV2 extends TalkIntegrationOperations {
	protocol: typeof TALK_SERVICE_PROTOCOL_V2;
	getState(): TalkStateSnapshotV2;
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

export interface TalkServiceRequestV2 {
	protocol: typeof TALK_SERVICE_PROTOCOL_V2;
	accept(service: TalkIntegrationServiceV2): void;
}

interface TalkModeController {
	enable(
		ctx: TalkIntegrationContext,
		options?: TalkEnableOptions,
	): Promise<boolean>;
	disable(
		ctx?: TalkIntegrationContext,
		options?: { notify?: boolean; awaitTranscription?: boolean },
	): Promise<boolean>;
	setInputEnabled(
		enabled: boolean,
		ctx?: TalkIntegrationContext,
		options?: TalkControlOptions,
	): boolean;
	setOutputEnabled(
		enabled: boolean,
		ctx?: TalkIntegrationContext,
		options?: TalkControlOptions,
	): boolean;
	isEnabled(): boolean;
	isInputEnabled(): boolean;
	isOutputEnabled(): boolean;
	getPhase(): TalkPhase;
}

/**
 * Publish lifecycle and audio-channel controls for trusted extensions that
 * compose `/talk`. Talk changes interaction only; callers retain responsibility
 * for their own permissions and tool policy.
 */
export function installTalkIntegration(
	pi: ExtensionAPI,
	talkMode: TalkModeController,
): { publishState(): void; dispose(): void } {
	const getState = (): TalkStateSnapshot => ({
		protocol: TALK_SERVICE_PROTOCOL,
		enabled: talkMode.isEnabled(),
		inputEnabled: talkMode.isInputEnabled(),
		outputEnabled: talkMode.isOutputEnabled(),
		phase: talkMode.getPhase(),
	});
	const getV2State = (): TalkStateSnapshotV2 => ({
		protocol: TALK_SERVICE_PROTOCOL_V2,
		enabled: talkMode.isEnabled(),
		inputEnabled: talkMode.isInputEnabled(),
		outputEnabled: talkMode.isOutputEnabled(),
		phase: talkMode.getPhase(),
	});

	const service: TalkIntegrationService = {
		protocol: TALK_SERVICE_PROTOCOL,
		getState,
		enable: (ctx, options) => talkMode.enable(ctx, options),
		disable: (ctx, options) => talkMode.disable(ctx, options),
		setInputEnabled: (enabled, ctx, options) =>
			talkMode.setInputEnabled(enabled, ctx, options),
		setOutputEnabled: (enabled, ctx, options) =>
			talkMode.setOutputEnabled(enabled, ctx, options),
	};

	/**
	 * Deprecated adapter for deployed Relay v2 producers. Lifecycle and audio
	 * controls remain real forwards to Talk, while the removed permission
	 * controls are intentional no-ops: v2 Relay retains its deterministic
	 * permission guard and the surrounding Pi session owns permissions in v3.
	 */
	const compatibilityService: TalkIntegrationServiceV2 = {
		protocol: TALK_SERVICE_PROTOCOL_V2,
		getState: getV2State,
		enable: (ctx, options) => talkMode.enable(ctx, options),
		disable: (ctx, options) => talkMode.disable(ctx, options),
		setInputEnabled: (enabled, ctx, options) =>
			talkMode.setInputEnabled(enabled, ctx, options),
		setOutputEnabled: (enabled, ctx, options) =>
			talkMode.setOutputEnabled(enabled, ctx, options),
		setSafeTools(_owner, _toolNames, _ctx) {},
		clearSafeTools(_owner, _ctx) {},
	};

	const unsubscribeV3 = pi.events.on(TALK_SERVICE_CHANNEL, (data) => {
		const request = data as Partial<TalkServiceRequest> | undefined;
		if (
			request?.protocol === TALK_SERVICE_PROTOCOL
			&& typeof request.accept === "function"
		) {
			request.accept(service);
		}
	});
	const unsubscribeV2 = pi.events.on(TALK_SERVICE_CHANNEL_V2, (data) => {
		const request = data as Partial<TalkServiceRequestV2> | undefined;
		if (
			request?.protocol === TALK_SERVICE_PROTOCOL_V2
			&& typeof request.accept === "function"
		) {
			request.accept(compatibilityService);
		}
	});

	return {
		publishState() {
			pi.events.emit(TALK_STATE_CHANNEL, getState());
			pi.events.emit(TALK_STATE_CHANNEL_V2, getV2State());
		},
		dispose() {
			unsubscribeV3();
			unsubscribeV2();
		},
	};
}
