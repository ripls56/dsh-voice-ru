// Validate a DSH patch file parses as YAML and carries the expected rows.
// The loader's custom `!!js` tag is accepted as an opaque scalar; structure is
// what matters here. Requires js-yaml (`npm i -D js-yaml`); skipped without it.
// Usage: node test/yaml-validate.mjs [path-to-cordis.patch.yml]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let yaml;
try {
	yaml = (await import("js-yaml")).default;
} catch {
	console.log("js-yaml is not installed (npm i -D js-yaml) — skipping YAML validation");
	process.exit(0);
}

const path = process.argv[2] ?? fileURLToPath(new URL("../cordis.patch.yml", import.meta.url));
const text = readFileSync(path, "utf8");
const schema = yaml.DEFAULT_SCHEMA.extend([
	new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (value) => value }),
]);
const doc = yaml.load(text, { schema });
if (!Array.isArray(doc)) throw new Error("top level must be an array");
console.log(`${path}\nentries: ${doc.length}`);

const rows = doc.filter((entry) => Array.isArray(entry?.insert)).flatMap((entry) => entry.insert);
const inserts = rows.filter((row) => row?.id === "voice-ru");
console.log("voice-ru insert rows:", inserts.length, JSON.stringify(inserts[0]));
if (inserts.length !== 1) throw new Error("expected exactly one voice-ru insert row");
console.log("YAML OK");