// Run one WAV through the real worker with several language hints and print the
// transcripts side by side. This is how the ru-vs-auto behaviour was measured.
// Usage: node test/lang-probe.mjs [wav] [lang ...]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { modelPath, runtimeInfo, sample } from "./util.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..");
const token = "probe-token";
const wavPath = process.argv[2] ?? sample("mixed-sample.wav");
const languages = process.argv.slice(3);
if (languages.length === 0) languages.push("ru-RU", "auto", "en-US");

const { runtimeDir, libraryPath } = await runtimeInfo();
const config = { runtimeDir, dllPath: libraryPath, modelPath: modelPath(), backend: "auto", threads: 0 };

const child = spawn(process.execPath, [join(root, "lib", "worker.js"), JSON.stringify(config)], {
	env: { ...process.env, DSH_VOICE_RU_TOKEN: token, ELECTRON_RUN_AS_NODE: "1" },
	stdio: ["ignore", "pipe", "ignore"],
});

const port = await new Promise((resolve, reject) => {
	let buffer = "";
	const onData = (chunk) => {
		buffer += chunk.toString("utf8");
		const end = buffer.indexOf("\n");
		if (end < 0) return;
		child.stdout.off("data", onData);
		try {
			resolve(JSON.parse(buffer.slice(0, end)).port);
		} catch (error) {
			reject(error);
		}
	};
	child.stdout.on("data", onData);
	child.on("exit", (code) => reject(new Error(`worker exited early: ${code}`)));
	setTimeout(() => reject(new Error("worker startup timeout")), 300000).unref?.();
});

const wav = readFileSync(wavPath);
console.log(`file: ${wavPath} (${((wav.length - 44) / 32000).toFixed(2)}s)`);
for (const language of languages) {
	const response = await fetch(`http://127.0.0.1:${port}/transcribe?language=${encodeURIComponent(language)}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "audio/wav" },
		body: wav,
	});
	const value = await response.json();
	console.log(`\n[${language}] ${response.status}${value.inferenceSeconds ? `  ${value.inferenceSeconds.toFixed(2)}s` : ""}`);
	console.log(value.text ?? JSON.stringify(value));
}
child.kill();
process.exit(0);