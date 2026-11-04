import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {encodeNativeTile} from "../wien-native-pilot/build.mjs";
import {readNativeTile,writeNativeTile,patchNativeTile,groupKey} from "./native-tile-patch.mjs";

const TILE={z:15,x:17873,y:11364};
function makePart(id,z) {
	const geo=new THREE.BufferGeometry();
	geo.setAttribute("position",new THREE.Float32BufferAttribute([
		4096,4096,z,4098,4096,z+2,4096,4098,z+2
	],3));
	geo.setAttribute("normal",new THREE.Float32BufferAttribute([
		0,0,1,0,0,1,0,0,1
	],3));
	geo.setIndex([0,1,2]);
	geo.userData.ksGroundRanges=[{
		start:0,count:3,key:id,lng:16.362449,lat:48.191404
	}];
	return geo;
}
function makeTile(resources) {
	const inputs=resources.map(r=>({
		source:r.source,geometry:makePart(r.id,r.z),
		...(r.sheets?{provenance:new Map([[r.id,r.sheets]])}:{})
	}));
	try{return encodeNativeTile(TILE,inputs).compressed;}
	finally{for(const i of inputs)i.geometry.dispose();}
}
test("decode/encode retains precomputed relative vertex bytes, indices and source sheets",()=>{
	const buffer=makeTile([
		{id:"ogd:ks1:0",source:"lod1",z:4},
		{id:"lod21:42",source:"lod21",z:10,sheets:["104078","104079"]}
	]);
	const decoded=readNativeTile(buffer);
	assert.equal(decoded.parts.length,2);
	assert.deepEqual(decoded.parts[1].info.sourceSheets,["104078","104079"]);
	const reencoded=writeNativeTile(decoded.parts);
	const again=readNativeTile(reencoded.compressed);
	assert.equal(again.parts.length,2);
	for(let i=0;i<2;i++){
		assert.equal(groupKey(again.parts[i].info),groupKey(decoded.parts[i].info));
		assert.deepEqual(again.parts[i].vertices,decoded.parts[i].vertices);
		assert.deepEqual(again.parts[i].indices,decoded.parts[i].indices);
	}
	assert.equal(reencoded.stats.vertices,6);
	assert.equal(reencoded.stats.triangles,2);
});

test("replace one roof by an updated source without remeshing unaffected buildings",()=>{
	const old=makeTile([
		{id:"ogd:ks1:0",source:"lod1",z:4},
		{id:"lod21:42",source:"lod21",z:10,sheets:["104078"]},
		{id:"lod21:43",source:"lod21",z:11,sheets:["105078"]}
	]);
	const fresh=makeTile([
		{id:"lod21:42",source:"lod21",z:14,sheets:["104078"]}
	]);
	const oldParts=readNativeTile(old).parts;
	const merged=patchNativeTile({base:old,replacements:fresh,invalidate:["lod21:lod21:42"]});
	const newParts=readNativeTile(merged.compressed).parts;
	assert.equal(newParts.length,3);
	const find=(arr,id)=>arr.find(x=>x.info.id===id);
	assert.deepEqual(find(newParts,"ogd:ks1:0").vertices,find(oldParts,"ogd:ks1:0").vertices);
	assert.deepEqual(find(newParts,"lod21:43").vertices,find(oldParts,"lod21:43").vertices);
	assert.notDeepEqual(find(newParts,"lod21:42").vertices,find(oldParts,"lod21:42").vertices);
	assert.equal(merged.stats.lod21Parts,2);
});

test("explicit fallback is required before removing historical roof",()=>{
	const old=makeTile([{id:"lod21:42",source:"lod21",z:10,sheets:["104078"]}]);
	const fmzk=makeTile([{id:"ogd:ks1:0",source:"lod1",z:4}]);
	assert.throws(()=>patchNativeTile({base:old,replacements:fmzk,
		invalidate:["lod21:lod21:42"]}),/without replacement\/fallback/);
	const replacement=patchNativeTile({base:old,replacements:fmzk,
		invalidate:["lod21:lod21:42"],allowDeletion:true});
	assert.deepEqual(readNativeTile(replacement.compressed).parts.map(x=>x.info.source),["lod1"]);
});

test("invalidations must be explicit and preserved geometry may not be duplicated",()=>{
	const base=makeTile([{id:"lod21:42",source:"lod21",z:10,sheets:["104078"]}]);
	const incoming=makeTile([{id:"lod21:42",source:"lod21",z:14,sheets:["104078"]}]);
	assert.throws(()=>patchNativeTile({base,replacements:incoming,invalidate:[]}),/No invalidated/);
	assert.throws(()=>patchNativeTile({base,replacements:incoming,invalidate:["lod21:unknown"]}),/duplicate/);
});

test("corrupted native geometry is rejected (fail-closed)",()=>{
	const buffer=makeTile([{id:"lod21:42",source:"lod21",z:10,sheets:["104078"]}]);
	const decoded=readNativeTile(buffer);
	const p=decoded.parts[0];
	assert.throws(()=>writeNativeTile([{...p,indices:Buffer.from([1,2])}]),/Invalid packed/);
	const serialized=writeNativeTile(decoded.parts,{gzip:false}).raw;
	assert.throws(()=>readNativeTile(serialized.subarray(0,serialized.length-3)),/offsets/);
});
