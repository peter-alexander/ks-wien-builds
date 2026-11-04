import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {makeRegionPlan} from "./region-plan.mjs";

const inventory=JSON.parse(fs.readFileSync(new URL("./roof-inventory.snapshot.json",import.meta.url)));
test("whole Vienna source inventory deterministically covers each Z15 tile exactly once",()=>{
	const all=inventory.regions.flatMap(x=>makeRegionPlan(inventory,x.id).tiles);
	assert.equal(all.length,678);
	assert.equal(new Set(all).size,678);
});
test("4x4 source quadrants cover every region tile and preserve original source revisions",()=>{
	for(const region of inventory.regions){
		const plan=makeRegionPlan(inventory,region.id);
		assert.equal(plan.fmzkRelease,inventory.sourceRelease);
		assert.ok(plan.quadrants.length<=4);
		assert.deepEqual(plan.quadrants.flatMap(q=>q.tileKeys).sort(),plan.tiles);
		assert.deepEqual(plan.targets.buildings.map(s=>s.sheet),plan.sourceSheets);
	}
});
test("unknown region and incomplete source inventory are rejected",()=>{
	assert.throws(()=>makeRegionPlan(inventory,"unknown"),/Invalid/);
	assert.throws(()=>makeRegionPlan(inventory,"999-999"),/Unknown/);
});
