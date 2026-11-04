import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {pendingCityRegions,validateReceipts,VERIFIED_REGION,VERIFIED_RUN}
	from "./city-run-controller.mjs";

const inventory=JSON.parse(fs.readFileSync(new URL("./roof-inventory.snapshot.json",import.meta.url),"utf8"));
const sha="a".repeat(40);
const pending=pendingCityRegions(inventory);

test("full Vienna controller dispatches exactly the 17 missing regions",()=>{
	assert.equal(pending.length,17);
	assert.ok(!pending.includes(VERIFIED_REGION));
	assert.equal(new Set(pending).size,17);
	const keys=inventory.regions.flatMap(r=>r.tileKeys);
	assert.equal(new Set(keys).size,678);
});
test("full Vienna assembly rejects any omitted, duplicate or mismatched region receipt",()=>{
	const receipts=pending.map((region,i)=>({region,runId:1000+i,sha}));
	const runs=validateReceipts(inventory,receipts,{sha});
	assert.equal(runs.size,18);
	assert.equal(runs.get(VERIFIED_REGION),VERIFIED_RUN);
	assert.throws(()=>validateReceipts(inventory,receipts.slice(1),{sha}),/missing successful/);
	assert.throws(()=>validateReceipts(inventory,[...receipts,receipts[0]],{sha}),/duplicate/);
	assert.throws(()=>validateReceipts(inventory,
		receipts.map((r,i)=>i===0?{...r,sha:"bad"}:r),{sha}),/Invalid/);
	assert.throws(()=>validateReceipts(inventory,
		receipts.map((r,i)=>i===0?{...r,region:"0000-0000"}:r),{sha}),/Invalid/);
});
test("a changed or incomplete source grid cannot launch a citywide build",()=>{
	assert.throws(()=>pendingCityRegions({...inventory,coverage:{...inventory.coverage,tiles:677}}),/Unverified/);
	assert.throws(()=>pendingCityRegions({...inventory,regions:inventory.regions.slice(1)}),/Unverified/);
});
