/** Expose Talk's audio gates over a bounded, per-user Unix socket. */

import { chmod, lstat, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export type TalkVoiceChannel = "input" | "output";
export type TalkVoiceAction = "on" | "off" | "toggle" | "status";

export interface TalkVoiceState {
	inputEnabled: boolean;
	outputEnabled: boolean;
}

export interface TalkVoiceControlServer {
	start(): Promise<void>;
	stop(): Promise<void>;
}

interface TalkVoiceControlOptions {
	socketPath?: string;
	requestTimeoutMs?: number;
}

interface SocketIdentity {
	device: number;
	inode: number;
}

const MAX_REQUEST_BYTES = 128;
const REQUEST_TIMEOUT_MS = 1_000;
const SOCKET_FILE_NAME = "pi-talk-voice.sock";

export function talkVoiceSocketPath(): string {
	const configuredPath = process.env.PI_TALK_VOICE_SOCKET;
	if (configuredPath) return configuredPath;
	const userId = process.getuid?.();
	const runtimeDirectory = process.env.XDG_RUNTIME_DIR
		?? (userId === undefined ? undefined : `/run/user/${userId}`);
	if (!runtimeDirectory) {
		throw new Error("Talk voice control requires XDG_RUNTIME_DIR or a numeric user ID.");
	}
	return join(runtimeDirectory, SOCKET_FILE_NAME);
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function sameSocketIdentity(status: { dev: number; ino: number }, identity: SocketIdentity): boolean {
	return status.dev === identity.device && status.ino === identity.inode;
}

function parseRequest(request: string): { channel: TalkVoiceChannel; action: TalkVoiceAction } {
	const parts = request.trim().split(/\s+/);
	if (parts.length !== 2) throw new Error("Expected: input|output on|off|toggle|status");
	const [channel, action] = parts;
	if (channel !== "input" && channel !== "output") {
		throw new Error("Voice channel must be input or output.");
	}
	if (action !== "on" && action !== "off" && action !== "toggle" && action !== "status") {
		throw new Error("Voice action must be on, off, toggle, or status.");
	}
	return { channel, action };
}

function responseLine(state: TalkVoiceState, channel: TalkVoiceChannel): string {
	const enabled = channel === "input" ? state.inputEnabled : state.outputEnabled;
	return `${channel} ${enabled ? "on" : "off"}`;
}

async function socketIsLive(socketPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out while checking existing Talk socket: ${socketPath}`));
		}, REQUEST_TIMEOUT_MS);
		timeout.unref();
		socket.once("connect", () => {
			clearTimeout(timeout);
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ECONNREFUSED" || code === "ENOENT") resolve(false);
			else reject(error);
		});
	});
}

/**
 * The socket accepts exactly one bounded gate-control request. It deliberately
 * has no command to enable Talk or inject text into Pi, keeping ownership of
 * Talk's lifecycle and conversation input in the interactive controller.
 */
export function createTalkVoiceControlServer(
	handle: (channel: TalkVoiceChannel, action: TalkVoiceAction) => TalkVoiceState,
	onError: (message: string) => void = () => {},
	options: TalkVoiceControlOptions = {},
): TalkVoiceControlServer {
	let server: Server | undefined;
	let socketPath: string | undefined;
	let socketIdentity: SocketIdentity | undefined;
	let requestTail = Promise.resolve();
	const sockets = new Set<Socket>();

	async function removeSocketIfOwned(): Promise<void> {
		const ownedIdentity = socketIdentity;
		socketIdentity = undefined;
		if (!socketPath || !ownedIdentity) return;
		try {
			const status = await lstat(socketPath);
			if (status.isSocket() && sameSocketIdentity(status, ownedIdentity)) {
				await unlink(socketPath);
			}
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}

	async function removeStaleSocket(path: string, identity: SocketIdentity): Promise<void> {
		try {
			const status = await lstat(path);
			if (!status.isSocket()) {
				throw new Error(`Refusing to replace non-socket path: ${path}`);
			}
			if (sameSocketIdentity(status, identity)) await unlink(path);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}

	async function closeServerWithoutRemovingReplacement(activeServer: Server): Promise<void> {
		let displacedPath: string | undefined;
		if (socketPath && socketIdentity) {
			try {
				const status = await lstat(socketPath);
				if (!sameSocketIdentity(status, socketIdentity)) {
					displacedPath = `${socketPath}.preserve-${randomUUID()}`;
					await rename(socketPath, displacedPath);
				}
			} catch (error) {
				if (!isMissingFile(error)) throw error;
			}
		}

		try {
			await new Promise<void>((resolve) => activeServer.close(() => resolve()));
		} finally {
			if (!displacedPath || !socketPath) return;
			try {
				await lstat(socketPath);
				throw new Error(`Refusing to overwrite replacement Talk socket: ${socketPath}`);
			} catch (error) {
				if (!isMissingFile(error)) throw error;
			}
			await rename(displacedPath, socketPath);
		}
	}

	function serve(socket: Socket): void {
		sockets.add(socket);
		socket.setEncoding("utf8");
		let request = "";
		let handled = false;
		const requestTimeout = setTimeout(() => {
			if (handled) return;
			handled = true;
			socket.end("error Talk voice control request timed out.\n");
		}, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
		requestTimeout.unref();

		const finish = (): void => {
			if (handled) return;
			handled = true;
			clearTimeout(requestTimeout);
			requestTail = requestTail.catch(() => {}).then(() => {
				try {
					const parsed = parseRequest(request);
					const state = handle(parsed.channel, parsed.action);
					socket.end(`${responseLine(state, parsed.channel)}\n`);
				} catch (error) {
					socket.end(`error ${error instanceof Error ? error.message : String(error)}\n`);
				}
			});
		};

		socket.on("data", (chunk: string) => {
			if (handled) return;
			request += chunk;
			if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) {
				handled = true;
				clearTimeout(requestTimeout);
				socket.end("error Talk voice control request is too large.\n");
				return;
			}
			if (request.includes("\n")) finish();
		});
		socket.on("end", finish);
		socket.on("close", () => {
			clearTimeout(requestTimeout);
			sockets.delete(socket);
		});
		socket.on("error", () => {
			clearTimeout(requestTimeout);
			sockets.delete(socket);
		});
	}

	return {
		async start(): Promise<void> {
			if (server) return;
			socketPath = options.socketPath ?? talkVoiceSocketPath();
			try {
				const status = await lstat(socketPath);
				if (!status.isSocket()) {
					throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
				}
				if (await socketIsLive(socketPath)) {
					throw new Error(`Talk voice control is already active at ${socketPath}`);
				}
				await removeStaleSocket(socketPath, { device: status.dev, inode: status.ino });
			} catch (error) {
				if (!isMissingFile(error)) {
					socketPath = undefined;
					throw error;
				}
			}

			const nextServer = createServer(serve);
			try {
				await new Promise<void>((resolve, reject) => {
					const onError = (error: Error): void => {
						nextServer.off("listening", onListening);
						reject(error);
					};
					const onListening = (): void => {
						nextServer.off("error", onError);
						resolve();
					};
					nextServer.once("error", onError);
					nextServer.once("listening", onListening);
					nextServer.listen(socketPath);
				});
				const status = await lstat(socketPath);
				if (!status.isSocket()) throw new Error(`Talk voice control did not create a socket: ${socketPath}`);
				socketIdentity = { device: status.dev, inode: status.ino };
				server = nextServer;
				server.on("error", (error) => onError(error.message));
				server.unref();
				await chmod(socketPath, 0o600);
			} catch (error) {
				server = undefined;
				try { await new Promise<void>((resolve) => nextServer.close(() => resolve())); } catch {}
				await removeSocketIfOwned();
				socketPath = undefined;
				throw error;
			}
		},

		async stop(): Promise<void> {
			const activeServer = server;
			server = undefined;
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			if (activeServer) {
				await closeServerWithoutRemovingReplacement(activeServer);
			}
			await removeSocketIfOwned();
			socketPath = undefined;
		},
	};
}
