// Raw FFI proof: koffi -> transcribe library -> GGUF model -> transcript.
// Bypasses the worker and the plugin, so a failure here is the native stack's.
// Usage: node test/ffi-smoke.mjs [wav] [language]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { modelPath, runtimeInfo, sample } from "./util.mjs";

const require = createRequire(import.meta.url);
const koffi = require("koffi");

const { runtimeDir, libraryPath } = await runtimeInfo();
const wavPath = process.argv[2] ?? sample("ru-sample.wav");
const language = process.argv[3] ?? "ru-RU";

const lib = koffi.load(libraryPath);
const RunParams = koffi.struct("transcribe_run_params", {
	struct_size: "uint64", task: "int", timestamps: "int", pnc: "int", itn: "int", diarize: "int",
	language: "const char *", target_language: "const char *", keep_special_tags: "bool", family: "void *",
	spec_k_drafts: "int32", vocabulary: "void *", n_vocabulary: "int32", prompt: "const char *", prefix: "const char *",
});
const ModelLoadParams = koffi.struct("transcribe_model_load_params", { struct_size: "uint64", backend: "int", device: "void *" });
const SessionParams = koffi.struct("transcribe_session_params", { struct_size: "uint64", n_threads: "int", kv_type: "int", n_ctx: "int32" });

const initBackends = lib.func("int transcribe_init_backends(const char *artifact_dir)");
const statusString = lib.func("const char *transcribe_status_string(int status)");
const version = lib.func("const char *transcribe_version(void)");
const loadParamsInit = lib.func("void transcribe_model_load_params_init(_Inout_ transcribe_model_load_params *p)");
const modelLoad = lib.func("int transcribe_model_load_file(const char *path, const transcribe_model_load_params *p, _Out_ void **out)");
const sessionParamsInit = lib.func("void transcribe_session_params_init(_Inout_ transcribe_session_params *p)");
const sessionInit = lib.func("int transcribe_session_init(void *model, const transcribe_session_params *p, _Out_ void **out)");
const runParamsInit = lib.func("void transcribe_run_params_init(_Inout_ transcribe_run_params *p)");
const run = lib.func("int transcribe_run(void *session, const float *pcm, int n_samples, const transcribe_run_params *p)");
const fullText = lib.func("const char *transcribe_full_text(const void *session)");
const sessionFree = lib.func("void transcribe_session_free(void *session)");

const fail = (what, status) => { throw new Error(`${what} failed (${status}): ${statusString(status)}`); };
console.log("library:", libraryPath);
console.log("version:", version());

let status = initBackends(runtimeDir);
if (status !== 0) fail("transcribe_init_backends", status);

const loadParams = {};
loadParamsInit(loadParams);
const modelOut = [null];
status = modelLoad(modelPath(), loadParams, modelOut);
if (status !== 0) fail("transcribe_model_load_file", status);

const sessionParams = {};
sessionParamsInit(sessionParams);
const sessionOut = [null];
status = sessionInit(modelOut[0], sessionParams, sessionOut);
if (status !== 0) fail("transcribe_session_init", status);
const session = sessionOut[0];

const wav = readFileSync(wavPath);
if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16) {
	throw new Error("need a canonical 16 kHz mono PCM16 WAV");
}
const samples = Math.floor((wav.length - 44) / 2);
const pcm = new Float32Array(samples);
for (let i = 0; i < samples; i++) pcm[i] = wav.readInt16LE(44 + i * 2) / 32768;

const params = {};
runParamsInit(params);
if (language !== "auto") params.language = language;
const started = performance.now();
status = run(session, pcm, samples, params);
if (status !== 0) fail("transcribe_run", status);
const seconds = (performance.now() - started) / 1000;
console.log(`audio ${(samples / 16000).toFixed(2)}s, inference ${seconds.toFixed(2)}s (RTF x${(samples / 16000 / seconds).toFixed(1)})`);
console.log("text:", JSON.stringify(fullText(session)));
sessionFree(session);