#!/usr/bin/env bun

import {
	ensureTtsModelInstalled,
	getTtsModel,
	isTtsModelInstalled,
	type TtsInstallProgress,
	type TtsInstallResult,
	type TtsLocalModelInfo,
} from "../extensions/voice/tts-local-models";

interface InstallerDependencies {
	ensureInstalled?: (
		modelId: string,
		opts: { onProgress?: (progress: TtsInstallProgress) => void },
	) => Promise<TtsInstallResult>;
	getModel?: (modelId: string) => TtsLocalModelInfo;
	isInstalled?: (modelId: string) => boolean;
}

interface InstallerOutput {
	log(message: string): void;
	error(message: string): void;
}

const USAGE = `Usage:
  bun scripts/install-tts-model.ts <model-id>
  bun scripts/install-tts-model.ts --check <model-id>

Install or verify one model from pi-listen's pinned TTS catalog.`;

function progressReporter(output: InstallerOutput) {
	let lastPhase = "";
	let lastDownloadBucket = -1;
	return (progress: TtsInstallProgress) => {
		if (progress.phase === "download" && progress.totalBytes && progress.totalBytes > 0) {
			const percent = Math.min(100, Math.floor((progress.bytes ?? 0) * 100 / progress.totalBytes));
			const bucket = Math.floor(percent / 10) * 10;
			if (bucket !== lastDownloadBucket) {
				lastDownloadBucket = bucket;
				output.log(`Downloading: ${bucket}%`);
			}
			return;
		}
		if (progress.phase !== lastPhase) {
			lastPhase = progress.phase;
			output.log(`${progress.phase[0]!.toUpperCase()}${progress.phase.slice(1)}...`);
		}
	};
}

export async function runTtsModelInstaller(
	args: string[],
	dependencies: InstallerDependencies = {},
	output: InstallerOutput = console,
): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		output.log(USAGE);
		return 0;
	}
	const checkOnly = args[0] === "--check";
	const modelId = checkOnly ? args[1] : args[0];
	if (!modelId || args.length !== (checkOnly ? 2 : 1)) {
		output.error(USAGE);
		return 2;
	}

	const ensureInstalled = dependencies.ensureInstalled ?? ensureTtsModelInstalled;
	const getModel = dependencies.getModel ?? getTtsModel;
	const isInstalled = dependencies.isInstalled ?? isTtsModelInstalled;
	let model: TtsLocalModelInfo;
	try {
		model = getModel(modelId);
	} catch (error) {
		output.error(error instanceof Error ? error.message : String(error));
		return 2;
	}

	if (isInstalled(model.id)) {
		output.log(`TTS model ${model.id} is installed.`);
		return 0;
	}
	if (checkOnly) {
		output.error(`TTS model ${model.id} is not installed.`);
		return 1;
	}

	output.log(`Installing ${model.name} (${model.size})...`);
	try {
		const result = await ensureInstalled(model.id, {
			onProgress: progressReporter(output),
		});
		output.log(`Installed ${model.id} at ${result.dir}.`);
		return 0;
	} catch (error) {
		output.error(`Could not install ${model.id}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await runTtsModelInstaller(process.argv.slice(2));
}
