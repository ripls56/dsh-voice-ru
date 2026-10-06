// dsh-voice-ru transcription worker.
// Spawned by the host plugin as: <electron-as-node> worker.js '<json-config>'
// Loads transcribe.dll (transcribe.cpp native runtime) via koffi, keeps one
// Nemotron 3.5 ASR session warm, and serves POST /transcribe over loopback
// HTTP with a bearer token. First stdout line: {"port":<n>}.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { toModelLanguage } from "./locales.js";

const require = createRequire(import.meta.url);
const koffi = require("koffi");

const config = JSON.parse(process.argv[2]);
const token = process.env.DSH_VOICE_RU_TOKEN;
if (!token) throw new Error("DSH_VOICE_RU_TOKEN is required");

const log = (...args) => console.error("[dsh-voice-ru]", ...args);

// ---------------------------------------------------------------------------
// FFI bindings (transcribe.h v0.3.1)
// ---------------------------------------------------------------------------
const lib = koffi.load(config.dllPath);

const RunParams = koffi.struct("transcribe_run_params", {
	struct_size: "uint64",
	task: "int",
	timestamps: "int",
	pnc: "int",
	itn: "int",
	diarize: "int",
	language: "const char *",
	target_language: "const char *",
	keep_special_tags: "bool",
	family: "void *",
	spec_k_drafts: "int32",
	vocabulary: "void *",
	n_vocabulary: "int32",
	prompt: "const char *",
	prefix: "const char *",
});
const ModelLoadParams = koffi.struct("transcribe_model_load_params", {
	struct_size: "uint64",
	backend: "int",
	device: "void *",
});
const SessionParams = koffi.struct("transcribe_session_params", {
	struct_size: "uint64",
	n_threads: "int",
	kv_type: "int",
	n_ctx: "int32",
});

const initBackends = lib.func("int transcribe_init_backends(const char *artifact_dir)");
const statusString = lib.func("const char *transcribe_status_string(int status)");
const modelLoad = lib.func("int transcribe_model_load_file(const char *path, const transcribe_model_load_params *params, _Out_ void **out_model)");
const modelLoadParamsInit = lib.func("void transcribe_model_load_params_init(_Inout_ transcribe_model_load_params *params)");
const sessionInit = lib.func("int transcribe_session_init(void *model, const transcribe_session_params *params, _Out_ void **out_session)");
const sessionParamsInit = lib.func("void transcribe_session_params_init(_Inout_ transcribe_session_params *params)");
const runParamsInit = lib.func("void transcribe_run_params_init(_Inout_ transcribe_run_params *params)");
const run = lib.func("int transcribe_run(void *session, const float *pcm, int n_samples, const transcribe_run_params *params)");
const fullText = lib.func("const char *transcribe_full_text(const void *session)");
const detectedLanguage = lib.func("const char *transcribe_detected_language(const void *session)");
const modelBackend = lib.func("const char *transcribe_model_backend(const void *model)");

const BACKENDS = { auto: 0, cpu: 1, metal: 2, vulkan: 3, cpu_accel: 4, cuda: 5, rocm: 6 };

function check(status, what) {
	if (status !== 0) throw new Error(`${what} failed (${status}): ${statusString(status) ?? "unknown error"}`);
}

// ---------------------------------------------------------------------------
// Model session
// ---------------------------------------------------------------------------
check(initBackends(config.runtimeDir), "transcribe_init_backends");

const loadParams = {};
modelLoadParamsInit(loadParams);
loadParams.backend = BACKENDS[config.backend] ?? 0;
const modelOut = [null];
check(modelLoad(config.modelPath, loadParams, modelOut), "transcribe_model_load_file");
const model = modelOut[0];

const sessParams = {};
sessionParamsInit(sessParams);
if (config.threads > 0) sessParams.n_threads = config.threads;
const sessionOut = [null];
check(sessionInit(model, sessParams, sessionOut), "transcribe_session_init");
const session = sessionOut[0];
log(`model loaded, backend: ${modelBackend(model)}`);

// One silent warmup run absorbs the one-time GPU shader compilation so the
// first real recording is fast.
{
	const silence = new Float32Array(16000);
	const warmParams = {};
	runParamsInit(warmParams);
	const t0 = performance.now();
	const st = run(session, silence, silence.length, warmParams);
	log(`warmup ${st === 0 ? "ok" : `failed (${st})`} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------
class InputError extends Error {}

function wavToPcm(buf) {
	if (buf.length < 46 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new InputError("Audio is not a RIFF/WAVE file");
	if (buf.readUInt32LE(24) !== 16000 || buf.readUInt16LE(22) !== 1 || buf.readUInt16LE(34) !== 16) throw new InputError("Audio must be 16 kHz mono PCM16");
	const n = Math.floor((buf.length - 44) / 2);
	if (n <= 0) throw new InputError("Audio contains no samples");
	const pcm = new Float32Array(n);
	for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(44 + i * 2) / 32768;
	return pcm;
}

function transcribe(buf, language) {
	const pcm = wavToPcm(buf);
	const params = {};
	runParamsInit(params);
	const locale = toModelLanguage(language);
	if (locale) params.language = locale;
	const t0 = performance.now();
	check(run(session, pcm, pcm.length, params), "transcribe_run");
	const inferenceSeconds = (performance.now() - t0) / 1000;
	const text = fullText(session) ?? "";
	return {
		text: text.trim(),
		audioSeconds: pcm.length / 16000,
		inferenceSeconds,
		detectedLanguage: detectedLanguage(session) || undefined,
	};
}

// ---------------------------------------------------------------------------
// HTTP server (loopback, bearer token)
// ---------------------------------------------------------------------------
const MAX_BODY = 16 * 1024 * 1024;

const server = createServer((req, res) => {
	const send = (status, value) => {
		const body = Buffer.from(JSON.stringify(value));
		res.writeHead(status, { "content-type": "application/json", "content-length": body.length });
		res.end(body);
	};
	if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "Unauthorized" });
	const url = new URL(req.url, "http://127.0.0.1");
	if (req.method !== "POST" || url.pathname !== "/transcribe") return send(404, { error: "Not found" });
	const chunks = [];
	let length = 0;
	req.on("data", (chunk) => {
		length += chunk.length;
		if (length > MAX_BODY) {
			res.writeHead(413, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "Audio exceeds the worker byte limit", code: "invalid-input" }));
			req.destroy();
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => {
		if (res.writableEnded) return;
		try {
			const result = transcribe(Buffer.concat(chunks), url.searchParams.get("language"));
			send(200, result);
		} catch (error) {
			if (error instanceof InputError) return send(400, { error: error.message, code: "invalid-input" });
			log("transcription failed:", error);
			send(500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	req.on("error", () => {});
});

server.listen(0, "127.0.0.1", () => {
	console.log(JSON.stringify({ port: server.address().port }));
});
