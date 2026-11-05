import test from "node:test";
import assert from "node:assert/strict";
import {parentOfTile,rebaseXY} from "./zoom-aggregate-audit.mjs";

test("all four Z15 children map into one Z14 parent with correct quantized positions",()=>{
	const origin=Buffer.alloc(16);origin.writeInt16LE(-16384,0);origin.writeInt16LE(-16384,2);
	assert.equal(parentOfTile("15/17872/11360",14),"14/8936/5680");
	assert.equal(parentOfTile("15/17873/11361",14),"14/8936/5680");
	assert.deepEqual(rebaseXY(origin,0,"15/17872/11360",14),[0,0]);
	assert.deepEqual(rebaseXY(origin,0,"15/17873/11360",14),[4096,0]);
	assert.deepEqual(rebaseXY(origin,0,"15/17872/11361",14),[0,4096]);
});
test("all sixteen children map into one Z13 parent; local coordinates stay inside bounds",()=>{
	const origin=Buffer.alloc(16);origin.writeInt16LE(0,0);origin.writeInt16LE(0,2);
	assert.equal(parentOfTile("15/17872/11360",13),"13/4468/2840");
	assert.equal(parentOfTile("15/17875/11363",13),"13/4468/2840");
	assert.deepEqual(rebaseXY(origin,0,"15/17875/11363",13),[7168,7168]);
});
test("invalid zooms and missing Z15 tile keys fail closed",()=>{
	assert.throws(()=>parentOfTile("14/1/2",14),/Z15/);
	assert.throws(()=>parentOfTile("15/1/2",12),/Z15/);
	assert.throws(()=>rebaseXY(Buffer.alloc(16),0,"15/1/2",12),/Unsupported/);
});
