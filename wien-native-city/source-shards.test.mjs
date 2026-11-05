import test from "node:test";
import assert from "node:assert/strict";
import {planSourceShards} from "./source-shards.mjs";
test("every original CityGML sheet occurs once across bounded independent jobs",()=>{
	const sheets=Array.from({length:191},(_,i)=>String(i).padStart(6,"0"));
	const jobs=planSourceShards(sheets);
	assert.equal(jobs.length,32);
	assert.ok(jobs.every(j=>j.sheets.length<=6 && j.sheets.length>=1));
	assert.deepEqual(jobs.flatMap(j=>j.sheets).sort(),sheets);
	assert.equal(new Set(jobs.flatMap(j=>j.sheets)).size,191);
});
test("reject invalid or duplicate source shards",()=>{
	assert.throws(()=>planSourceShards(["001001","001001"]),/Repeated|malformed/);
	assert.throws(()=>planSourceShards(["001001"],7),/Invalid/);
	assert.throws(()=>planSourceShards(Array.from({length:385},(_,i)=>String(i).padStart(6,"0"))),/64/);
});
