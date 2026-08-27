import type { TalkContext, TalkEnableOptions } from "./talk-mode";

export interface TalkMutedStartupState {
	suppressed: boolean;
}

interface TalkMutedStartupController {
	enable(ctx: TalkContext, options?: TalkEnableOptions): Promise<boolean>;
	isEnabled(): boolean;
}

/**
 * Start Talk muted only when Pi received --talk-muted. The mutable state is
 * supplied by the extension process so an explicit /talk off remains effective
 * across later session and tree lifecycle callbacks.
 */
export function createTalkMutedStartup(
	isRequested: () => boolean,
	talkMode: TalkMutedStartupController,
	state: TalkMutedStartupState,
) {
	async function start(ctx: TalkContext): Promise<boolean> {
		if (!isRequested() || state.suppressed || talkMode.isEnabled()) return false;
		return talkMode.enable(ctx, {
			inputEnabled: false,
			outputEnabled: false,
		});
	}

	return {
		start,
		suppress() {
			state.suppressed = true;
		},
		isSuppressed: () => state.suppressed,
	};
}
