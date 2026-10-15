import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("documentation", () => {
	test("README mentions Deepgram setup", () => {
		const readme = read("README.md");
		expect(readme).toContain("DEEPGRAM_API_KEY");
		expect(readme).toContain("dpgr.am/pi-voice");
		expect(readme).toContain("/voice test");
		expect(readme).toContain("/voice-settings");
	});

	test("README documents audio fallback chain", () => {
		const readme = read("README.md");
		expect(readme).toContain("sox");
		expect(readme).toContain("ffmpeg");
		expect(readme).toContain("arecord");
	});

	test("package.json has correct metadata", () => {
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.name).toBe("@codexstar/pi-listen");
		expect(pkg.pi?.extensions).toContain("./extensions/voice.ts");
		expect(pkg.keywords).toContain("pi-extension");
		expect(pkg.keywords).toContain("deepgram");
	});

	test("TypeBox uses Pi's runtime copy and a development-only local copy", () => {
		// A production copy can bypass Pi's loader and duplicate runtime modules.
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.dependencies?.typebox).toBeUndefined();
		expect(pkg.peerDependencies?.typebox).toBe("*");
		expect(typeof pkg.devDependencies?.typebox).toBe("string");
	});
});
