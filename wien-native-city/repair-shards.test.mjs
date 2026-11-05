import test from "node:test";
import assert from "node:assert/strict";
import {planRepairShards} from "./repair-shards.mjs";
test("schedule only unresolved 6-sheet jobs for fresh runners",()=>{
	const shards=[{shard:0,sheetCount:6},{shard:1,sheetCount:4},{shard:2,sheetCount:5}];
	const reports=new Map([
		[0,{requested:6,failed:[],skipped:0}],
		[1,{requested:4,failed:["111101"],skipped:1}],
		[2,{requested:5,failed:[],skipped:0}]
	]);
	assert.deepEqual(planRepairShards(shards,reports),{include:[{shard:1}],pending:1});
	reports.set(1,{requested:4,failed:[],skipped:0});
	assert.deepEqual(planRepairShards(shards,reports),{include:[{shard:-1}],pending:0});
});
test("an absent shard receipt cannot silently pass",()=>{
	assert.throws(()=>planRepairShards([{shard:0,sheetCount:3}],new Map()),/Incomplete/);
});
