#!/usr/bin/env node
/**
 * Partition the official CityGML sheet download manifest into disjoint
 * GitHub Actions jobs. Deterministic and independent of runner ordering.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectedSheets } from "./download-sheets.mjs";

export function splitSheets(sheets, shard, shards) {
	if (!Array.isArray(sheets) || !sheets.length
		|| !Number.isSafeInteger(shard) || !Number.isSafeInteger(shards)
		|| shards < 1 || shards > 64 || shard < 0 || shard >= shards) {
		throw new RangeError("Invalid parallel CityGML download shard");
	}
	const ids = [...new Set(sheets)];
	if (ids.length !== sheets.length || ids.some(id => !/^[0-9]{6}$/.test(id))) {
		throw new Error("Repeated or malformed Vienna CityGML sheet ID");
	}
	return [...sheets].sort().filter((_, index) => index % shards === shard);
}

async function cli(args = process.argv.slice(2)) {
	if (args.length !== 6 || args[0] !== "--manifest" || args[2] !== "--shard" || args[4] !== "--shards") {
		throw new Error("Usage: split-download-manifest.mjs --manifest file --shard N --shards M");
	}
	const manifest = JSON.parse(await fs.readFile(args[1], "utf8"));
	const shard = Number(args[3]);
	const shards = Number(args[5]);
	const selected = splitSheets(selectedSheets(manifest), shard, shards);
	if (!selected.length) throw new Error("Empty CityGML download shard");
	const filename = path.resolve("wien-native-city/build/roof-sector/shard-" + shard + "/targets.json");
	await fs.mkdir(path.dirname(filename), { recursive: true });
	await fs.writeFile(filename, JSON.stringify({
		schemaVersion: 1,
		source: args[1],
		shard,
		shards,
		buildings: selected.map(sheet => ({ sheet }))
	}, null, "\t") + "\n");
	console.log("Shard", shard, "/", shards, "contains", selected.length, "sheets:", selected.join(","));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	cli().catch(e => { console.error(e?.stack || e); process.exitCode = 1; });
}
