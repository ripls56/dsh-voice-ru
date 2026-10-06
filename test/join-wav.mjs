// Concatenate canonical 16 kHz mono PCM16 WAV parts into one file.
// Usage: node join-wav.mjs out.wav part1.wav part2.wav ...
import { readFileSync, writeFileSync } from "node:fs";

const [out, ...parts] = process.argv.slice(2);
const chunks = parts.map((p) => {
	const buf = readFileSync(p);
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.readUInt32LE(24) !== 16000 || buf.readUInt16LE(22) !== 1 || buf.readUInt16LE(34) !== 16) {
		throw new Error(`${p} is not a canonical 16 kHz mono PCM16 WAV`);
	}
	return buf.subarray(44);
});
const total = chunks.reduce((n, c) => n + c.length, 0);
const header = Buffer.alloc(44);
header.write("RIFF", 0, "ascii");
header.writeUInt32LE(36 + total, 4);
header.write("WAVE", 8, "ascii");
header.write("fmt ", 12, "ascii");
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36, "ascii");
header.writeUInt32LE(total, 40);
writeFileSync(out, Buffer.concat([header, ...chunks]));
console.log(`${out}: ${(total / 32000).toFixed(2)}s`);