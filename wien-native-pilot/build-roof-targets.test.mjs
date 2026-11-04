import assert from "node:assert/strict";
import test from "node:test";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import proj4 from "proj4";
import {
	normalizeCode, evaluateRoofMatch, reliefOfRoof, uniqueInteriorTile
} from "./build-roof-targets.mjs";

const reader = new GeoJSONReader();
const square = (x, y, size) => reader.read({
	type: "Polygon",
	coordinates: [[
		[x, y], [x + size, y], [x + size, y + size],
		[x, y + size], [x, y]
	]]
});
const tileCenter = (z, x, y) => {
	const n = 2 ** z;
	const lon = ((x + 0.5) / n) * 360 - 180;
	const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
	return [lon,lat];
};

test("normalize original GML address codes without discarding leading zeros", () => {
	assert.equal(normalizeCode("9238"), "009238");
	assert.equal(normalizeCode(9238), "009238");
	assert.equal(normalizeCode("009238"), "009238");
	assert.equal(normalizeCode("BEZUG"), "");
	assert.equal(normalizeCode(null), "");
});

test("only roof surfaces with real elevation variation count as pitched", () => {
	assert.equal(reliefOfRoof([{ semantic:"wall", rings:[[
		{x:0,y:0,z:1},{x:1,y:0,z:8}
	]] }]), 0);
	assert.equal(reliefOfRoof([{semantic:"roof",rings:[[
		{x:0,y:0,z:11},{x:2,y:0,z:13}
	]]}]), 2);
});

test("only geometrically matching pitched roofs may replace current FMZK", () => {
	const current = square(100, 100, 15);
	const same = square(100.05, 100.05, 15);
	const moved = square(105, 105, 15);
	assert.equal(evaluateRoofMatch({
		current, historical: same, currentHeight: 20, pitchedRelief: 3
	}).accept, true);
	assert.equal(evaluateRoofMatch({
		current, historical: moved, currentHeight: 20, pitchedRelief: 3
	}).reason, "outdated-footprint");
	assert.equal(evaluateRoofMatch({
		current, historical: same, currentHeight: 20, pitchedRelief: 0
	}).reason, "no-pitched-roof");
});

test("roofs crossing a Z15 tile boundary are not auto-swapped", () => {
	const [lng,lat] = tileCenter(15,17873,11364);
	const [x,y] = proj4("EPSG:4326","EPSG:31256",[lng,lat]);
	const inside = square(x-10, y-10, 20);
	assert.equal(uniqueInteriorTile(inside), "15/17873/11364");
	const [east] = tileCenter(15,17874,11364);
	const [edgeX] = proj4("EPSG:4326","EPSG:31256",[east-360/2**16,lat]);
	assert.equal(uniqueInteriorTile(square(edgeX-50,y-10,100)), null);
});
