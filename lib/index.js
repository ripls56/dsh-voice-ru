// dsh-voice-ru — Russian-capable local speech-to-text provider for DSH voice input.
//
// Registers an extra `speechToText` provider next to the built-in SenseVoice one
// (which cannot transcribe Russian). Engine: NVIDIA Nemotron 3.5 ASR Streaming
// 0.6B (GGUF Q8_0, 29 locales including ru-RU) on the transcribe.cpp native
// runtime, driven from a dedicated worker subprocess over loopback HTTP.
//
// Nothing binary ships in this repository: on first prepare() the plugin
// downloads the pinned transcribe.cpp runtime (per platform, sha256-verified)
// and the model weights (sha256-verified), both into the plugin's data root.
//
// Model:   https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf
// Runtime: https://github.com/handy-computer/transcribe.cpp (release v0.3.1)
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified, fileMatches } from "./download.js";
import { bundledRuntimeDir, ensureRuntime, locateRuntime, runtimePlan } from "./runtime.js";
import { LOCALES, toModelLanguage } from "./locales.js";

export const name = "dsh-voice-ru";
export const inject = ["speechToText", "subprocess"];

const languages = ["auto", ...Object.keys(LOCALES)];

const DEFAULTS = {
	providerId: "nemotron-local",
	/** Cache root for the runtime and model. Defaults to a per-user local directory. */
	dataRoot: undefined,
	/** Explicit transcribe.cpp artifact directory; skips the runtime download. */
	runtimeDir: undefined,
	/** Explicit model file; skips the model download and its hash check. */
	modelPath: undefined,
	modelUrl: "https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/main/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
	modelName: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
	modelBytes: 751094240,
	modelSha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
	backend: "auto",
	threads: 0,
	workerStartupTimeoutMs: 180000,
	inferenceTimeoutMs: 120000,
	idleTimeoutMs: 300000,
	maxPending: 4,
	graceMs: 1000,
	maxLogBytes: 65536,
	maxResponseBytes: 131072,
	progressIntervalMs: 200,
};

const BACKENDS = ["auto", "cpu", "vulkan", "cuda", "cpu_accel"];

/** Merge raw profile config over the defaults with explicit type checks. */
export function normalizeConfig(raw = {}) {
	const config = { ...DEFAULTS };
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		if (!(key in DEFAULTS)) throw new Error(`dsh-voice-ru: unknown config key: ${key}`);
		config[key] = value;
	}
	for (const key of ["providerId", "dataRoot", "runtimeDir", "modelPath", "modelUrl", "modelName", "modelSha256"]) {
		if (config[key] !== undefined && (typeof config[key] !== "string" || config[key].length < 1)) throw new Error(`dsh-voice-ru: ${key} must be a nonempty string`);
	}
	for (const key of ["modelBytes", "threads", "workerStartupTimeoutMs", "inferenceTimeoutMs", "idleTimeoutMs", "maxPending", "graceMs", "maxLogBytes", "maxResponseBytes", "progressIntervalMs"]) {
		if (!Number.isInteger(config[key]) || config[key] < 0) throw new Error(`dsh-voice-ru: ${key} must be a nonnegative integer`);
	}
	if (!BACKENDS.includes(config.backend)) throw new Error(`dsh-voice-ru: backend must be one of ${BACKENDS.join(", ")}`);
	if (!/^[0-9a-f]{64}$/.test(config.modelSha256)) throw new Error("dsh-voice-ru: modelSha256 must be 64 lowercase hex chars");
	return config;
}

/** A request rejected before inference; the loaded worker remains reusable. */
class SpeechInputError extends Error {}

function defaultDataRoot() {
	const base = process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return join(base, "dsh-voice-ru");
}

function resolvePaths(config) {
	const dataRoot = config.dataRoot ?? defaultDataRoot();
	return {
		dataRoot,
		runtimeInstallRoot: join(dataRoot, "runtime"),
		bundledRuntimeDir: bundledRuntimeDir(),
		modelPath: config.modelPath ?? join(dataRoot, "models", config.modelName),
		worker: fileURLToPath(new URL("./worker.js", import.meta.url)),
	};
}

