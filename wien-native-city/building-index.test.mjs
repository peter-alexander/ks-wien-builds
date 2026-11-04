import test from "node:test";
import assert from "node:assert/strict";
import {writeNativeTile,readNativeTile,patchNativeTile,groupKey} from "./native-tile-patch.mjs";
import {indexNativeTiles,serializeNativeBuildingIndex,readNativeBuildingIndex,
	diffNativeBuildingIndexes} from "./building-index.mjs";

function part(id,source="lod1",height=400){
	const vertices=Buffer.alloc(48);
	const indices=Buffer.alloc(12);
	for(let i=0;i<3;i++){
		vertices.writeUInt16LE(height,i*16+4);
		vertices.writeInt16LE(32767,i*16+10);
		vertices.writeUInt8(2,i*16+12);
		indices.writeUInt32LE(i,i*4);
	}
	return {info:{source,id,anchorX:100,anchorY:100,
		...(source==="lod21"?{
			sourceSheets:["104078","104079"],replacesKsIds:["wien-fmzk:88"]
		}:{})},vertices,indices};
}
const tile=p=>writeNativeTile(p).compressed;
const set=entries=>new Map(entries.map(([key,parts])=>[key,{binary:tile(parts)}]));

test("source-aware Z15 index groups logical FMZK IDs and multi-part roofs across tiles",()=>{
	const tiles=set([
		["15/100/200",[part("ogd:wien-fmzk:42:0"),part("lod21:99","lod21")]],
		["15/101/200",[part("ogd:wien-fmzk:42:1"),part("lod21:99","lod21")]]
	]);
	const index=indexNativeTiles(tiles);
	assert.equal(index.tileCount,2);
	assert.equal(index.buildingParts,4);
	assert.equal(index.buildingCount,2);
	assert.equal(Object.keys(index.buildings["lod1:ogd:wien-fmzk:42"].tiles).length,2);
	const roof=index.buildings["lod21:lod21:99"];
	assert.equal(roof.partCount,2);
	assert.deepEqual(roof.sourceSheets,["104078","104079"]);
	assert.deepEqual(roof.replacesKsIds,["wien-fmzk:88"]);
	const encoded=serializeNativeBuildingIndex(index);
	assert.deepEqual(readNativeBuildingIndex(encoded.gzip),index);
	assert.equal(encoded.gzip.length,encoded.compressedBytes);
	assert.match(encoded.sha256,/^[a-f0-9]{64}$/);
	assert.deepEqual(diffNativeBuildingIndexes(index,index),{
		schemaVersion:1,added:[],removed:[],changed:[],unchangedCount:2,
		affectedTiles:[],requiresDeletionReview:false
	});
});

test("new, modified, removed and moved buildings affect union of old and new tiles",()=>{
	const before=indexNativeTiles(set([
		["15/100/200",[part("ogd:wien-fmzk:1:0"),part("ogd:wien-fmzk:2:0")]],
		["15/101/200",[part("ogd:wien-fmzk:3:0")]]
	]));
	const after=indexNativeTiles(set([
		["15/100/200",[part("ogd:wien-fmzk:1:0", "lod1",401),part("ogd:wien-fmzk:4:0")]],
		["15/101/200",[part("ogd:wien-fmzk:3:0")]],
		["15/102/200",[part("ogd:wien-fmzk:5:0")]]
	]));
	const changes=diffNativeBuildingIndexes(before,after);
	assert.deepEqual(changes.added,["lod1:ogd:wien-fmzk:4","lod1:ogd:wien-fmzk:5"]);
	assert.deepEqual(changes.removed,["lod1:ogd:wien-fmzk:2"]);
	assert.deepEqual(changes.changed,["lod1:ogd:wien-fmzk:1"]);
	assert.equal(changes.unchangedCount,1);
	assert.deepEqual(changes.affectedTiles,["15/100/200","15/102/200"]);
	assert.equal(changes.requiresDeletionReview,true);
});

test("a historical roof can be fully replaced without touching unrelated geometry",()=>{
	const old=tile([part("lod21:99","lod21"),part("lod21:99","lod21",405),
		part("ogd:wien-fmzk:4:0")]);
	const next=tile([part("lod21:99","lod21",410),part("lod21:99","lod21",415)]);
	const updated=patchNativeTile({base:old,replacements:next,
		invalidate:["lod21:lod21:99"]});
	const parts=readNativeTile(updated.compressed).parts;
	assert.equal(parts.length,3);
	assert.deepEqual(parts.filter(p=>groupKey(p.info)==="lod21:lod21:99")
		.map(p=>p.vertices.readUInt16LE(4)),[410,415]);
	assert.deepEqual(parts[0].vertices,readNativeTile(old).parts[2].vertices);
});

test("changed roof lineage is detected even if its packed geometry stays identical",()=>{
	const original=part("lod21:99","lod21");
	const altered=structuredClone(original);
	altered.info.sourceSheets=["104080"];
	const old=indexNativeTiles(set([["15/100/200",[original]]]));
	const next=indexNativeTiles(set([["15/100/200",[altered]]]));
	assert.deepEqual(diffNativeBuildingIndexes(old,next).changed,["lod21:lod21:99"]);
});
