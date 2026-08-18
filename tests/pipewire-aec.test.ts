import { describe, expect, test } from "bun:test";
import {
	createPipeWireEchoCancellation,
	PipeWireEchoCancellationCleanupError,
	type PipeWireCommandRunner,
} from "../extensions/voice/pipewire-aec";

function makeRunner(options: { omitSink?: boolean; unloadFailures?: number } = {}) {
	const calls: string[][] = [];
	let captureSource = "";
	let playbackSink = "";
	let unloadAttempts = 0;
	const runner: PipeWireCommandRunner = async (command, args) => {
		calls.push([command, ...args]);
		if (args[0] === "info") {
			return { stdout: "Server Name: PulseAudio (on PipeWire 1.6.8)\n", stderr: "", exitCode: 0 };
		}
		if (args[0] === "get-default-source") {
			return { stdout: "physical_mic\n", stderr: "", exitCode: 0 };
		}
		if (args[0] === "get-default-sink") {
			return { stdout: "physical_speakers\n", stderr: "", exitCode: 0 };
		}
		if (args[0] === "load-module") {
			captureSource = args.find((arg) => arg.startsWith("source_name="))!.slice("source_name=".length);
			playbackSink = args.find((arg) => arg.startsWith("sink_name="))!.slice("sink_name=".length);
			return { stdout: "42\n", stderr: "", exitCode: 0 };
		}
		if (args.join(" ") === "list short sources") {
			return { stdout: `10\t${captureSource}\tdriver\n`, stderr: "", exitCode: 0 };
		}
		if (args.join(" ") === "list short sinks") {
			return {
				stdout: options.omitSink ? "" : `11\t${playbackSink}\tdriver\n`,
				stderr: "",
				exitCode: 0,
			};
		}
		if (args[0] === "unload-module") {
			unloadAttempts += 1;
			if (unloadAttempts <= (options.unloadFailures ?? 0)) {
				return { stdout: "", stderr: "temporary failure", exitCode: 1 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "unexpected command", exitCode: 1 };
	};
	return { runner, calls };
}

describe("PipeWire echo-cancellation route", () => {
	test("creates paired virtual devices and unloads their module", async () => {
		const { runner, calls } = makeRunner();
		const route = await createPipeWireEchoCancellation({
			runCommand: runner,
			processId: 123,
			platform: "linux",
		});

		expect(route.captureSource).toStartWith("pi_talk_echo_source_123_");
		expect(route.playbackSink).toStartWith("pi_talk_echo_sink_123_");
		expect(route.echoCancelled).toBe(true);
		await route.close();
		await route.close();
		expect(calls.filter((call) => call[1] === "unload-module")).toEqual([
			["pactl", "unload-module", "42"],
		]);
	});

	test("unloads a partial route when PipeWire omits a virtual device", async () => {
		const { runner, calls } = makeRunner({ omitSink: true });
		await expect(createPipeWireEchoCancellation({
			runCommand: runner,
			processId: 456,
			platform: "linux",
		})).rejects.toThrow("did not create playback sink");
		expect(calls.some((call) => call.join(" ") === "pactl unload-module 42")).toBe(true);
	});

	test("retries module cleanup after a transient unload failure", async () => {
		const { runner, calls } = makeRunner({ unloadFailures: 1 });
		const route = await createPipeWireEchoCancellation({
			runCommand: runner,
			processId: 789,
			platform: "linux",
		});

		await expect(route.close()).rejects.toThrow("temporary failure");
		await route.close();
		expect(calls.filter((call) => call[1] === "unload-module")).toHaveLength(2);
	});

	test("returns a cleanup handle when partial setup cannot unload", async () => {
		const { runner } = makeRunner({ omitSink: true, unloadFailures: 1 });
		let cleanupError: PipeWireEchoCancellationCleanupError | undefined;
		try {
			await createPipeWireEchoCancellation({
				runCommand: runner,
				processId: 987,
				platform: "linux",
			});
		} catch (error) {
			if (error instanceof PipeWireEchoCancellationCleanupError) cleanupError = error;
		}

		expect(cleanupError).toBeDefined();
		await cleanupError!.cleanupRoute.close();
	});
});
