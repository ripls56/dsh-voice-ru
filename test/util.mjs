// Shared helpers for the development harness: default cache locations, runtime
// discovery, sample audio, and a mock cordis context that drives the provider
// exactly like the DSH host does.
import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledRuntimeDir, locateRuntime, runtimePlan } from "../lib/runtime.js";

export const MODEL_NAME = "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf";
export const testDir = dirname(fileURLToPath(import.meta.url));

/** Same default cache root the plugin uses. */
export function defaultDataRoot() {
	const base = process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return join(base, "dsh-voice-ru");
}

/** Model file path: `DSH_VOICE_RU_MODEL` overrides the default cache location. */
export function modelPath() {
	return process.env.DSH_VOICE_RU_MODEL ?? join(defaultDataRoot(), "models", MODEL_NAME);
}

/** Install-root paths the runtime resolver expects. */
export function runtimePaths(dataRoot = defaultDataRoot()) {
	return { runtimeInstallRoot: join(dataRoot, "runtime"), bundledRuntimeDir: bundledRuntimeDir() };
}

/**
 * Locate an already-available runtime (bundled checkout copy or downloaded).
 * @returns `{ plan, runtimeDir, libraryPath }`
 */
export async function runtimeInfo({ dataRoot = defaultDataRoot(), config = {} } = {}) {
	const plan = runtimePlan();
	if (!plan) throw new Error(`no transcribe.cpp runtime for ${process.platform}-${process.arch}`);
	const found = await locateRuntime({ config, paths: runtimePaths(dataRoot), plan });
	if (!found) throw new Error("runtime is not installed yet; run test/runtime-smoke.mjs to download it");
	return { plan, runtimeDir: found.runtimeDir, libraryPath: found.libraryPath, source: found.source };
}

/** Audio sample shipped with the repository. */
export function sample(name) {
	return join(testDir, name);
}

/**
 * Mock cordis context: `speechToText.register` captures the provider and
 * `subprocess.spawn` launches plain Node instead of Electron.
 */
export function mockContext() {
	let provider;
	let effectDisposer;
	const ctx = {
		logger: {
			warn: (...args) => console.error("[warn]", ...args),
			error: (...args) => console.error("[error]", ...args),
		},
		effect(fn) {
			effectDisposer = fn();
		},
		speechToText: {
			register(registered) {
				provider = registered;
				return () => {};
			},
		},
		subprocess: {
			spawn({ argv, cwd, env, stdio, graceMs }) {
				const child = nodeSpawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
				let errText = "";
				child.stderr.on("data", (chunk) => {
					errText += chunk.toString("utf8");
					if (process.env.DSH_VOICE_RU_VERBOSE) process.stderr.write(`[worker] ${chunk}`);
				});
				const done = new Promise((resolve) => child.on("close", (code) => resolve({ code })));
				return {
					stdout: child.stdout,
					done,
					terminate: () => child.kill(),
					waitForExit: async () => done,
					collected: { stderr: { readFrom: () => ({ text: errText }) } },
				};
			},
		},
	};
	return { ctx, provider: () => provider, dispose: async () => await effectDisposer?.() };
}

/**
 * Wait until the provider leaves a transient preparation phase. The default
 * budget covers a full 751 MB model download on a slow link.
 */
export async function settledPreparation(provider, timeoutMs = 1_800_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const { phase } = provider.preparation.snapshot();
		if (phase !== "checking" && phase !== "downloading" && phase !== "cancelling") return phase;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("preparation did not settle in time");
}