/**
 * Owns preparation state, both downloads, and one serial worker process.
 * State phases mirror the built-in voice-input UI schema:
 * unprepared → checking → downloading → standby ⇄ ready (worker alive) → standby.
 */
class NemotronWorker {
	ctx;
	config;
	paths;
	plan;
	state;
	listeners = new Set();
	preparing;
	worker;
	tail = Promise.resolve();
	pending = 0;
	idle;
	lifetime = new AbortController();

	constructor(ctx, config, paths, plan) {
		this.ctx = ctx;
		this.config = config;
		this.paths = paths;
		this.plan = plan;
		this.state = { phase: "unprepared" };
	}

	snapshot() {
		return this.state;
	}

	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	publish(state) {
		this.state = state;
		for (const listener of this.listeners) listener();
	}

	/** The model needs its pinned size only when this plugin owns the download. */
	get modelBytes() {
		return this.config.modelPath === undefined ? this.config.modelBytes : undefined;
	}

	/** Inspect caches without downloading or starting anything. */
	inspect() {
		void (async () => {
			// Preparation owns the published state once it starts: a late inspect
			// result must never overwrite download progress or readiness.
			if (this.preparing || this.worker) return;
			try {
				this.publish({ phase: "checking", startedAt: Date.now() });
				const runtime = await locateRuntime({ config: this.config, paths: this.paths, plan: this.plan });
				const model = await fileMatches(this.paths.modelPath, this.modelBytes);
				if (this.preparing || this.worker) return;
				this.publish({ phase: runtime && model ? "standby" : "unprepared" });
			} catch (error) {
				if (this.preparing || this.worker) return;
				this.publish({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
			}
		})();
	}

	/** Download whatever is missing (runtime first, then model); joins a task in flight. */
	prepare() {
		if (this.preparing || this.worker) return;
		if (this.lifetime.signal.aborted) throw new Error("Speech provider disposed");
		const abort = new AbortController();
		const task = { abort, completed: false, settled: Promise.resolve() };
		this.preparing = task;
		task.settled = (async () => {
			const report = (state) => this.publish(state);
			try {
				this.publish({ phase: "checking", startedAt: Date.now() });
				await ensureRuntime({ config: this.config, paths: this.paths, plan: this.plan, signal: abort.signal, report });
				abort.signal.throwIfAborted();
				this.publish({ phase: "checking", startedAt: Date.now() });
				if (!(await fileMatches(this.paths.modelPath, this.modelBytes))) {
					await downloadVerified({
						url: this.config.modelUrl,
						destination: this.paths.modelPath,
						bytes: this.config.modelBytes,
						sha256: this.config.modelSha256,
						resource: this.config.modelName,
						step: "model",
						progressIntervalMs: this.config.progressIntervalMs,
					}, abort.signal, report);
				}
				abort.signal.throwIfAborted();
				this.publish({ phase: "standby" });
			} catch (error) {
				if (this.lifetime.signal.aborted) return;
				this.publish({ phase: abort.signal.aborted ? "cancelled" : "failed", message: error instanceof Error ? error.message : String(error) });
			} finally {
				this.preparing = undefined;
			}
		})();
	}

	async cancel() {
		const task = this.preparing;
		if (!task) return;
		if (!task.completed) {
			this.publish({ phase: "cancelling", startedAt: Date.now() });
			task.abort.abort(new Error("Speech preparation cancelled"));
		}
		await task.settled;
	}

	/** Queue one bounded recording; cancellation never leaves inference running after settlement. */
	async transcribe(input, signal) {
		const combined = AbortSignal.any([signal, this.lifetime.signal]);
		combined.throwIfAborted();
		if (this.pending >= this.config.maxPending) throw new Error("Speech transcription queue is full");
		clearTimeout(this.idle);
		this.pending++;
		const job = this.tail.then(async () => {
			combined.throwIfAborted();
			return await this.execute(input, combined);
		});
		this.tail = job.then(() => {}, () => {}).finally(() => {
			this.pending--;
			if (this.pending === 0 && !this.lifetime.signal.aborted && this.config.idleTimeoutMs > 0) {
				this.idle = setTimeout(() => {
					this.tail = this.tail.then(async () => await this.stop());
					this.tail.catch((error) => this.ctx.logger.warn("dsh-voice-ru idle cleanup failed", error));
				}, this.config.idleTimeoutMs);
			}
		});
		return await job;
	}

	async execute(input, signal) {
		const phase = this.state.phase;
		if (phase !== "ready" && phase !== "standby") throw new Error("Prepare the local speech provider before recording");
		try {
			const worker = await this.ensureWorker(signal);
			const language = toModelLanguage(input.language) ?? "";
			const call = AbortSignal.timeout(this.config.inferenceTimeoutMs);
			const abort = AbortSignal.any([signal, call]);
			const response = await fetch(`${worker.url}/transcribe?language=${encodeURIComponent(language)}`, {
				method: "POST",
				headers: { authorization: `Bearer ${worker.token}`, "content-type": "audio/wav" },
				body: Buffer.from(input.audio),
				signal: abort,
			}).catch((error) => {
				if (call.aborted && !signal.aborted) throw new Error("Speech inference timed out");
				throw error;
			});
			const value = await readJson(response, this.config.maxResponseBytes);
			if (!response.ok) {
				if ((response.status === 400 || response.status === 413) && value.code === "invalid-input") throw new SpeechInputError(value.error);
				throw new Error(value.error ?? `Worker returned HTTP ${response.status}`);
			}
			if (typeof value.text !== "string" || typeof value.audioSeconds !== "number" || typeof value.inferenceSeconds !== "number") throw new Error("Worker returned a malformed transcript");
			return { text: value.text, audioSeconds: value.audioSeconds, inferenceSeconds: value.inferenceSeconds };
		} catch (error) {
			if (error instanceof SpeechInputError) throw error;
			await this.stop();
			if (this.state.phase !== "unprepared" && this.state.phase !== "failed") this.publish({ phase: "standby" });
			throw error;
		}
	}

	async ensureWorker(signal) {
		if (this.worker && !this.worker.closed) return this.worker;
		if (this.worker) await this.stop();
		const runtime = await locateRuntime({ config: this.config, paths: this.paths, plan: this.plan });
		if (!runtime) {
			this.publish({ phase: "unprepared" });
			throw new Error("Speech runtime is missing; prepare the provider first");
		}
		if (!(await fileMatches(this.paths.modelPath, this.modelBytes))) {
			this.publish({ phase: "unprepared" });
			throw new Error("Speech model is missing; prepare the provider first");
		}
		this.publish({ phase: "loading", startedAt: Date.now() });
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.workerStartupTimeoutMs)]);
		const token = randomBytes(32).toString("hex");
		const handle = this.ctx.subprocess.spawn({
			argv: [process.execPath, this.paths.worker, JSON.stringify({
				runtimeDir: runtime.runtimeDir,
				dllPath: runtime.libraryPath,
				modelPath: this.paths.modelPath,
				backend: this.config.backend,
				threads: this.config.threads,
			})],
			cwd: this.paths.dataRoot,
			graceMs: this.config.graceMs,
			env: { DSH_VOICE_RU_TOKEN: token, ELECTRON_RUN_AS_NODE: "1" },
			stdio: { stdin: "ignore", stdout: "pipe", stderr: { maxBytes: this.config.maxLogBytes } },
		});
		try {
			const port = await readReadyPort(handle, this.config.maxLogBytes, deadline);
			const worker = { handle, url: `http://127.0.0.1:${port}`, token, closed: false };
			this.worker = worker;
			this.publish({ phase: "ready" });
			const exited = () => {
				if (!worker.closed) {
					worker.closed = true;
					if (this.worker === worker) this.worker = undefined;
					if (this.state.phase === "ready") this.publish({ phase: "standby" });
				}
			};
			handle.done.then(exited, exited);
			return worker;
		} catch (error) {
			handle.terminate();
			await handle.waitForExit();
			throw error;
		}
	}

	async stop() {
		const worker = this.worker;
		if (!worker) return;
		worker.closed = true;
		this.worker = undefined;
		worker.handle.terminate();
		await worker.handle.waitForExit();
		if (this.state.phase === "ready") this.publish({ phase: "standby" });
	}

	async dispose() {
		this.listeners.clear();
		this.lifetime.abort(new Error("dsh-voice-ru provider disposed"));
		clearTimeout(this.idle);
		try {
			await this.tail;
		} finally {
			await this.stop();
		}
		await this.preparing?.settled;
	}
}

