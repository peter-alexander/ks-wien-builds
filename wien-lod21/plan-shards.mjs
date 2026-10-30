#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectedSheets } from "./download-sheets.mjs";

export function createShardPlan(sheetIds, size = 12) {
	if (!Number.isSafeInteger(size) || size < 1 || size > 20) {
		throw new Error("Shard size must be an integer between 1 and 20");
	}
	if (!Array.isArray(sheetIds) || sheetIds.length === 0) {
		throw new Error("Cannot create an empty shard plan");
	}
	const include = [];
	for (let offset = 0; offset < sheetIds.length; offset += size) {
		include.push({ index: include.length, offset, limit: Math.min(size, sheetIds.length - offset) });
	}
	return { include };
}

async function main() {
	const manifestPath = process.argv[2] || "wien-lod21/targets.production.json";
	const shardSize = Number(process.argv[3] || 12);
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const sheets = selectedSheets(manifest);
	const plan = createShardPlan(sheets, shardSize);
	const matrix = JSON.stringify(plan);
	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(process.env.GITHUB_OUTPUT, "matrix=" + matrix + "\n");
	}
	console.log("LOD2.1: " + sheets.length + " unique sheets in " + plan.include.length + " shards of at most " + shardSize);
	console.log(matrix);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((error) => { console.error(error); process.exitCode = 1; });
}
