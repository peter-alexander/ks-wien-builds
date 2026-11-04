import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	partitionKeys, summarizeManifest, parseBuildOptions, buildCityShard
} from "./build.mjs";

const cityKeys = Array.from({length: 640}, (_, i) =>
	"15/" + (17800 + i % 32) + "/" + (11340 + Math.floor(i / 32)));

test("all 640 Z15 keys partition exactly once, deterministically, across eight shards", () => {
	const groups = Array.from({length: 8}, (_, shard) =>
		partitionKeys(cityKeys, shard, 8));
	assert.ok(groups.every(a => a.length === 80));
	assert.deepEqual([...new Set(groups.flat())].sort(), [...cityKeys].sort());
	assert.deepEqual(groups[0], partitionKeys([...cityKeys].reverse(), 0, 8));
	assert.throws(() => partitionKeys([...cityKeys, cityKeys[0]], 0, 8), /repeated/);
	assert.throws(() => partitionKeys(["16/1/1"], 0, 8), /Invalid/);
	assert.throws(() => partitionKeys(cityKeys, 8, 8), RangeError);
});

test("citywide audit refuses partial, unindexed or changed FMZK sources", async () => {
	const source = {
		generatedAt: "stable-version",
		vectorTiles: {
			layer: "wien_buildings", compression: "none",
			maxzoom: 15, presentTilesZ15: cityKeys.slice(0, 99)
		}
	};
	await assert.rejects(() => buildCityShard({
		shard: 0, shards: 8, release: source, dryRun: true
	}), /Incomplete/);
	source.vectorTiles.presentTilesZ15 = cityKeys;
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ks-wien-city-plan-"));
	try {
		const report = await buildCityShard({
			shard: 0, shards: 8, release: source, outputDir: root, dryRun: true
		});
		assert.equal(report.selectedTileCount, 80);
		assert.equal(report.wholeCityTileCount, 640);
		assert.equal(report.sourcePolicy.maptoolkit, "forbidden");
		assert.match(report.sourcePolicy.lod24, /not included/);
		assert.equal(report.terrainAltitudeStored, false);
		const plan = JSON.parse(await fs.readFile(path.join(root, "shard-0", "plan.json")));
		assert.equal(plan.expectedKeys.length, 80);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("manifest audit checks per-tile provenance and all roof triangles", () => {
	const sample = {
		tiles: {
			"15/17873/11364": {
				buildingParts: 3, lod1Parts: 2, lod21Parts: 1,
				vertices: 21, triangles: 7,
				rawBytes: 1000, gzipBytes: 310, replacedFmzkParts: 1,
				faceTriangles: { wall: 3, pitchedRoof: 2, flatRoof: 2 }
			}
		}
	};
	assert.equal(summarizeManifest(sample).lod21Parts, 1);
	assert.equal(summarizeManifest(sample).faceTriangles.pitchedRoof, 2);
	assert.equal(summarizeManifest(sample).largestTile.bytes, 310);
	sample.tiles["15/17873/11364"].faceTriangles.pitchedRoof++;
	assert.throws(() => summarizeManifest(sample), /Triangle semantic/);
});

test("only valid and bounded citywide shard arguments are allowed", () => {
	assert.deepEqual(
		Object.keys(parseBuildOptions(["--shard", "1", "--shards", "8"])).sort(),
		["dryRun","outputDir","shard","shards"]
	);
	assert.throws(() => parseBuildOptions(["--shard", "-1"]), /Use --shard/);
	assert.throws(() => parseBuildOptions(["--shard", "12", "--shards", "8"]), /Use --shard/);
	assert.throws(() => parseBuildOptions(["--shard", "0", "--shards", "33"]), /Use --shard/);
	assert.throws(() => parseBuildOptions(["--bogus", "x"]), /Unexpected/);
});
