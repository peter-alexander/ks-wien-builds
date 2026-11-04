import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
	MAGIC, makePilotKeys, encodeNativeTile, safeRoofCandidates, selectRoofParts
} from "./build.mjs";

const TILE = { z: 15, x: 17873, y: 11364 };

function makeTriangleGeometry(source = "lod1") {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute([
		4096, 4096, 0,
		4100, 4096, 10,
		4096, 4100, 10
	], 3));
	geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
		0, 0, 1,
		0, 0, 1,
		0, 0, 1
	], 3));
	geometry.setIndex([0, 1, 2]);
	geometry.userData.ksGroundRanges = [{
		start: 0, count: 3,
		key: source + ":triangle",
		lng: 16.362449, lat: 48.191404
	}];
	return geometry;
}

test("pilot is a contiguous 3×3 block of Z15 tiles", () => {
	assert.deepEqual(makePilotKeys(), [
		"15/17872/11363", "15/17873/11363", "15/17874/11363",
		"15/17872/11364", "15/17873/11364", "15/17874/11364",
		"15/17872/11365", "15/17873/11365", "15/17874/11365"
	]);
});

test("KSWN0001 encodes render-ready relative heights, normals, anchors, and indices", () => {
	const geometry = makeTriangleGeometry();
	try {
		const { raw, stats } = encodeNativeTile(TILE, [
			{ source: "lod1", geometry }
		]);
		assert.equal(raw.subarray(0, 8).toString("ascii"), MAGIC);
		assert.equal(raw.readUInt32LE(8), 1);
		assert.equal(raw.readUInt32LE(12), 8192);
		assert.equal(raw.readUInt32LE(16), 3);
		assert.equal(raw.readUInt32LE(20), 3);
		assert.equal(raw.readUInt32LE(24), 1);
		const length = raw.readUInt32LE(28);
		const metadata = JSON.parse(raw.subarray(32, 32 + length));
		const start = 32 + length + (4 - length % 4) % 4;
		assert.equal(metadata.geometry, "relative-heights-no-terrain");
		assert.equal(metadata.buildings[0].source, "lod1");
		assert.ok(Number.isFinite(metadata.buildings[0].anchorX));
		assert.equal(raw.readInt16LE(start), 0);
		assert.equal(raw.readInt16LE(start + 16), 16);
		assert.equal(raw.readUInt16LE(start + 4), 0);
		assert.equal(raw.readUInt16LE(start + 16 + 4), 1000);
		assert.equal(raw.readInt16LE(start + 10), 32767);
		assert.equal(raw.readUInt8(start + 12), 2);
		assert.equal(raw.readUInt32LE(start + 3 * 16 + 8), 2);
		assert.equal(stats.buildingParts, 1);
		assert.equal(stats.lod1Parts, 1);
		assert.equal(stats.lod21Parts, 0);
		assert.ok(stats.gzipBytes < stats.rawBytes);
	} finally {
		geometry.dispose();
	}
});

test("invalid absolute/negative heights are rejected (no terrain in mesh)", () => {
	const geometry = makeTriangleGeometry();
	geometry.getAttribute("position").setZ(0, -4);
	try {
		assert.throws(() => encodeNativeTile(TILE, [
			{ source: "lod1", geometry }
		]), /Invalid relative building height/);
	} finally {
		geometry.dispose();
	}
});

test("strict roof policy never substitutes current FMZK for an unmatched historical roof", () => {
	const targets = {
		buildings: [
			{ historicalCode: "safe", bwGebId: 123,
				ksIds: ["wien-fmzk:1"], rolloutMode: "direct-strong",
				expectedRemainderM2: 0.2, historicalOutsideCurrentM2: 0.1 },
			{ historicalCode: "large-rest", bwGebId: 124,
				ksIds: ["wien-fmzk:2"], rolloutMode: "direct-strong",
				expectedRemainderM2: 16, historicalOutsideCurrentM2: 0 },
			{ historicalCode: "hybrid", bwGebId: 125,
				ksIds: ["wien-fmzk:3"], rolloutMode: "hybrid-a",
				expectedRemainderM2: 0, historicalOutsideCurrentM2: 0 }
		]
	};
	const allowed = safeRoofCandidates(targets);
	assert.deepEqual([...allowed.keys()], ["safe"]);
	const parsed = {
		metadata: {
			buildings: [
				{ historicalCode: "safe", bwGebId: 123 },
				{ historicalCode: "large-rest", bwGebId: 124 },
				{ historicalCode: "hybrid", bwGebId: 125 }
			]
		}
	};
	assert.deepEqual(selectRoofParts(parsed, allowed).map((b) => b.historicalCode), ["safe"]);
});

test("original CityGML source lineage is embedded in the native roof record",()=>{
	const roof=makeTriangleGeometry("lod21:42");
	try {
		const tile=encodeNativeTile(TILE,[{
			source:"lod21",
			geometry:roof,
			provenance:new Map([["lod21:42:triangle",["104079","104078"]]])
		}]);
		const n=tile.raw.readUInt32LE(28);
		const info=JSON.parse(tile.raw.subarray(32,32+n));
		assert.deepEqual(info.buildings[0].sourceSheets,["104078","104079"]);
		assert.throws(()=>encodeNativeTile(TILE,[{
			source:"lod21",geometry:roof,
			provenance:new Map()
		}]),/Missing original CityGML sheet lineage/);
	} finally {roof.dispose();}
});

test("historical roof output records which official FMZK KS_IDs it replaces",()=>{
	const roof=makeTriangleGeometry("lod21:42");
	try {
		const data=encodeNativeTile(TILE,[{
			source:"lod21",geometry:roof,
			provenance:new Map([["lod21:42:triangle",["104078"]]]),
			replacements:new Map([["lod21:42:triangle",["wien-fmzk:123","wien-fmzk:456"]]])
		}]);
		const size=data.raw.readUInt32LE(28);
		const info=JSON.parse(data.raw.subarray(32,32+size)).buildings[0];
		assert.deepEqual(info.replacesKsIds,["wien-fmzk:123","wien-fmzk:456"]);
		assert.throws(()=>encodeNativeTile(TILE,[{
			source:"lod21",geometry:roof,
			provenance:new Map([["lod21:42:triangle",["104078"]]]),
			replacements:new Map()
		}]),/Missing stable replaced FMZK KS_IDs/);
	}finally{roof.dispose();}
});
