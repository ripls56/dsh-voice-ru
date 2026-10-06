// Atomic verified downloads shared by the model and runtime installers.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** True when the path is a regular file, optionally of exactly `bytes` length. */
export async function fileMatches(path, bytes) {
	try {
		const info = await stat(path);
		return info.isFile() && (bytes === undefined || info.size === bytes);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return false;
	}
}

/** Size + sha256 verification of an existing file. */
export async function verifyFile(path, { bytes, sha256 }, signal) {
	if (!(await fileMatches(path, bytes))) return false;
	if (!sha256) return true;
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
	return digest.digest("hex") === sha256;
}

/**
 * Download one asset into a unique partial file, verify its size and sha256,
 * then publish it atomically. A mismatching download never reaches `destination`.
 * @param asset - `{ url, destination, bytes, sha256, resource, step, progressIntervalMs }`.
 * @param signal - caller cancellation.
 * @param report - progress publisher receiving the voice-input preparation shape.
 * @returns the published destination path.
 */
export async function downloadVerified(asset, signal, report = () => {}) {
	const partial = `${asset.destination}.${randomUUID()}.part`;
	try {
		await mkdir(dirname(asset.destination), { recursive: true });
		const response = await fetch(asset.url, { signal, redirect: "follow" });
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new Error(`Download failed for ${asset.resource}: HTTP ${response.status} from ${new URL(asset.url).origin}`);
		}
		const digest = createHash("sha256");
		let completedBytes = 0;
		let lastReport = 0;
		const interval = asset.progressIntervalMs ?? 200;
		const totalBytes = Number(response.headers.get("content-length")) || asset.bytes;
		const hashing = new Transform({
			transform(chunk, _encoding, callback) {
				completedBytes += chunk.length;
				digest.update(chunk);
				const now = performance.now();
				if (now - lastReport >= interval) {
					lastReport = now;
					report({ phase: "downloading", step: asset.step ?? "model", resource: asset.resource, completedBytes, totalBytes });
				}
				callback(null, chunk);
			},
		});
		await pipeline(response.body, hashing, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
		signal.throwIfAborted();
		if (asset.bytes !== undefined && completedBytes !== asset.bytes) {
			throw new Error(`Download truncated for ${asset.resource}: ${completedBytes} of ${asset.bytes} bytes`);
		}
		if (asset.sha256 !== undefined && digest.digest("hex") !== asset.sha256) {
			throw new Error(`Checksum mismatch for ${asset.resource}: the download does not match the pinned sha256`);
		}
		await rename(partial, asset.destination);
		return asset.destination;
	} finally {
		await rm(partial, { force: true });
	}
}