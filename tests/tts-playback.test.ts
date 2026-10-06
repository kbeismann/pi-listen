import { describe, expect, test } from "bun:test";
import {
	encodeWav,
	isWslRuntime,
	play,
	selectPlaybackPlayer,
	selectStreamingPlayer,
} from "../extensions/voice/tts-playback";

describe("encodeWav — WAV header correctness", () => {
	test("standard 24kHz mono short clip", () => {
		const samples = new Float32Array(2400); // 0.1s of silence at 24k
		const wav = encodeWav(samples, 24000);

		// RIFF header
		expect(wav[0]).toBe(0x52); // R
		expect(wav[1]).toBe(0x49); // I
		expect(wav[2]).toBe(0x46); // F
		expect(wav[3]).toBe(0x46); // F
		// WAVE
		expect(wav[8]).toBe(0x57);  // W
		expect(wav[11]).toBe(0x45); // E

		// 44-byte header + 2 bytes per sample
		expect(wav.byteLength).toBe(44 + samples.length * 2);

		// Sample rate field at offset 24, little-endian uint32
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		expect(view.getUint32(24, true)).toBe(24000);
	});

	test("clamps out-of-range floats to int16 limits", () => {
		const samples = new Float32Array([2.0, -2.0, 0]);
		const wav = encodeWav(samples, 16000);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		// Sample 0 (value 2.0) → clamped to 1.0 → 0x7FFF
		expect(view.getInt16(44, true)).toBe(0x7FFF);
		// Sample 1 (value -2.0) → clamped to -1.0 → -0x8000
		expect(view.getInt16(46, true)).toBe(-0x8000);
		// Sample 2 (value 0) → 0
		expect(view.getInt16(48, true)).toBe(0);
	});

	test("NaN and Infinity become silence (0), not -1 / clamped extremes", () => {
		const samples = new Float32Array([NaN, Infinity, -Infinity, 0]);
		const wav = encodeWav(samples, 16000);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		// All non-finite values are treated as silence per the encoder
		// contract — NaN/+Inf/-Inf all become 0, defending against a TTS
		// engine emitting bad samples after a numerical instability.
		expect(view.getInt16(44, true)).toBe(0); // NaN → 0
		expect(view.getInt16(46, true)).toBe(0); // +Inf → 0
		expect(view.getInt16(48, true)).toBe(0); // -Inf → 0
		expect(view.getInt16(50, true)).toBe(0); // 0 → 0
	});

	test("rejects non-finite sample rate", () => {
		const samples = new Float32Array(10);
		expect(() => encodeWav(samples, 0)).toThrow(/Invalid sample rate/);
		expect(() => encodeWav(samples, NaN)).toThrow(/Invalid sample rate/);
		expect(() => encodeWav(samples, -1)).toThrow(/Invalid sample rate/);
	});

	test("guards against WAV uint32 overflow on huge inputs", () => {
		// We can't actually allocate 2GB in a test, but we can mock a
		// length value via a Float32Array proxy — too elaborate. Just
		// confirm the guard exists by inspecting the error path with a
		// crafted samples-like object.
		const huge: any = { length: 0xFFFFFFFF };
		expect(() => encodeWav(huge as Float32Array, 24000)).toThrow(/exceeds WAV uint32/);
	});
});

describe("play — abort signal handling", () => {
	test("pre-aborted signal rejects with AbortError before writing file", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(
			play({
				source: { samples: new Float32Array(10), sampleRate: 16000 },
				signal: ac.signal,
			}),
		).rejects.toThrow(/aborted/i);
	});

	test("playerOverride stub completes without spawning real player", async () => {
		// Stubbed player that exits 0 immediately. Verifies the play()
		// pipeline (write WAV, spawn, wait for close) without depending
		// on a system audio player being present in CI.
		const stubPlayer = {
			cmd: process.platform === "win32" ? "cmd" : "true",
			args: () => process.platform === "win32" ? ["/c", "exit", "0"] : [],
		};
		await play({
			source: { samples: new Float32Array(10), sampleRate: 16000 },
			playerOverride: stubPlayer,
		});
		// If we get here the promise resolved.
		expect(true).toBe(true);
	});

	test("stdin WAV transport sends the complete encoded clip", async () => {
		const sampleCount = 10;
		const expectedBytes = 44 + sampleCount * 2;
		await play({
			source: { samples: new Float32Array(sampleCount), sampleRate: 16000 },
			playerOverride: {
				cmd: process.execPath,
				transport: "stdin-wav",
				args: () => [
					"-e",
					`let bytes = 0;
process.stdin.on("data", chunk => { bytes += chunk.length; });
process.stdin.on("end", () => process.exit(bytes === ${expectedBytes} ? 0 : 1));`,
				],
			},
		});
	});

	test("aborts an active stdin WAV player", async () => {
		const controller = new AbortController();
		const playback = play({
			source: { samples: new Float32Array(10), sampleRate: 16000 },
			signal: controller.signal,
			playerOverride: {
				cmd: process.execPath,
				transport: "stdin-wav",
				args: () => [
					"-e",
					`process.stdin.resume();
process.stdin.on("end", () => setTimeout(() => process.exit(0), 10_000));`,
				],
			},
		});
		setTimeout(() => controller.abort(), 20);

		await expect(playback).rejects.toThrow(/aborted/i);
	});
});

