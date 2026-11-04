#!/usr/bin/env node
/**
 * Citywide build-through audit, no publication.
 *
 * The current authoritative FMZK data is mandatory; where the independently
 * verified historical 2.1 source exists, it replaces the exact current parts.
 *
 * LOD2.4 is intentionally not silently substituted: full official access is
 * not an OGD download as of 2026-11-04. When an authorized source is acquired,
 * it will be normalized and prioritized over 2.1 in a separate audited stage.
 *
 * Output tiles are KSWN0001 .bin.gz (GPU-ready and DEM altitude-free).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPilot, BASE } from "../wien-native-pilot/build.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const SHARDS = 8;
const MIN_EXPECTED_TILES = 600;

export function partitionKeys(keys, shard, shards) {
	if (!Array.isArray(keys) || keys.length === 0
		|| !Number.isSafeInteger(shard) || !Number.isSafeInteger(shards)
		|| shards < 1 || shards > 32 || shard < 0 || shard >= shards) {
		throw new RangeError("Invalid city build shard plan");
	}
	const seen = new Set();
	for (const key of keys) {
		const match = /^15\/(\d+)\/(\d+)$/.exec(key);
		if (!match || seen.has(key) || Number(match[1]) >= 32768
			|| Number(match[2]) >= 32768) {
			throw new Error("Invalid or repeated indexed Z15 tile " + key);
		}
		seen.add(key);
	}
	return [...keys].sort((a, b) => {
		const [az, ax, ay] = a.split("/").map(Number);
		const [bz, bx, by] = b.split("/").map(Number);
		return az - bz || ax - bx || ay - by;
	}).filter((key, index) => index % shards === shard);
}

export function summarizeManifest(manifest) {
	const aggregate = {
		tiles: 0,
		buildingParts: 0,
		lod1Parts: 0,
		lod21Parts: 0,
		vertices: 0,
		triangles: 0,
		rawBytes: 0,
		gzipBytes: 0,
		replacedFmzkParts: 0,
		faceTriangles: { wall: 0, pitchedRoof: 0, flatRoof: 0 },
		largestTile: { key: "", bytes: 0 }
	};
	for (const [key, tile] of Object.entries(manifest.tiles || {})) {
		aggregate.tiles++;
		for (const field of [
			"buildingParts", "lod1Parts", "lod21Parts",
			"vertices", "triangles", "rawBytes", "gzipBytes", "replacedFmzkParts"
		]) {
			if (!Number.isSafeInteger(tile[field]) || tile[field] < 0) {
				throw new Error("Invalid " + field + " for " + key);
			}
			aggregate[field] += tile[field];
		}
		for (const kind of ["wall", "pitchedRoof", "flatRoof"]) {
			const count = tile.faceTriangles?.[kind];
			if (!Number.isSafeInteger(count) || count < 0) {
				throw new Error("Invalid mesh semantic triangle count for " + key);
			}
			aggregate.faceTriangles[kind] += count;
		}
		if (tile.buildingParts !== tile.lod1Parts + tile.lod21Parts) {
			throw new Error("Miscounted geometry provenance for " + key);
		}
		if (tile.faceTriangles.wall + tile.faceTriangles.pitchedRoof
			+ tile.faceTriangles.flatRoof !== tile.triangles) {
			throw new Error("Triangle semantic count mismatch for " + key);
		}
		if (tile.gzipBytes > aggregate.largestTile.bytes) {
			aggregate.largestTile = { key, bytes: tile.gzipBytes };
		}
	}
	return aggregate;
}

async function getJson(url) {
	let lastError;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 60000);
			try {
				const response = await fetch(url, { signal: ctrl.signal });
				if (!response.ok) throw new Error("HTTP " + response.status);
				return await response.json();
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			lastError = error;
			if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
		}
	}
	throw new Error("Unable to read official FMZK release index: " + lastError);
}

export function parseBuildOptions(args = process.argv.slice(2)) {
	const options = {
		shard: -1,
		shards: SHARDS,
		outputDir: path.join(ROOT, "build"),
		dryRun: false
	};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--shard") options.shard = Number(args[++i]);
		else if (args[i] === "--shards") options.shards = Number(args[++i]);
		else if (args[i] === "--output") options.outputDir = path.resolve(args[++i]);
		else if (args[i] === "--dry-run") options.dryRun = true;
		else throw new Error("Unexpected argument: " + args[i]);
	}
	if (!Number.isSafeInteger(options.shard) || options.shard < 0
		|| !Number.isSafeInteger(options.shards) || options.shards > 32
		|| options.shards < 1 || options.shard >= options.shards) {
		throw new Error("Use --shard N --shards M with 0 <= N < M <= 32");
	}
	return options;
}

export async function buildCityShard({
	shard, shards = SHARDS, outputDir = path.join(ROOT, "build"),
	dryRun = false, release = null, runner = buildPilot
} = {}) {
	const dataset = release || await getJson(BASE + "/LOD1/release.json");
	if (dataset?.vectorTiles?.layer !== "wien_buildings"
		|| dataset?.vectorTiles?.compression !== "none"
		|| dataset?.vectorTiles?.maxzoom !== 15
		|| !Array.isArray(dataset?.vectorTiles?.presentTilesZ15)
		|| dataset.vectorTiles.presentTilesZ15.length < MIN_EXPECTED_TILES) {
		throw new Error("Incomplete or changed official FMZK tile release; no build");
	}
	const keys = dataset.vectorTiles.presentTilesZ15;
	const selected = partitionKeys(keys, shard, shards);
	const shardDir = path.join(outputDir, "shard-" + shard);
	await fs.mkdir(shardDir, { recursive: true });
	const plan = {
		schemaVersion: 1,
		status: "planned",
		dataset: "Wien native building city build-through audit",
		priority: ["FMZK current", "LOD2.4 only if authorized", "LOD2.1 audited"],
		sourcePolicy: {
			authoritativeBuildings: "Stadt Wien FMZKBKMOGD via KS LOD1 official OGD build",
			lod24: "not included: no publicly downloadable complete licensed source confirmed",
			lod21: "existing verified historical CityGML subset only",
			maptoolkit: "forbidden"
		},
		terrainAltitudeStored: false,
		shard, shards,
		selectedTileCount: selected.length,
		wholeCityTileCount: keys.length,
		sourceGeneratedAt: dataset.generatedAt,
		expectedKeys: selected
	};
	await fs.writeFile(path.join(shardDir, "plan.json"),
		JSON.stringify(plan, null, "\t") + "\n");
	if (dryRun) return { ...plan, status: "dry-run" };
	try {
		const manifest = await runner({
			outputDir: path.join(shardDir, "output"),
			tileKeys: selected
		});
		if (manifest?.sourceReleases?.lod1 !== dataset.generatedAt) {
			throw new Error("FMZK source advanced during citywide build; rerun a pinned snapshot");
		}
		const seen = Object.keys(manifest.tiles || {});
		if (seen.length !== selected.length
			|| selected.some(key => !Object.hasOwn(manifest.tiles, key))) {
			throw new Error("Output coverage does not match FMZK release tile index");
		}
		const stats = summarizeManifest(manifest);
		if (!stats.lod1Parts || !stats.vertices || !stats.triangles) {
			throw new Error("Suspiciously empty city shard");
		}
		for (const key of selected) {
			const tile = manifest.tiles[key];
			const filename = path.join(shardDir, "output", "tiles", key + ".bin.gz");
			const stat = await fs.stat(filename);
			if (stat.size !== tile.gzipBytes) throw new Error("Wrong output tile size: " + key);
		}
		const report = {
			...plan,
			expectedKeys: undefined,
			status: "success",
			...stats,
			roofMode: manifest.roofPolicy,
			sourceReleases: manifest.sourceReleases
		};
		await fs.writeFile(path.join(shardDir, "report.json"),
			JSON.stringify(report, null, "\t") + "\n");
		console.log("Shard " + shard + " verified:", JSON.stringify(stats));
		return report;
	} catch (error) {
		const report = {
			...plan, expectedKeys: undefined,
			status: "failed",
			error: String(error?.stack || error)
		};
		await fs.writeFile(path.join(shardDir, "report.json"),
			JSON.stringify(report, null, "\t") + "\n");
		throw error;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	buildCityShard(parseBuildOptions()).catch(error => {
		console.error(error?.stack || error);
		process.exitCode = 1;
	});
}
