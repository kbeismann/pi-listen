/** Encode raw mono signed 16-bit little-endian PCM as an in-memory WAV file. */
export function encodeMonoPcm16leWav(pcmData: Buffer, sampleRate: number): Buffer {
	if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
		throw new Error(`WAV sample rate must be a positive integer (got ${sampleRate}).`);
	}
	if (pcmData.byteLength % 2 !== 0) {
		throw new Error("16-bit PCM must contain a whole number of samples.");
	}
	if (pcmData.byteLength > 0xffff_ffff - 36) {
		throw new Error("PCM data is too large for a WAV file.");
	}

	const header = Buffer.alloc(44);
	const channelCount = 1;
	const bytesPerSample = 2;
	const byteRate = sampleRate * channelCount * bytesPerSample;
	if (byteRate > 0xffff_ffff) {
		throw new Error(`WAV sample rate is too large (got ${sampleRate}).`);
	}

	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcmData.byteLength, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channelCount, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(channelCount * bytesPerSample, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcmData.byteLength, 40);

	return Buffer.concat([header, pcmData]);
}
