import test from "node:test";
import assert from "node:assert/strict";
import {verifyLowZoomRelease,validateLowZoomKeys,REFERENCE_OGD_RELEASE}
	from "./build-lowzoom.mjs";
const release={
	generatedAt:REFERENCE_OGD_RELEASE,
	vectorTiles:{minzoom:13,maxzoom:15,extent:4096,layer:"wien_buildings",
		compression:"none",tileCounts:{"13":62,"14":200,"15":678},
		geometryPolicy:{lowZooms:"13-14",featureDropping:false,tinyPolygonReduction:false},
		urlTemplate:"tiles/{z}/{x}/{y}.pbf"}
};
test("pinned official FMZK geometry is suitable for direct native Z14 and Z13 extrusion",()=>{
	assert.equal(verifyLowZoomRelease(release,14),release);
	assert.equal(verifyLowZoomRelease(release,13),release);
	assert.deepEqual(validateLowZoomKeys(14,["14/8936/5680","14/8937/5680"]),
		["14/8936/5680","14/8937/5680"]);
});
test("refuse changed FMZK geometry release, dropping policy or wrong tiles",()=>{
	assert.throws(()=>verifyLowZoomRelease({...release,generatedAt:"changed"},14),/no longer matches/);
	assert.equal(verifyLowZoomRelease({...release,generatedAt:"2026-11-05T08:00:00Z"},14).generatedAt,"2026-11-05T08:00:00Z");
	assert.throws(()=>verifyLowZoomRelease({...release,generatedAt:"2026-11-05T08:00:00Z"},14,
		{expectedRelease:REFERENCE_OGD_RELEASE}),/no longer matches/);
	assert.throws(()=>verifyLowZoomRelease({...release,vectorTiles:{...release.vectorTiles,
		geometryPolicy:{...release.vectorTiles.geometryPolicy,featureDropping:true}}},14),/no longer matches/);
	assert.throws(()=>validateLowZoomKeys(14,["14/8936/5680","14/8936/5680"]),/Invalid/);
	assert.throws(()=>validateLowZoomKeys(13,["14/8936/5680"]),/Invalid/);
});
