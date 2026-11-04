import test from "node:test";
import assert from "node:assert/strict";
import { splitSheets } from "./split-download-manifest.mjs";

test("16 parallel jobs cover all 132 official sheets exactly once", () => {
	const ids = Array.from({ length: 132 }, (_, i) => String(100000 + i));
	const shards = Array.from({ length: 16 }, (_, i) => splitSheets(ids, i, 16));
	assert.ok(shards.every(part => part.length >= 8 && part.length <= 9));
	assert.deepEqual(shards.flat().sort(), ids);
	assert.deepEqual(splitSheets(ids.slice().reverse(), 3, 16), shards[3]);
});

test("reject duplicate IDs, empty slices and invalid shard counts", () => {
	assert.throws(() => splitSheets(["104078", "104078"], 0, 2), /Repeated/);
	assert.throws(() => splitSheets(["10407x"], 0, 1), /malformed/);
	assert.throws(() => splitSheets(["104078"], 1, 1), RangeError);
	assert.throws(() => splitSheets([], 0, 1), RangeError);
});
