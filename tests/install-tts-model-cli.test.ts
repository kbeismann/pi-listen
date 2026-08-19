import { describe, expect, test } from "bun:test";
import { runTtsModelInstaller } from "../scripts/install-tts-model";
import type { TtsLocalModelInfo } from "../extensions/voice/tts-local-models";

const MODEL_ID = "pocket-tts-int8-en-2026-01-26";
const model = {
	id: MODEL_ID,
	name: "Pocket TTS English (int8)",
	size: "~94 MB",
} as TtsLocalModelInfo;

function outputCollector() {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		output: {
			log: (message: string) => { logs.push(message); },
			error: (message: string) => { errors.push(message); },
		},
		logs,
		errors,
	};
}

describe("TTS model installer CLI", () => {
	test("check mode accepts an already installed catalog model", async () => {
		const collected = outputCollector();
		const exitCode = await runTtsModelInstaller(
			["--check", MODEL_ID],
			{ getModel: () => model, isInstalled: () => true },
			collected.output,
		);

		expect(exitCode).toBe(0);
		expect(collected.logs).toEqual([`TTS model ${MODEL_ID} is installed.`]);
		expect(collected.errors).toEqual([]);
	});

	test("check mode reports a missing model without downloading", async () => {
		let installCount = 0;
		const collected = outputCollector();
		const exitCode = await runTtsModelInstaller(
			["--check", MODEL_ID],
			{
				getModel: () => model,
				isInstalled: () => false,
				ensureInstalled: async () => {
					installCount += 1;
					return { dir: "/unused", archiveSha256: "" };
				},
			},
			collected.output,
		);

		expect(exitCode).toBe(1);
		expect(installCount).toBe(0);
		expect(collected.errors).toEqual([`TTS model ${MODEL_ID} is not installed.`]);
	});

	test("install mode delegates download and verification to the catalog installer", async () => {
		const collected = outputCollector();
		const installedIds: string[] = [];
		const exitCode = await runTtsModelInstaller(
			[MODEL_ID],
			{
				getModel: () => model,
				isInstalled: () => false,
				ensureInstalled: async (modelId, options) => {
					installedIds.push(modelId);
					options.onProgress?.({ phase: "download", bytes: 50, totalBytes: 100 });
					options.onProgress?.({ phase: "verify" });
					options.onProgress?.({ phase: "done" });
					return { dir: `/models/${modelId}`, archiveSha256: "pinned" };
				},
			},
			collected.output,
		);

		expect(exitCode).toBe(0);
		expect(installedIds).toEqual([MODEL_ID]);
		expect(collected.logs).toContain("Downloading: 50%");
		expect(collected.logs).toContain("Verify...");
		expect(collected.logs.at(-1)).toBe(`Installed ${MODEL_ID} at /models/${MODEL_ID}.`);
	});

	test("invalid arguments return usage without touching the catalog", async () => {
		const collected = outputCollector();
		const exitCode = await runTtsModelInstaller([], {}, collected.output);

		expect(exitCode).toBe(2);
		expect(collected.errors[0]).toContain("Usage:");
	});
});
