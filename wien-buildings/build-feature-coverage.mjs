#!/usr/bin/env node
/**
 * Conservative Z15 feature-to-tile coverage for progressive OGD fallback.
 * Bounding boxes intentionally overestimate tile membership. A building
 * crossing a tile boundary must not be removed while any tile might still
 * need the MapLibre fallback.
 *
 * This does not map IDs in Maptoolkit's native buildings2d source.
 */
import fs from "node:fs";
import readline from "node:readline";
import fsp from "node:fs/promises";
import path from "node:path";

const ZOOM = 15;
const scale = 2 ** ZOOM;
function coordinatesBounds(geometry) {
	const bounds = [Infinity, Infinity, -Infinity, -Infinity];
	const visit = (value) => {
		if (!Array.isArray(value)) return;
		if (typeof value[0] === "number" && typeof value[1] === "number") {
			bounds[0] = Math.min(bounds[0], value[0]);
			bounds[1] = Math.min(bounds[1], value[1]);
			bounds[2] = Math.max(bounds[2], value[0]);
			bounds[3] = Math.max(bounds[3], value[1]);
		} else for (const nested of value) visit(nested);
	};
	visit(geometry?.coordinates);
	if (!bounds.every(Number.isFinite)) throw new Error("Invalid building bounds");
	return bounds;
}
function xTile(lon) {
	return Math.max(0, Math.min(scale - 1, Math.floor((lon + 180) / 360 * scale)));
}
function yTile(lat) {
	const rad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
	return Math.max(0, Math.min(scale - 1,
		Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * scale)));
}
export function candidateTiles(geometry) {
	const [west, south, east, north] = coordinatesBounds(geometry);
	const [x0, x1] = [xTile(west), xTile(east)];
	const [y0, y1] = [yTile(north), yTile(south)];
	if ((x1 - x0 + 1) * (y1 - y0 + 1) > 128) {
		throw new Error("Unexpectedly large building footprint");
	}
	const tiles = [];
	for (let x = x0; x <= x1; x++) {
		for (let y = y0; y <= y1; y++) tiles.push(`${x}/${y}`);
	}
	return tiles;
}
export async function buildFeatureCoverage(input, output) {
	const coverage = new Map();
	const lines = readline.createInterface({
		input: fs.createReadStream(input, { encoding: "utf8" }),
		crlfDelay: Infinity
	});
	for await (const line of lines) {
		if (!line.trim()) continue;
		const feature = JSON.parse(line);
		const id = String(feature?.properties?.KS_ID ?? "");
		if (!id) throw new Error("Missing OGD KS_ID");
		const tiles = coverage.get(id) || new Set();
		for (const tile of candidateTiles(feature.geometry)) tiles.add(tile);
		coverage.set(id, tiles);
	}
	const body = {
		schemaVersion: 1,
		zoom: ZOOM,
		identity: "OGD KS_ID only; native Stadtplan buildings2d has no matching IDs",
		features: Object.fromEntries([...coverage.entries()].sort(([a], [b]) => a.localeCompare(b))
			.map(([id, keys]) => [id, [...keys].sort()]))
	};
	await fsp.mkdir(path.dirname(output), { recursive: true });
	await fsp.writeFile(output, JSON.stringify(body) + "\n", "utf8");
	return body;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: build-feature-coverage.mjs input.geojsonseq output.json");
	await buildFeatureCoverage(process.argv[2], process.argv[3]);
}
