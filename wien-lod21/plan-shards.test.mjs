import test from "node:test";
import assert from "node:assert/strict";
import { createShardPlan } from "./plan-shards.mjs";

test("plan covers all production sheets exactly once including tail", () => {
	const ids = Array.from({ length: 734 }, (_, i) => String(i));
	const plan = createShardPlan(ids, 12);
	assert.equal(plan.include.length, 62);
	assert.deepEqual(plan.include[0], { index: 0, offset: 0, limit: 12 });
	assert.deepEqual(plan.include.at(-1), { index: 61, offset: 732, limit: 2 });
	const reconstructed = plan.include.flatMap((part) => ids.slice(part.offset, part.offset + part.limit));
	assert.deepEqual(reconstructed, ids);
});

test("invalid shard sizes are rejected", () => {
	assert.throws(() => createShardPlan(["1"], 0), /size/);
	assert.throws(() => createShardPlan(["1"], 21), /size/);
	assert.throws(() => createShardPlan([], 12), /empty/);
});
