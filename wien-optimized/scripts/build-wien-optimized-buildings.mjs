#!/usr/bin/env node
/**
 * Precompute the existing, audited Wiener Z15 building composition.
 *
 * Offline builder; no browser, canvas or WebGL required. The exact
 * production prepareWienBuildingTile() combines Maptoolkit LOD2,
 * historical LOD2.1 and the OGD LOD1 fallback and resolves duplicates.
 * Output is gzip-compressed, browser-decodable geometry, NOT a new
 * independent roof matching implementation.
 *
 * Usage: node scripts/build-wien-optimized-buildings.mjs --tiles 15/17874/11362
 *        node scripts/build-wien-optimized-buildings.mjs --tile-list tiles.txt
 */
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { createWienBuildingDataSource } from "../src/app/buildings/wien-building-data-source.js";
import { prepareWienBuildingTile } from "../src/app/buildings/wien-building-tile-preparation.js";
import { packWienBuildingResource } from "../src/app/buildings/wien-building-worker-codec.js";

export function parseTileKey(key) {
	const match = /^(15)\/(\d+)\/(\d+)$/.exec(String(key));
	if (!match) throw new Error(`Invalid Z15 tile: ${key}`);
	const [z, x, y] = match.slice(1).map(Number);
	if (![z, x, y].every(Number.isSafeInteger) || x >= 2 ** z || y >= 2 ** z) {
		throw new Error(`Out-of-range Z15 tile: ${key}`);
	}
	return { z, x, y };
}

// Payload is a compact, versioned JSON envelope of the exact typed-array
// attributes. Gzip preserves small integer vertex normals and RGB bytes;
// production decoder must reconstruct typed arrays before passing to Three.
const ARRAY_TYPES = new Map([
	["Float32Array", Float32Array],
	["Float64Array", Float64Array],
	["Uint8Array", Uint8Array],
	["Uint16Array", Uint16Array],
	["Uint32Array", Uint32Array],
	["Int8Array", Int8Array],
	["Int16Array", Int16Array],
	["Int32Array", Int32Array]
]);

export function encodeOptimizedTile(payload) {
	const arrays = [];
	const replace = (value) => {
		if (ArrayBuffer.isView(value)) {
			const type = value.constructor.name;
			if (!ARRAY_TYPES.has(type)) throw new TypeError(`Unsupported typed array: ${type}`);
			const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			const offset = arrays.reduce((sum, item) => sum + item.byteLength, 0);
			arrays.push(bytes);
			return { __ksArray: type, byteOffset: offset, byteLength: bytes.byteLength };
		}
		if (Array.isArray(value)) return value.map(replace);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
		}
		return value;
	};
	const header = Buffer.from(JSON.stringify({ version: 1, resource: replace(payload) }), "utf8");
	const prefix = Buffer.alloc(8);
	prefix.write("KSWB", 0);
	prefix.writeUInt32LE(header.length, 4);
	return gzipSync(Buffer.concat([prefix, header, ...arrays.map((a) =>
		Buffer.from(a.buffer, a.byteOffset, a.byteLength))]), { level: 9 });
}

export function decodeOptimizedTile(compressed, gunzip) {
	const data = gunzip(compressed);
	if (data.toString("ascii", 0, 4) !== "KSWB") throw new Error("Invalid optimized tile magic");
	const length = data.readUInt32LE(4);
	const header = JSON.parse(data.subarray(8, 8 + length).toString("utf8"));
	if (header.version !== 1) throw new Error("Unsupported optimized building format");
	const start = 8 + length;
	const revive = (value) => {
		if (value && value.__ksArray) {
			const Type = ARRAY_TYPES.get(value.__ksArray);
			if (!Type || value.byteLength % Type.BYTES_PER_ELEMENT) throw new Error("Invalid array descriptor");
			const bytes = data.subarray(start + value.byteOffset, start + value.byteOffset + value.byteLength);
			if (bytes.byteLength !== value.byteLength) throw new Error("Truncated geometry");
			const copy = Uint8Array.from(bytes);
			return new Type(copy.buffer);
		}
		if (Array.isArray(value)) return value.map(revive);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
		}
		return value;
	};
	return revive(header.resource);
}

export async function buildOptimizedTiles(keys, output, {
	source = createWienBuildingDataSource(),
	prepare = prepareWienBuildingTile
} = {}) {
	const manifest = { format: "KSWB", version: 1, sourceZoom: 15,
		tiles: {}, generatedAt: new Date().toISOString() };
	try {
		for (const key of [...new Set(keys)].sort()) {
			const tile = parseTileKey(key);
			const resource = await prepare({ tile, dataSource: source });
			const { payload } = packWienBuildingResource(resource);
			const bytes = encodeOptimizedTile(payload);
			const filename = path.join(output, "tiles", key + ".kswb.gz");
			await fs.mkdir(path.dirname(filename), { recursive: true });
			await fs.writeFile(filename, bytes);
			manifest.tiles[key] = { bytes: bytes.byteLength,
				degraded: Boolean(resource?.failures?.length),
				failures: resource?.failures || [] };
			resource?.dispose?.();
			console.log(`Built ${key}: ${bytes.byteLength} compressed bytes`);
		}
		await fs.mkdir(output, { recursive: true });
		await fs.writeFile(path.join(output, "manifest.json"),
			JSON.stringify(manifest, null, "\t") + "\n");
		return manifest;
	} finally {
		source?.destroy?.();
	}
}

async function main() {
	const args = process.argv.slice(2);
	const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
	const direct = option("--tiles");
	const listFile = option("--tile-list");
	if (Boolean(direct) === Boolean(listFile)) {
		throw new Error("Supply exactly one of --tiles or --tile-list");
	}
	const keys = direct ? direct.split(",") :
		(await fs.readFile(listFile, "utf8")).split(/\s+/).filter(Boolean);
	await buildOptimizedTiles(keys, path.resolve(option("--output") || "dist/wien-optimized-buildings"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(error); process.exitCode = 1; });
}