async function readJson(response, limit) {
	if (!response.body) throw new Error("Worker returned no response");
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > limit) throw new Error("Worker response exceeded its byte limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Read the first stdout line {"port":N}; reject on early exit. */
async function readReadyPort(handle, limit, signal) {
	if (!handle.stdout) throw new Error("Speech worker stdout is unavailable");
	signal.throwIfAborted();
	let text = "";
	const pending = Promise.withResolvers();
	const data = (chunk) => {
		text += chunk.toString("utf8");
		if (Buffer.byteLength(text) > limit) {
			pending.reject(new Error("Speech worker readiness exceeded its byte limit"));
			return;
		}
		const end = text.indexOf("\n");
		if (end < 0) return;
		try {
			const value = JSON.parse(text.slice(0, end));
			if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("bad port");
			pending.resolve(value.port);
		} catch (error) {
			pending.reject(new Error("Invalid speech worker readiness", { cause: error }));
		}
	};
	handle.stdout.on("data", data);
	handle.stdout.on("error", pending.reject);
	handle.done.then(() => {
		pending.reject(new Error(`Speech worker exited before readiness: ${handle.collected?.stderr?.readFrom?.(0)?.text ?? ""}`));
	}, pending.reject);
	const abort = () => pending.reject(signal.reason instanceof Error ? signal.reason : new Error("Speech worker startup cancelled"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await pending.promise;
	} finally {
		handle.stdout.off("data", data);
		handle.stdout.off("error", pending.reject);
		signal.removeEventListener("abort", abort);
		handle.stdout.resume?.();
	}
}

export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig ?? {});
	const plan = runtimePlan();
	if (!plan) {
		ctx.logger.warn(`dsh-voice-ru: no transcribe.cpp runtime for ${process.platform}-${process.arch}; provider not registered`);
		return;
	}
	for (const path of [config.dataRoot, config.runtimeDir, config.modelPath]) {
		if (path !== undefined && !isAbsolute(path)) throw new Error(`dsh-voice-ru paths must be absolute: ${path}`);
	}
	const paths = resolvePaths(config);
	const worker = new NemotronWorker(ctx, config, paths, plan);
	ctx.effect(() => {
		const unregister = ctx.speechToText.register({
			info: {
				id: config.providerId,
				name: "Nemotron 3.5 ASR 0.6B (Q8_0 GGUF)",
				location: "host-local",
				languages,
				downloadSources: [new URL(config.modelUrl).origin],
				setupEstimate: {
					recommendedDiskBytes: config.modelBytes + plan.bytes + 64 * 1024 * 1024,
					expectedMemoryBytes: 1200 * 1024 * 1024,
					minimumMinutes: 1,
					maximumMinutes: 20,
				},
			},
			preparation: worker,
			transcribe: async (input, signal) => await worker.transcribe(input, signal),
		});
		worker.inspect();
		return async () => {
			const removing = unregister();
			await worker.dispose();
			await removing;
		};
	});
}

export { languages, LOCALES, runtimePlan };