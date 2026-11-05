import test from "node:test";
import assert from "node:assert/strict";
import {readNativeTile,writeNativeTile} from "./native-tile-patch.mjs";
import {chunkNativeParts} from "./native-chunks.mjs";

function smallPart(index){
	const vertices=Buffer.alloc(16*3);
	const indices=Buffer.alloc(12);
	for(let i=0;i<3;i++){
		vertices.writeUInt16LE(350,i*16+4);
		vertices.writeInt16LE(32767,i*16+10);
		vertices.writeUInt8(2,i*16+12);
		indices.writeUInt32LE(i,i*4);
	}
	return {info:{source:"lod1",id:"ogd:wien-fmzk:"+index+":0",
		anchorX:100,anchorY:100},vertices,indices};
}
test("chunking native parts preserves every original byte and independent decodability",()=>{
	const input=Array.from({length:45},(_,i)=>smallPart(i));
	const chunks=chunkNativeParts(input,{targetBytes:2048});
	assert.ok(chunks.length>=5);
	const recovered=chunks.flatMap(chunk=>{
		const decoded=readNativeTile(chunk.compressed).parts;
		assert.equal(decoded.length,chunk.parts);
		return decoded;
	});
	assert.equal(recovered.length,input.length);
	for(let i=0;i<input.length;i++){
		assert.deepEqual(recovered[i].vertices,input[i].vertices);
		assert.deepEqual(recovered[i].indices,input[i].indices);
		assert.equal(recovered[i].info.id,input[i].info.id);
	}
	assert.throws(()=>chunkNativeParts(input,{targetBytes:512}),/capacity/);
});
test("default native decoder still enforces its original 16 MiB safety limit",()=>{
	const input=writeNativeTile([smallPart(1)]).compressed;
	assert.equal(readNativeTile(input).parts.length,1);
	assert.equal(readNativeTile(input,{maxBytes:32*1024*1024}).parts.length,1);
	assert.throws(()=>readNativeTile(input,{maxBytes:512*1024*1024}),/Unsafe/);
});
