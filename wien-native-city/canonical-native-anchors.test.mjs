import test from "node:test";
import assert from "node:assert/strict";
import {readNativeTile,writeNativeTile,NATIVE_EXTENT} from "./native-tile-patch.mjs";
import {reconcileNativeAnchors,logicalNativeBuildingId} from "./canonical-native-anchors.mjs";

function part(id,anchorX,anchorY,source="lod1"){
	const vertices=Buffer.alloc(3*16);
	for(let i=0;i<3;i++){
		vertices.writeUInt16LE(800,4+i*16);
		vertices.writeInt16LE(32767,10+i*16);
		vertices.writeUInt8(2,12+i*16);
	}
	const indices=Buffer.alloc(12);
	for(let i=0;i<3;i++)indices.writeUInt32LE(i,i*4);
	return {info:{source,id,anchorX,anchorY,
		...(source==="lod21"?{sourceSheets:["104078"]}:{})},vertices,indices};
}

test("FMZK KS_ID and historical building IDs identify logical groups, not polygons",()=>{
	assert.equal(logicalNativeBuildingId(part("ogd:wien-fmzk:42:0",0,0).info),
		"lod1:ogd:wien-fmzk:42");
	assert.equal(logicalNativeBuildingId(part("ogd:wien-fmzk:42:1",0,0).info),
		"lod1:ogd:wien-fmzk:42");
	assert.equal(logicalNativeBuildingId(part("lod21:42",0,0,"lod21").info),
		"lod21:lod21:42");
	assert.throws(()=>logicalNativeBuildingId(part("ogd:legacy-0:0",0,0).info),/stable/);
});

test("final release uses one absolute-world anchor across tiles, keeping geometry byte-exact",()=>{
	const left=writeNativeTile([
		part("ogd:wien-fmzk:42:0",NATIVE_EXTENT-20,150),
		part("ogd:wien-fmzk:99:0",130,150)
	]).compressed;
	const right=writeNativeTile([
		part("ogd:wien-fmzk:42:0",120,180),
		part("ogd:wien-fmzk:42:1",140,185),
		part("lod21:77",200,200,"lod21"),
		part("lod21:77",210,210,"lod21")
	]).compressed;
	const tiles=new Map([
		["15/100/200",{binary:left,metric:{buildingParts:2}}],
		["15/101/200",{binary:right,metric:{buildingParts:4}}]
	]);
	const result=reconcileNativeAnchors(tiles);
	assert.equal(result.changedTiles,1);
	assert.equal(result.affectedIdentities,2);
	assert.equal(result.correctedParts,3);
	const first=readNativeTile(result.tiles.get("15/100/200").binary);
	const second=readNativeTile(result.tiles.get("15/101/200").binary);
	const worldX=100*NATIVE_EXTENT+NATIVE_EXTENT-20;
	const worldY=200*NATIVE_EXTENT+150;
	for(const p of second.parts.filter(x=>x.info.id.startsWith("ogd:wien-fmzk:42:"))){
		assert.ok(Math.abs(101*NATIVE_EXTENT+p.info.anchorX-worldX)<0.001);
		assert.ok(Math.abs(200*NATIVE_EXTENT+p.info.anchorY-worldY)<0.001);
	}
	assert.deepEqual(first.parts[0].vertices,readNativeTile(left).parts[0].vertices);
	assert.deepEqual(second.parts[0].indices,readNativeTile(right).parts[0].indices);
	assert.equal(first.parts[1].info.anchorX,130);
	assert.equal(result.canonicalAnchors["lod1:ogd:wien-fmzk:42"][0],worldX);
	assert.equal(result.tiles.get("15/101/200").metric.gzipBytes,
		result.tiles.get("15/101/200").binary.length);
	assert.deepEqual(
		reconcileNativeAnchors(result.tiles).tiles.get("15/101/200").binary,
		result.tiles.get("15/101/200").binary
	);
});
