import assert from "node:assert/strict";
import test from "node:test";
import { decodeLod21Tile, repackLod21Parent } from "./repack-z14.mjs";

function sourceTile({ x, y, anchorX = 3000, anchorY = 2000 }) {
	const tile = { z: 15, x, y };
	const metadata = {
		vertexStride: 16, extent: 8192, tile,
		buildings: [{
			bwGebId: x * 100 + y,
			historicalCode: "test",
			ogdKsIds: ["ks-test"],
			vertexStart: 0, vertexCount: 3,
			indexStart: 0, indexCount: 3,
			anchorX, anchorY
		}]
	};
	const json = Buffer.from(JSON.stringify(metadata));
	const offset = 32 + json.length + (4 - json.length % 4) % 4;
	const result = Buffer.alloc(offset + 3 * 16 + 3 * 4);
	result.write("KSL21B01", 0, "ascii");
	[[8, 1], [12, 8192], [16, 3], [20, 3], [24, 1],
		[28, json.length]].forEach(([p, value]) => result.writeUInt32LE(value, p));
	json.copy(result, 32);
	for (let v = 0; v < 3; v++) {
		result.writeInt16LE(v * 32, offset + v * 16);
		result.writeInt16LE(v * -32, offset + v * 16 + 2);
		result.writeUInt16LE(1234, offset + v * 16 + 4);
		result.writeInt16LE(32767, offset + v * 16 + 10);
		result.writeUInt32LE(v, offset + 3 * 16 + v * 4);
	}
	return { tile, buffer: result };
}

test("four Z15 tiles become one Z14 tile with preserved meshes", () => {
	const children = [sourceTile({ x: 17872, y: 11360 }),
		sourceTile({ x: 17873, y: 11360 }),
		sourceTile({ x: 17872, y: 11361 }),
		sourceTile({ x: 17873, y: 11361 })];
	const parent = { z: 14, x: 8936, y: 5680 };
	const result = decodeLod21Tile(repackLod21Parent(children, parent));
	assert.deepEqual(result.meta.tile, parent);
	assert.equal(result.vertices, 12);
	assert.equal(result.indices, 12);
	assert.equal(result.meta.buildings.length, 4);
	assert.deepEqual(result.meta.buildings.map(b => b.vertexStart), [0, 3, 6, 9]);
	assert.deepEqual(result.meta.buildings.map(b => b.indexStart), [0, 3, 6, 9]);
	assert.equal(result.meta.buildings[0].anchorX, 1500);
	assert.equal(result.meta.buildings[1].anchorX, 5596);
	assert.equal(result.meta.buildings[0].anchorY, 1000);
	assert.equal(result.meta.buildings[2].anchorY, 5096);
	const xy = children.map((_, i) => {
		const offset = result.vOffset + i * 3 * 16;
		return [result.buffer.readInt16LE(offset),
			result.buffer.readInt16LE(offset + 2)];
	});
	assert.deepEqual(xy, [
		[-8192, -8192], [8192, -8192],
		[-8192, 8192], [8192, 8192]
	]);
	for (let i = 0; i < 12; i++) {
		assert.equal(result.buffer.readUInt16LE(
			result.vOffset + i * 16 + 4
		), 1234);
		assert.equal(result.buffer.readUInt32LE(
			result.iOffset + i * 4
		), i);
	}
});

test("Z14 repacking refuses misplaced and duplicate child tiles", () => {
	const child = sourceTile({ x: 17872, y: 11360 });
	assert.throws(() => repackLod21Parent(
		[child], { z: 14, x: 8937, y: 5680 }
	), /Unexpected source tile/);
	assert.throws(() => repackLod21Parent(
		[child, child], { z: 14, x: 8936, y: 5680 }
	), /Duplicate source tile/);
});
