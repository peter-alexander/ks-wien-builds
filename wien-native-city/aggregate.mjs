#!/usr/bin/env node
/**
 * Aggregate and accept/reject an entire citywide native-building dry run.
 * Does not publish or change the productive building sources.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function aggregateCityReports(inputs) {
	if (!Array.isArray(inputs) || !inputs.length) throw new Error("No shard reports");
	const expectedShards = inputs[0].report.shards;
	const baselineRelease = inputs[0].report.sourceReleases?.lod1;
	if (!baselineRelease || inputs.length !== expectedShards) {
		throw new Error("Incomplete or unpinned city shard set");
	}
	const seenShards = new Set();
	const tileKeys = new Set();
	const result = {
		schemaVersion: 1,
		status: "success",
		geometry: "KSWN0001",
		sourceRelease: baselineRelease,
		snapshotAt: new Date().toISOString(),
		shards: expectedShards,
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
		largestTile: { key: "", bytes: 0 },
		roofDataState: "partial audited LOD2.1; LOD2.4 not yet available",
		storageState: "artifacts only; not published to gh-pages"
	};
	let reportedCityTiles = null;
	for (const { report, plan } of inputs) {
		if (seenShards.has(report.shard) || report.shards !== expectedShards
			|| report.status !== "success" || report.sourceReleases?.lod1 !== baselineRelease
			|| report.sourceGeneratedAt !== baselineRelease) {
			throw new Error("Invalid, duplicate or mixed-source city shard");
		}
		seenShards.add(report.shard);
		if (reportedCityTiles === null) reportedCityTiles = report.wholeCityTileCount;
		if (reportedCityTiles !== report.wholeCityTileCount
			|| plan.sourceGeneratedAt !== baselineRelease
			|| plan.shard !== report.shard
			|| plan.selectedTileCount !== report.tiles
			|| plan.expectedKeys?.length !== report.tiles) {
			throw new Error("Tile coverage/report inconsistency in shard " + report.shard);
		}
		for (const key of plan.expectedKeys) {
			if (tileKeys.has(key)) throw new Error("Duplicate Z15 tile in city shards: " + key);
			tileKeys.add(key);
		}
		for (const field of [
			"tiles","buildingParts","lod1Parts","lod21Parts","vertices",
			"triangles","rawBytes","gzipBytes","replacedFmzkParts"
		]) {
			if (!Number.isSafeInteger(report[field]) || report[field] < 0) {
				throw new Error("Invalid city shard metric " + field);
			}
			result[field] += report[field];
		}
		for (const kind of ["wall","pitchedRoof","flatRoof"]) {
			if (!Number.isSafeInteger(report.faceTriangles?.[kind])) {
				throw new Error("Invalid city triangle semantic " + kind);
			}
			result.faceTriangles[kind] += report.faceTriangles[kind];
		}
		if (report.largestTile.bytes > result.largestTile.bytes) {
			result.largestTile = report.largestTile;
		}
	}
	if (tileKeys.size !== reportedCityTiles || result.tiles !== reportedCityTiles
		|| result.buildingParts !== result.lod1Parts + result.lod21Parts
		|| result.triangles !== Object.values(result.faceTriangles).reduce((a,b)=>a+b,0)) {
		throw new Error("Citywide buildings/triangles/coverage do not reconcile");
	}
	result.completeCoverage = true;
	return result;
}

async function main(base) {
	const entries = await fs.readdir(base, { withFileTypes: true });
	const inputs = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("wien-native-city-report-")) continue;
		const dir = path.join(base, entry.name);
		const report = JSON.parse(await fs.readFile(path.join(dir,"report.json"),"utf8"));
		const plan = JSON.parse(await fs.readFile(path.join(dir,"plan.json"),"utf8"));
		inputs.push({report,plan});
	}
	const result = aggregateCityReports(inputs);
	await fs.writeFile(path.join(base,"city-report.json"), JSON.stringify(result,null,"\t")+"\n");
	console.log(JSON.stringify(result,null,2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(path.resolve(process.argv[2] || "wien-native-city/reports")).catch(e=>{
		console.error(e?.stack || e);
		process.exitCode=1;
	});
}
