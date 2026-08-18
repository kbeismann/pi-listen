import { spawn } from "node:child_process";

export interface TalkAudioRoute {
	mode: "pipewire-aec";
	echoCancelled: true;
	captureSource: string;
	playbackSink: string;
	close(): Promise<void>;
}

/** Setup failed after loading a module whose cleanup still needs retrying. */
export class PipeWireEchoCancellationCleanupError extends Error {
	readonly cleanupRoute: TalkAudioRoute;
	readonly setupError: unknown;

	constructor(setupError: unknown, cleanupError: unknown, cleanupRoute: TalkAudioRoute) {
		const setupMessage = setupError instanceof Error ? setupError.message : String(setupError);
		const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
		super(`PipeWire echo-cancellation setup failed (${setupMessage}) and cleanup is pending (${cleanupMessage}).`);
		this.name = "PipeWireEchoCancellationCleanupError";
		this.cleanupRoute = cleanupRoute;
		this.setupError = setupError;
	}
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type PipeWireCommandRunner = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal },
) => Promise<CommandResult>;

export interface PipeWireEchoCancellationOptions {
	signal?: AbortSignal;
	runCommand?: PipeWireCommandRunner;
	processId?: number;
	platform?: NodeJS.Platform;
}

let routeCounter = 0;

function makeAbortError(): Error {
	const error = new Error("PipeWire echo-cancellation setup aborted");
	error.name = "AbortError";
	return error;
}

async function runCommand(
	command: string,
	args: string[],
	options: { signal?: AbortSignal } = {},
): Promise<CommandResult> {
	if (options.signal?.aborted) throw makeAbortError();
	return new Promise<CommandResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			...(options.signal ? { signal: options.signal } : {}),
		});
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (error.name === "AbortError" || options.signal?.aborted) reject(makeAbortError());
			else reject(new Error(`${command} failed to start: ${error.message}`));
		});
		child.once("close", (exitCode) => {
			resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
		});
	});
}

async function requireSuccessful(
	runner: PipeWireCommandRunner,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	const result = await runner("pactl", args, { signal });
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
		throw new Error(`pactl ${args[0] ?? "command"} failed: ${detail}`);
	}
	return result.stdout.trim();
}

/**
 * Create a process-owned PipeWire WebRTC echo-cancellation route for /talk.
 *
 * Both directions must use the returned virtual devices: playback through the
 * virtual sink supplies the far-end reference, and capture from the virtual
 * source yields the cleaned near-end microphone signal. The module is unloaded
 * when the route closes so ordinary desktop audio routing is not changed.
 */
export async function createPipeWireEchoCancellation(
	options: PipeWireEchoCancellationOptions = {},
): Promise<TalkAudioRoute> {
	if ((options.platform ?? process.platform) !== "linux") {
		throw new Error("PipeWire echo cancellation is available only on Linux.");
	}
	const runner = options.runCommand ?? runCommand;
	const signal = options.signal;
	const info = await requireSuccessful(runner, ["info"], signal);
	if (!/Server Name:\s*PulseAudio \(on PipeWire\b/i.test(info)) {
		throw new Error("The active PulseAudio server is not PipeWire.");
	}

	const sourceMaster = await requireSuccessful(runner, ["get-default-source"], signal);
	const sinkMaster = await requireSuccessful(runner, ["get-default-sink"], signal);
	if (!sourceMaster || !sinkMaster) throw new Error("PipeWire has no default capture or playback device.");

	routeCounter += 1;
	const suffix = `${options.processId ?? process.pid}_${routeCounter}`;
	const captureSource = `pi_talk_echo_source_${suffix}`;
	const playbackSink = `pi_talk_echo_sink_${suffix}`;
	let moduleIndex: number | undefined;
	let closed = false;
	let closing: Promise<void> | undefined;

	const close = async (): Promise<void> => {
		if (closed) return;
		if (closing) return closing;
		if (moduleIndex === undefined) {
			closed = true;
			return;
		}
		closing = (async () => {
			const result = await runner("pactl", ["unload-module", String(moduleIndex)]);
			if (result.exitCode !== 0) {
				const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
				throw new Error(`Could not unload PipeWire echo-cancellation module ${moduleIndex}: ${detail}`);
			}
			closed = true;
		})();
		try {
			await closing;
		} finally {
			closing = undefined;
		}
	};
	const route: TalkAudioRoute = {
		mode: "pipewire-aec",
		echoCancelled: true,
		captureSource,
		playbackSink,
		close,
	};

	try {
		const loaded = await requireSuccessful(runner, [
			"load-module",
			"module-echo-cancel",
			`source_name=${captureSource}`,
			`source_master=${sourceMaster}`,
			`sink_name=${playbackSink}`,
			`sink_master=${sinkMaster}`,
			"aec_method=webrtc",
			"rate=48000",
			"channels=1",
		], signal);
		moduleIndex = Number.parseInt(loaded, 10);
		if (!Number.isInteger(moduleIndex)) throw new Error(`pactl returned an invalid module index: ${loaded}`);

		const [sources, sinks] = await Promise.all([
			requireSuccessful(runner, ["list", "short", "sources"], signal),
			requireSuccessful(runner, ["list", "short", "sinks"], signal),
		]);
		if (!sources.split("\n").some((line) => line.split("\t")[1] === captureSource)) {
			throw new Error(`PipeWire did not create capture source ${captureSource}.`);
		}
		if (!sinks.split("\n").some((line) => line.split("\t")[1] === playbackSink)) {
			throw new Error(`PipeWire did not create playback sink ${playbackSink}.`);
		}
		if (signal?.aborted) throw makeAbortError();

		return route;
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new PipeWireEchoCancellationCleanupError(error, cleanupError, route);
		}
		throw error;
	}
}
