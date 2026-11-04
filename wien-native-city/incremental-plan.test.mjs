import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {sourceChanged,mapSheetsToTiles,planChangedTiles,computeBuilderRevision} from "./incremental-plan.mjs";

const inventory=JSON.parse(fs.readFileSync(new URL("./roof-inventory.snapshot.json",import.meta.url)));
const deps=mapSheetsToTiles(inventory);
const sha=computeBuilderRevision([{path:"encoder",content:"version1"},{path:"inputs",content:"abc"}]);
const baseSources=Object.fromEntries(Object.keys(deps.sheets).map(sheet=>[
	sheet,{status:"present",etag:'"old-'+sheet+'"',lastModified:"Wed, 04 Nov 2026 09:00:00 GMT",contentLength:"100"}
]));
const previous={
	format:"KSWN0001",
	fmzkRelease:inventory.sourceRelease,
	buildRevision:sha,
	publishedTileCount:deps.tileKeys.length,
	sources:baseSources
};

test("inventory conservatively covers all original citywide sheets and every native building tile",()=>{
	assert.equal(Object.keys(deps.sheets).length,1588);
	assert.equal(deps.tileKeys.length,678);
	assert.ok(deps.sheets["104078"].length>=1);
	assert.ok(deps.sheets["104078"].every(key=>deps.tileKeys.includes(key)));
});

test("conditional source caching respects 304-equivalent ETags and confirmed 404 transitions",()=>{
	assert.equal(sourceChanged({status:"present",etag:"a"},{status:"present",etag:"a"}),false);
	assert.equal(sourceChanged({status:"present",etag:"a"},{status:"present",etag:"b"}),true);
	assert.equal(sourceChanged({status:"missing",httpStatus:404},{status:"missing",httpStatus:404}),false);
	assert.equal(sourceChanged({status:"missing",httpStatus:404},{status:"present",etag:"x"}),true);
	assert.equal(sourceChanged({status:"present",etag:"x"},{status:"missing",httpStatus:404}),true);
	assert.equal(sourceChanged({status:"present"},{status:"present"}),true);
	assert.equal(sourceChanged({status:"present",sha256:"ff"},{status:"present",sha256:"ff"}),false);
	assert.equal(sourceChanged({status:"present",etag:"x",sha256:"a"},{status:"present",etag:"x",sha256:"b"}),true);
});

test("unmodified FMZK, CityGML and builder skip ALL 678 tiles",()=>{
	const plan=planChangedTiles({oldRelease:previous,newSources:baseSources,
		fmzkRelease:inventory.sourceRelease,buildRevision:sha,dependencyIndex:deps});
	assert.equal(plan.status,"unchanged");
	assert.equal(plan.reusableTiles,678);
	assert.deepEqual(plan.affectedTiles,[]);
});

test("one modified original sheet only invalidates its conservatively associated tiles",()=>{
	const modified={...baseSources,"104078":{...baseSources["104078"],etag:'"new"'}};
	const plan=planChangedTiles({oldRelease:previous,newSources:modified,
		fmzkRelease:inventory.sourceRelease,buildRevision:sha,dependencyIndex:deps});
	assert.equal(plan.status,"partial-rebuild");
	assert.deepEqual(plan.changedSheets,["104078"]);
	assert.deepEqual(plan.affectedTiles,deps.sheets["104078"]);
	assert.ok(plan.affectedTiles.length<678);
});

test("new source, FMZK version, encoder revision and missing release all require a rebuild",()=>{
	for(const fields of [
		{oldRelease:null},
		{oldRelease:previous,fmzkRelease:"new-fmzk"},
		{oldRelease:previous,buildRevision:computeBuilderRevision([{path:"encoder",content:"version2"}])}
	]) {
		const plan=planChangedTiles({
			oldRelease:previous,newSources:baseSources,fmzkRelease:inventory.sourceRelease,
			buildRevision:sha,dependencyIndex:deps,...fields});
		assert.equal(plan.status,"full-rebuild");
		assert.equal(plan.affectedTiles.length,678);
	}
});
test("incomplete/failed HTTP metadata cannot trigger a no-op release",()=>{
	const incomplete={...baseSources};
	delete incomplete["104078"];
	assert.throws(()=>planChangedTiles({oldRelease:previous,newSources:incomplete,
		fmzkRelease:inventory.sourceRelease,buildRevision:sha,dependencyIndex:deps}),/status incomplete/);
	const unknown={...baseSources,"104078":{status:"network-error"}};
	assert.throws(()=>planChangedTiles({oldRelease:previous,newSources:unknown,
		fmzkRelease:inventory.sourceRelease,buildRevision:sha,dependencyIndex:deps}),/Unverified/);
});
