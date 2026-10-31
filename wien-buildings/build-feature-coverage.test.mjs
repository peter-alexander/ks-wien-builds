import test from "node:test";
import assert from "node:assert/strict";
import { candidateTiles } from "./build-feature-coverage.mjs";

function polygon(west, south, east, north) {
	return { type: "Polygon", coordinates: [[
		[west, south], [east, south], [east, north], [west, north], [west, south]
	]] };
}

test("single building produces one or more conservative Z15 tiles", () => {
	const tiles = candidateTiles(polygon(16.3738, 48.2082, 16.374, 48.2084));
	assert.ok(tiles.length >= 1 && tiles.length <= 4);
	assert.equal(new Set(tiles).size, tiles.length);
});

test("building crossing tile boundary records both sides", () => {
	const z = 15, x = 17874;
	const lon = x / (2 ** z) * 360 - 180;
	const tiles = candidateTiles(polygon(lon - 0.00001, 48.2082, lon + 0.00001, 48.2083));
	assert.ok(tiles.some((key) => key.startsWith(`${x - 1}/`)));
	assert.ok(tiles.some((key) => key.startsWith(`${x}/`)));
});

test("invalid geometry must not silently produce coverage", () => {
	assert.throws(() => candidateTiles({ type: "Polygon", coordinates: [] }), /Invalid/);
});
