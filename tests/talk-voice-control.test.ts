import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm, unlink } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTalkVoiceControlServer,
	talkVoiceSocketPath,
	type TalkVoiceAction,
	type TalkVoiceChannel,
	type TalkVoiceState,
} from "../extensions/voice/talk-voice-control";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
		recursive: true,
		force: true,
	})));
});

async function makeSocketPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-talk-voice-test-"));
	temporaryDirectories.push(directory);
	return join(directory, "talk.sock");
}

function request(socketPath: string, payload?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let response = "";
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		socket.setEncoding("utf8");
		socket.once("connect", () => {
			if (payload !== undefined) socket.write(payload);
		});
		socket.on("data", (chunk: string) => { response += chunk; });
		socket.once("end", () => {
			if (settled) return;
			settled = true;
			resolve(response.trim());
		});
		socket.once("error", fail);
	});
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function createStaleSocket(socketPath: string): Promise<void> {
	const program = [
		"const server = require('node:net').createServer();",
		`server.listen(${JSON.stringify(socketPath)}, () => {`,
		"  process.stdout.write('ready');",
		"  process.kill(process.pid, 'SIGKILL');",
		"});",
	].join("\n");
	const child = spawn(process.execPath, ["-e", program], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise<void>((resolve, reject) => {
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.includes("ready")) resolve();
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (!output.includes("ready")) reject(new Error(`Stale socket helper exited before listening (${code}).`));
		});
	});
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("Talk voice control socket", () => {
	test("serves only bounded input and output gate controls with mode 0600", async () => {
		const socketPath = await makeSocketPath();
		const state: TalkVoiceState = { inputEnabled: false, outputEnabled: false };
		const calls: Array<[TalkVoiceChannel, TalkVoiceAction]> = [];
		const control = createTalkVoiceControlServer((channel, action) => {
			calls.push([channel, action]);
			if (action === "on") state[`${channel}Enabled`] = true;
			if (action === "off") state[`${channel}Enabled`] = false;
			if (action === "toggle") state[`${channel}Enabled`] = !state[`${channel}Enabled`];
			return { ...state };
		}, undefined, { socketPath });

		await control.start();
		expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
		expect(await request(socketPath, "input status\n")).toBe("input off");
		expect(await request(socketPath, "input on\n")).toBe("input on");
		expect(await request(socketPath, "input toggle\n")).toBe("input off");
		expect(await request(socketPath, "output on\n")).toBe("output on");
		expect(await request(socketPath, "talk on\n")).toStartWith("error Voice channel must be input or output.");
		expect(calls).toEqual([
			["input", "status"],
			["input", "on"],
			["input", "toggle"],
			["output", "on"],
		]);

		await control.stop();
		await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("rejects oversized and incomplete requests without invoking gate controls", async () => {
		const socketPath = await makeSocketPath();
		let calls = 0;
		const control = createTalkVoiceControlServer(() => {
			calls += 1;
			return { inputEnabled: false, outputEnabled: false };
		}, undefined, { socketPath, requestTimeoutMs: 20 });

		await control.start();
		expect(await request(socketPath, `input ${"x".repeat(128)}\n`)).toBe("error Talk voice control request is too large.");
		expect(await request(socketPath)).toBe("error Talk voice control request timed out.");
		expect(calls).toBe(0);
		await control.stop();
	});

	test("removes a safely identified stale socket but never steals a live owner", async () => {
		const stalePath = await makeSocketPath();
		await createStaleSocket(stalePath);
		expect((await lstat(stalePath)).isSocket()).toBe(true);
		const staleControl = createTalkVoiceControlServer(
			() => ({ inputEnabled: false, outputEnabled: false }),
			undefined,
			{ socketPath: stalePath },
		);
		await staleControl.start();
		await staleControl.stop();

		const livePath = await makeSocketPath();
		const liveOwner = createServer();
		await listen(liveOwner, livePath);
		const control = createTalkVoiceControlServer(
			() => ({ inputEnabled: false, outputEnabled: false }),
			undefined,
			{ socketPath: livePath },
		);
		await expect(control.start()).rejects.toThrow("already active");
		await close(liveOwner);
	});

	test("preserves a replacement socket during inode-safe cleanup", async () => {
		const socketPath = await makeSocketPath();
		const control = createTalkVoiceControlServer(
			() => ({ inputEnabled: false, outputEnabled: false }),
			undefined,
			{ socketPath },
		);
		await control.start();
		await unlink(socketPath);
		const replacement = createServer();
		await listen(replacement, socketPath);
		const replacementIdentity = await lstat(socketPath);

		await control.stop();
		const remaining = await lstat(socketPath);
		expect(remaining.dev).toBe(replacementIdentity.dev);
		expect(remaining.ino).toBe(replacementIdentity.ino);
		await close(replacement);
	});

	test("uses PI_TALK_VOICE_SOCKET when it is configured", () => {
		const previous = process.env.PI_TALK_VOICE_SOCKET;
		const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
		process.env.PI_TALK_VOICE_SOCKET = "/tmp/configured-talk.sock";
		try {
			expect(talkVoiceSocketPath()).toBe("/tmp/configured-talk.sock");
			delete process.env.PI_TALK_VOICE_SOCKET;
			process.env.XDG_RUNTIME_DIR = "/tmp/pi-talk-runtime";
			expect(talkVoiceSocketPath()).toBe("/tmp/pi-talk-runtime/pi-talk-voice.sock");
		} finally {
			if (previous === undefined) delete process.env.PI_TALK_VOICE_SOCKET;
			else process.env.PI_TALK_VOICE_SOCKET = previous;
			if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
		}
	});
});
