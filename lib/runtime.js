// transcribe.cpp native runtime: pinned release assets, on-demand install,
// tar.gz extraction, and library discovery.
//
// The runtime is NOT vendored in this repository: it is downloaded from the
// upstream release on first prepare() and verified against a pinned sha256.
// Model weights are downloaded separately (see lib/index.js).
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { downloadVerified, fileMatches } from "./download.js";

/** Upstream release that the pinned assets below belong to. */
export const RUNTIME_RELEASE = {
	name: "transcribe.cpp",
	version: "0.3.1",
	page: "https://github.com/handy-computer/transcribe.cpp/releases/tag/v0.3.1",
	baseUrl: "https://github.com/handy-computer/transcribe.cpp/releases/download/v0.3.1",
};

/**
 * One lane per supported platform/architecture. `lane` is the archive's name
 * stem, `library` the shared library koffi loads, `bytes`/`sha256` pin the
 * exact artifact. CUDA lanes exist upstream and are intentionally not listed:
 * the CPU/Vulkan/Metal lanes work on any machine.
 */
export const RUNTIMES = {
	"win32-x64": { lane: "windows-x86_64-cpu-vulkan", library: "transcribe.dll", bytes: 17449854, sha256: "d06229a1e854f0cbbf90cb547bb6c7dd14d9bab16ca53b808493ad8eaa55ffa6" },
	"linux-x64": { lane: "linux-x86_64-cpu-vulkan", library: "libtranscribe.so", bytes: 21633824, sha256: "7656cd88b563d79af4e483400aebd149c50aad2c3b20ced1f5a06ce1e50f435a" },
	"linux-arm64": { lane: "linux-aarch64-cpu-vulkan", library: "libtranscribe.so", bytes: 17788220, sha256: "7039a916b990b7e9540ee25fb7fd6a05947b9691f74fc3aafd3fe5dc2a4899d7" },
	"darwin-arm64": { lane: "macos-arm64-metal", library: "libtranscribe.dylib", bytes: 1811963, sha256: "904adfa090946c1f4902e7117c03cf245e45c041a370c2ea5547eccf8d00126f" },
	"darwin-x64": { lane: "macos-x86_64-cpu", library: "libtranscribe.dylib", bytes: 1528627, sha256: "5d3ebed3616224ff477460ced6c498936752251fc344c4c79c7125af07a87a65" },
};

/** Runtime archive descriptor for one platform/architecture, or undefined when unsupported. */
export function runtimePlan(platform = process.platform, arch = process.arch) {
	const entry = RUNTIMES[`${platform}-${arch}`];
	if (!entry) return undefined;
	// Upstream asset names carry the release version; the folder inside the
	// archive does not, which is why the library is discovered by search.
	const archive = `transcribe-native-${RUNTIME_RELEASE.version}-${entry.lane}.tar.gz`;
	return {
		...entry,
		archive,
		url: `${RUNTIME_RELEASE.baseUrl}/${archive}`,
	};
}

/**
 * Plugin-local runtime directory, used when a developer keeps the archive
 * extracted in the checkout. `DSH_VOICE_RU_NO_BUNDLED_RUNTIME=1` hides it, which
 * is how the fresh-install test exercises the download path.
 */
export function bundledRuntimeDir() {
	if (process.env.DSH_VOICE_RU_NO_BUNDLED_RUNTIME) return undefined;
	return fileURLToPath(new URL("../runtime/", import.meta.url));
}

/**
 * Find `library` in `dir` or in one of its immediate subdirectories (the
 * upstream archives nest everything under a single folder).
 * @returns the absolute library path, or undefined.
 */
export async function findLibrary(dir, library) {
	if (!dir) return undefined;
	if (await fileMatches(join(dir, library))) return resolve(join(dir, library));
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidate = join(dir, entry.name, library);
		if (await fileMatches(candidate)) return resolve(candidate);
	}
	return undefined;
}

