import test from "node:test";
import assert from "node:assert/strict";
import { makeWienLod21OwnershipIndex } from "./build-ownership-index.mjs";

test("indexes only emitted meshes and deduplicates stable identifiers", () => {
	const tiles = new Map([["15/1/2", { buildings: [
		{ historicalCode: "001", rolloutMode: "direct-strong", ogdKsIds: ["b", "a", "a"], indexCount: 3, vertexCount: 3 },
		{ historicalCode: "001", rolloutMode: "direct-strong", ogdKsIds: ["a", "b"], indexCount: 6, vertexCount: 6 },
		{ historicalCode: "002", rolloutMode: "maptoolkit-roof-replacement", ogdKsIds: ["x"], indexCount: 3, vertexCount: 3 },
		{ historicalCode: "003", rolloutMode: "direct-strong", ogdKsIds: ["z"], indexCount: 0, vertexCount: 3 }
	] }]]);
	const index = makeWienLod21OwnershipIndex(tiles, "2026-10-31T00:00:00Z");
	assert.deepEqual(index.tiles["15/1/2"], [
		{ historicalCode: "001", mode: "direct-strong", ogdKsIds: ["a", "b"], fingerprintGuarded: false },
		{ historicalCode: "002", mode: "maptoolkit-roof-replacement", ogdKsIds: ["x"], fingerprintGuarded: true }
	]);
	assert.equal(index.nativeStadtplanIdsVerified, false);
	assert.deepEqual(index.counts, { tileCount: 1, geometryObjects: 3, historicalBuildings: 2 });
});

test("rejects ambiguous identities rather than dropping geometry", () => {
	assert.throws(() => makeWienLod21OwnershipIndex(new Map([["15/1/2", { buildings: [
		{ historicalCode: "001", rolloutMode: "direct-strong", ogdKsIds: ["a"], indexCount: 3, vertexCount: 3 },
		{ historicalCode: "001", rolloutMode: "direct-strong", ogdKsIds: ["b"], indexCount: 3, vertexCount: 3 }
	] }]]), "date"), /Conflicting/);
});
