// What the loaded model declares: architecture, variant, backend, and which
// optional run features it supports. Vocabulary/prompt support decides whether
// English terms inside Russian speech could ever be biased explicitly.
import { createRequire } from "node:module";
import { modelPath, runtimeInfo } from "./util.mjs";

const require = createRequire(import.meta.url);
const koffi = require("koffi");
const { runtimeDir, libraryPath } = await runtimeInfo();

const lib = koffi.load(libraryPath);
const ModelLoadParams = koffi.struct("transcribe_model_load_params", { struct_size: "uint64", backend: "int", device: "void *" });
const initBackends = lib.func("int transcribe_init_backends(const char *artifact_dir)");
const statusString = lib.func("const char *transcribe_status_string(int status)");
const loadParamsInit = lib.func("void transcribe_model_load_params_init(_Inout_ transcribe_model_load_params *params)");
const modelLoad = lib.func("int transcribe_model_load_file(const char *path, const transcribe_model_load_params *params, _Out_ void **out_model)");
const arch = lib.func("const char *transcribe_model_arch_string(const void *model)");
const variant = lib.func("const char *transcribe_model_variant_string(const void *model)");
const backend = lib.func("const char *transcribe_model_backend(const void *model)");
const supports = lib.func("bool transcribe_model_supports(const void *model, int feature)");
const metaStr = lib.func("const char *transcribe_model_meta_val_str(const void *model, const char *key)");

const FEATURES = [
	"INITIAL_PROMPT", "TEMPERATURE_FALLBACK", "LONG_FORM", "CANCELLATION", "PNC",
	"ITN", "DIARIZATION", "VOCABULARY", "CONTEXT_PROMPT", "INSTRUCT", "TRANSCRIPT_PREFIX",
];

let status = initBackends(runtimeDir);
if (status !== 0) throw new Error(`transcribe_init_backends: ${statusString(status)}`);
const loadParams = {};
loadParamsInit(loadParams);
const out = [null];
status = modelLoad(modelPath(), loadParams, out);
if (status !== 0) throw new Error(`transcribe_model_load_file: ${statusString(status)}`);
const model = out[0];

console.log("arch:    ", arch(model));
console.log("variant: ", variant(model));
console.log("backend: ", backend(model));
for (const [index, feature] of FEATURES.entries()) console.log(`feature ${String(index).padStart(2)} ${feature.padEnd(22)} ${supports(model, index)}`);
for (const key of ["stt.variant", "general.name"]) {
	const value = metaStr(model, key);
	if (value) console.log(`meta ${key}: ${value}`);
}