describe("WSL playback selection", () => {
	test("detects Microsoft kernels or WSL interop only on Linux", () => {
		expect(isWslRuntime("linux", "6.6.0-microsoft-standard-WSL2", {})).toBe(true);
		expect(isWslRuntime("linux", "6.6.0-generic", { WSL_INTEROP: "/run/WSL/1_interop" })).toBe(true);
		expect(isWslRuntime("linux", "6.6.0-generic", {})).toBe(false);
		expect(isWslRuntime("darwin", "microsoft", { WSL_INTEROP: "present" })).toBe(false);
	});

	test("uses Windows SoundPlayer with a complete WAV over stdin", () => {
		const player = selectPlaybackPlayer("linux", undefined, true, () => true);

		expect(player.cmd).toBe("powershell.exe");
		expect(player.transport).toBe("stdin-wav");
		expect(player.args("").join(" ")).toContain("OpenStandardInput");
		expect(player.args("").join(" ")).toContain("PlaySync");
	});

	test("retains the named PulseAudio sink for echo cancellation", () => {
		const player = selectPlaybackPlayer("linux", "talk_aec_sink", true, () => true);

		expect(player.cmd).toBe("paplay");
		expect(player.args("/tmp/audio.wav")).toEqual([
			"--device=talk_aec_sink",
			"/tmp/audio.wav",
		]);
	});

	test("retains Linux playback when Windows interop is unavailable", () => {
		const player = selectPlaybackPlayer(
			"linux",
			undefined,
			true,
			(command) => command !== "powershell.exe",
		);

		expect(player.cmd).toBe("paplay");
	});
});

describe("streaming player selection", () => {
	test("Linux prefers paplay even when ffplay is installed", () => {
		const player = selectStreamingPlayer("linux", 24_000, undefined, () => true);

		expect(player?.cmd).toBe("paplay");
		expect(player?.args).toContain("--rate=24000");
		expect(player?.silenceTailSeconds).toBe(0);
	});

	test("macOS retains the ffplay streaming path", () => {
		const player = selectStreamingPlayer("darwin", 24_000, undefined, () => true);

		expect(player?.cmd).toBe("ffplay");
		expect(player?.silenceTailSeconds).toBe(1);
	});

	test("a named Linux sink never falls through when paplay is unavailable", () => {
		const player = selectStreamingPlayer(
			"linux",
			24_000,
			"talk_aec_sink",
			(command) => command !== "paplay",
			true,
		);

		expect(player).toBeNull();
	});

	test("WSL uses complete-WAV playback when Windows interop is available", () => {
		const player = selectStreamingPlayer(
			"linux",
			24_000,
			undefined,
			() => true,
			true,
		);

		expect(player).toBeNull();
	});

	test("WSL keeps streaming through an available named PulseAudio sink", () => {
		const player = selectStreamingPlayer(
			"linux",
			24_000,
			"talk_aec_sink",
			() => true,
			true,
		);

		expect(player?.cmd).toBe("paplay");
		expect(player?.args).toContain("--device=talk_aec_sink");
	});

	test("WSL retains paplay streaming when Windows interop is unavailable", () => {
		const player = selectStreamingPlayer(
			"linux",
			24_000,
			undefined,
			(command) => command !== "powershell.exe",
			true,
		);

		expect(player?.cmd).toBe("paplay");
	});
});
