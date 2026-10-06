// Host-side smoke test: mocks the cordis context, applies the plugin, then
// drives real transcriptions through the provider exactly like the DSH host.
// Uses the runtime that is already present (bundled checkout copy or installed).
import { readFileSync } from "node:fs";
import { apply } from "../lib/index.js";
import { mockContext, sample, settledPreparation } from "./util.mjs";

const { ctx, provider, dispose } = mockContext();
apply(ctx, {});

const registered = provider();
if (!registered) throw new Error("provider was not registered");
console.log("registered provider:", registered.info.id, "|", registered.info.name, "| languages:", registered.info.languages.length);
console.log("phase:", await settledPreparation(registered, 60000));
if (registered.preparation.snapshot().phase !== "standby") throw new Error("expected standby (runtime and model must be present)");

const wav = readFileSync(sample("ru-sample.wav"));
const signal = new AbortController().signal;

let started = performance.now();
let result = await registered.transcribe({ audio: wav, language: "ru" }, signal);
console.log(`transcribe(ru) in ${((performance.now() - started) / 1000).toFixed(1)}s ->`, JSON.stringify(result));
if (!result.text.includes("проверка")) throw new Error("unexpected transcript");

started = performance.now();
result = await registered.transcribe({ audio: wav, language: "auto" }, signal);
console.log(`transcribe(auto) in ${((performance.now() - started) / 1000).toFixed(1)}s ->`, JSON.stringify(result));

try {
	await registered.transcribe({ audio: Buffer.from("not a wav file at all, sorry".padEnd(64, ".")), language: "ru" }, signal);
	throw new Error("expected rejection");
} catch (error) {
	console.log("invalid input rejected:", error.message);
}
result = await registered.transcribe({ audio: wav, language: "ru" }, signal);
console.log("worker still alive after bad input:", JSON.stringify(result.text));

console.log("phase after runs:", registered.preparation.snapshot().phase);
await dispose();
console.log("OK");