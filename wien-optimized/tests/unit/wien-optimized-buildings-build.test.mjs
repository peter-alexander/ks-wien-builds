import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { parseTileKey, encodeOptimizedTile, decodeOptimizedTile, stripBuildOnlyGeometryMetadata } from "../../scripts/build-wien-optimized-buildings.mjs";

test("optimized building tile preserves transferable mesh attributes", () => {
	const original = {
		lod2Geometry: {
			attributes: {
				position: { array: new Float32Array([0, 1.5, -2]), itemSize: 3, normalized: false },
				normal: { array: new Int8Array([127, 0, -127]), itemSize: 3, normalized: true },
				color: { array: new Uint8Array([250, 249, 248]), itemSize: 3, normalized: true }
			},
			index: { array: new Uint16Array([0, 1, 2]), itemSize: 1, normalized: false },
			userData: { ksRelativeHeights: new Float32Array([12.5]) }
		},
		lod21Geometry: null, lod1Geometry: null,
		failures: []
	};
	const encoded = encodeOptimizedTile(original);
	assert.equal(encoded.subarray(0, 2).toString("hex"), "1f8b");
	const decoded = decodeOptimizedTile(encoded, gunzipSync);
	assert.deepEqual(decoded, original);
});

test("only bounded Z15 keys are accepted", () => {
	assert.deepEqual(parseTileKey("15/17874/11362"), { z: 15, x: 17874, y: 11362 });
	for (const key of ["14/1/1", "15/-1/1", "15/32768/0", "15/1/NaN"]) {
		assert.throws(() => parseTileKey(key));
	}
});

test("offline-only overlap masks are stripped without losing DEM alignment data", () => {
	const resource = { lod2Geometry: { userData: {
		ksFallbackMaskPoints: [[1, 2]],
		ksFallbackMaskTilePoints: [[3, 4]],
		ksGroundRanges: [{ start: 0, count: 1, lng: 16.3, lat: 48.2 }],
		ksRelativeHeights: new Float32Array([10])
	} } };
	stripBuildOnlyGeometryMetadata(resource);
	assert.equal("ksFallbackMaskPoints" in resource.lod2Geometry.userData, false);
	assert.equal("ksFallbackMaskTilePoints" in resource.lod2Geometry.userData, false);
	assert.equal(resource.lod2Geometry.userData.ksGroundRanges.length, 1);
	assert.deepEqual(resource.lod2Geometry.userData.ksRelativeHeights, new Float32Array([10]));
});
