import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCityReports } from "./aggregate.mjs";

function reports() {
	return Array.from({length:4}, (_,shard)=>({
		plan: {
			shard,
			sourceGeneratedAt: "release-id",
			selectedTileCount: 2,
			expectedKeys: ["15/" + (100+shard*2) + "/120", "15/" + (101+shard*2) + "/120"]
		},
		report: {
			shard, shards:4,
			sourceReleases: { lod1:"release-id",lod21:"roof-id" },
			sourceGeneratedAt:"release-id",
			wholeCityTileCount:8,
			status:"success",
			tiles:2, buildingParts:10, lod1Parts:9, lod21Parts:1,
			vertices:100, triangles:50, rawBytes:1024, gzipBytes:500,
			replacedFmzkParts:2, faceTriangles:{wall:25,pitchedRoof:10,flatRoof:15},
			largestTile:{key:"15/"+(100+shard*2)+"/120",bytes:250}
		}
	}));
}

test("complete city audit sums all reports and confirms complete tile coverage",()=>{
	const full=aggregateCityReports(reports());
	assert.equal(full.tiles,8);
	assert.equal(full.buildingParts,40);
	assert.equal(full.lod1Parts,36);
	assert.equal(full.lod21Parts,4);
	assert.equal(full.faceTriangles.pitchedRoof,40);
	assert.equal(full.completeCoverage,true);
	assert.equal(full.storageState,"artifacts only; not published to gh-pages");
});

test("missing shard, repeated tile or mixed source release fails the entire run",()=>{
	const report=reports();
	assert.throws(()=>aggregateCityReports(report.slice(0,3)),/Incomplete/);
	report[2].plan.expectedKeys[0]=report[1].plan.expectedKeys[0];
	assert.throws(()=>aggregateCityReports(report),/Duplicate Z15/);
	const mixed=reports();
	mixed[3].report.sourceReleases.lod1="new-release";
	assert.throws(()=>aggregateCityReports(mixed),/mixed-source/);
});

test("inconsistent triangle counts fail rather than claiming success",()=>{
	const report=reports();
	report[2].report.faceTriangles.pitchedRoof++;
	assert.throws(()=>aggregateCityReports(report),/do not reconcile/);
});
