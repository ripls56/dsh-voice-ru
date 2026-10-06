// Fresh-install simulation: an empty data root where the plugin must download
// and extract the pinned transcribe.cpp runtime itself, then transcribe audio.
// The 751 MB model is reused from the local cache (copied in) so the test does
// not re-download it; pass --download-model to exercise the model download too.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { mockContext, modelPath, settledPreparation, sample } from "./util.mjs";

// Hide any runtime kept in the checkout so the plugin really downloads one.
process.env.DSH_VOICE_RU_NO_BUNDLED_RUNTIME = "1";

const downloadModel = process.argv.includes("--download-model");
const dataRoot = await mkdtemp(join(tmpdir(), "dsh-voice-ru-fresh-"));
console.log(`fresh data root: ${dataRoot}`);

const { ctx, provider, dispose } = mockContext();
const config = { dataRoot };
if (!downloadModel) {
	if (!existsSync(modelPath())) throw new Error(`seed model not found at ${modelPath()}; set DSH_VOICE_RU_MODEL or pass --download-model`);
	// Point at the cached weights instead of copying 716 MiB around: this test is
	// about the runtime install, not the model download.
	config.modelPath = modelPath();
}
apply(ctx, config);

const registered = provider();
if (!registered) throw new Error("provider was not registered");
console.log("provider:", registered.info.id, "| setup estimate:", registered.info.setupEstimate.recommendedDiskBytes, "bytes");
console.log("phase before prepare:", registered.preparation.snapshot().phase);

registered.preparation.prepare();
const phase = await settledPreparation(registered);
console.log("phase after prepare:", phase);
if (phase !== "standby") {
	console.error("preparation snapshot:", JSON.stringify(registered.preparation.snapshot()));
	throw new Error(`expected standby after prepare, got ${phase}`);
}

const runtimeRoot = join(dataRoot, "runtime");
const entries = await readdir(runtimeRoot, { withFileTypes: true, recursive: true });
const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
console.log(`runtime files installed: ${files.length} (e.g. ${files.slice(0, 3).join(", ")})`);
if (files.length === 0) throw new Error("runtime archive did not install any files");

const wav = await readFile(sample("ru-sample.wav"));
const started = performance.now();
const result = await registered.transcribe({ audio: wav, language: "ru" }, new AbortController().signal);
console.log(`transcribe in ${((performance.now() - started) / 1000).toFixed(1)}s ->`, JSON.stringify(result));
if (!result.text.includes("проверка")) throw new Error("unexpected transcript");

await dispose();
await rm(dataRoot, { recursive: true, force: true });
console.log("OK (fresh install works end to end)");