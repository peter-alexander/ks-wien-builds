import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("./targets.production.json", import.meta.url), "utf8"));
const audit = JSON.parse(fs.readFileSync(new URL("./current-source-reconciliation.json", import.meta.url), "utf8"));

test("manifest current-geometry reconciliation is intentional and complete", () => {
	assert.equal(manifest.status, "production");
	assert.equal(manifest.buildings.length, 2309);
	assert.equal(manifest.counts.total, manifest.buildings.length);
	assert.equal(manifest.counts.hybridA, manifest.buildings.filter(item => item.rolloutMode === "hybrid-a").length);
	assert.equal(manifest.counts.hybridA, 613);
	assert.equal(manifest.counts.sourceSheets, new Set(manifest.buildings.map(item => String(item.sheet))).size);
	assert.deepEqual(audit.changes.map(x => x.historicalCode), ["052768", "181120"]);
	assert.equal(manifest.buildings.some(item => item.historicalCode === "052768"), false);
	const updated = manifest.buildings.find(item => item.historicalCode === "181120");
	assert.equal(updated.bwGebId, 5411794);
	assert.deepEqual(updated.ksIds, [
		"wien-fmzk:4001892559",
		"wien-fmzk:4007121901",
		"wien-fmzk:4007927900"
	]);
	const allIds = new Set(manifest.buildings.flatMap(item => item.ksIds || []));
	for (const id of ["4005738567", "4005738573", "4007653867"]) {
		assert.equal(allIds.has("wien-fmzk:" + id), false);
	}
	assert.equal(allIds.has("wien-fmzk:4007927900"), true);
});