/** Locate an already-present runtime without downloading anything. */
export async function locateRuntime({ config, paths, plan }) {
	if (config.runtimeDir !== undefined) {
		const library = await findLibrary(config.runtimeDir, plan.library);
		if (!library) throw new Error(`dsh-voice-ru: runtimeDir does not contain ${plan.library}: ${config.runtimeDir}`);
		return { runtimeDir: dirname(library), libraryPath: library, source: "configured" };
	}
	const bundled = await findLibrary(paths.bundledRuntimeDir, plan.library);
	if (bundled) return { runtimeDir: dirname(bundled), libraryPath: bundled, source: "bundled" };
	const installed = await findLibrary(paths.runtimeInstallRoot, plan.library);
	if (installed) return { runtimeDir: dirname(installed), libraryPath: installed, source: "installed" };
	return undefined;
}

/**
 * Ensure the runtime is usable: reuse a configured/bundled/installed copy, or
 * download the pinned archive, verify it, extract it, and locate the library.
 * @returns `{ runtimeDir, libraryPath, source }`.
 */
export async function ensureRuntime({ config, paths, plan, signal, report = () => {} }) {
	signal.throwIfAborted();
	const existing = await locateRuntime({ config, paths, plan });
	if (existing) return existing;

	await mkdir(paths.runtimeInstallRoot, { recursive: true });
	const archive = join(paths.runtimeInstallRoot, plan.archive);
	if (!(await fileMatches(archive, plan.bytes))) {
		await downloadVerified({
			url: plan.url,
			destination: archive,
			bytes: plan.bytes,
			sha256: plan.sha256,
			resource: plan.archive,
			step: "check",
			progressIntervalMs: config.progressIntervalMs,
		}, signal, report);
	}
	report({ phase: "checking", step: "load", startedAt: Date.now() });
	extractTarGz(await readFile(archive), paths.runtimeInstallRoot);

	const library = await findLibrary(paths.runtimeInstallRoot, plan.library);
	if (!library) throw new Error(`dsh-voice-ru: ${plan.library} missing after extracting ${plan.archive}`);
	return { runtimeDir: dirname(library), libraryPath: library, source: "installed" };
}

function readAscii(buffer, offset, length) {
	let end = offset;
	const limit = offset + length;
	while (end < limit && buffer[end] !== 0) end++;
	return buffer.toString("utf8", offset, end);
}

/**
 * Extract a gzipped tar archive into `destination`. Regular files and
 * directories are written; metadata entries are skipped. Entries that would
 * escape `destination` are refused.
 * @param archive - complete .tar.gz bytes.
 * @param destination - existing target directory.
 */
export function extractTarGz(archive, destination) {
	const tar = gunzipSync(archive);
	const root = resolve(destination);
	let offset = 0;
	let pendingName;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const nameField = readAscii(header, 0, 100);
		const size = Number.parseInt(readAscii(header, 124, 12).trim() || "0", 8);
		const mode = Number.parseInt(readAscii(header, 100, 8).trim() || "644", 8);
		const type = String.fromCharCode(header[156]);
		const prefix = readAscii(header, 345, 155);
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		offset = dataStart + Math.ceil(size / 512) * 512;
		if (!Number.isFinite(size) || offset > tar.length + 512) throw new Error("dsh-voice-ru: malformed tar archive");

		if (type === "L") {
			pendingName = tar.toString("utf8", dataStart, dataEnd).replace(/\0+$/, "");
			continue;
		}
		if (type === "x" || type === "g") continue;
		const name = pendingName ?? (prefix ? `${prefix}/${nameField}` : nameField);
		pendingName = undefined;
		if (name === "" || name.endsWith("/") || type === "5") continue;

		const target = resolve(root, name);
		if (target !== root && !target.startsWith(root + sep)) throw new Error(`dsh-voice-ru: refusing archive entry outside the target directory: ${name}`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, tar.subarray(dataStart, dataEnd), { mode: mode & 0o777 });
	}
}