#!/usr/bin/env node
/**
 * Repack published, audited Wiener KSL21B01 Z15 CityGML meshes as Z14.
 * No geometry simplification, historical-GML redownload or Maptoolkit
 * redistribution. 4 child tiles share one parent tile and retain normals,
 * per-building IDs, exact vertex index ranges and relative heights.
 */
import fs from "node:fs/promises";
import path from "node:path";

const MAGIC = "KSL21B01";
const EXTENT = 8192;
const STRIDE = 16;
const ZOOM = 15;
const OUTPUT_ZOOM = 14;
const HEADER = 32;

function assert(condition, reason) {
	if (!condition) throw new Error(reason);
}

export function decodeLod21Tile(buffer) {
	assert(Buffer.isBuffer(buffer) && buffer.length >= HEADER, "Truncated KSL21B01 tile");
	assert(buffer.toString("ascii", 0, 8) === MAGIC, "Invalid KSL21B01 magic");
	assert(buffer.readUInt32LE(8) === 1 && buffer.readUInt32LE(12) === EXTENT,
		"Incompatible binary version or tile extent");
	const vertices = buffer.readUInt32LE(16);
	const indices = buffer.readUInt32LE(20);
	const buildings = buffer.readUInt32LE(24);
	const metaLength = buffer.readUInt32LE(28);
	assert(metaLength > 0 && metaLength < 32 * 1024 * 1024, "Invalid metadata length");
	const meta = JSON.parse(buffer.toString("utf8", HEADER, HEADER + metaLength));
	const vOffset = HEADER + metaLength + (4 - metaLength % 4) % 4;
	const iOffset = vOffset + vertices * STRIDE;
	assert(iOffset + indices * 4 === buffer.length, "Binary size mismatch");
	assert(meta.vertexStride === STRIDE && meta.extent === EXTENT,
		"Incompatible metadata");
	assert(Array.isArray(meta.buildings) && meta.buildings.length === buildings,
		"Building record count mismatch");
	for (const building of meta.buildings) {
		assert(building.vertexStart >= 0 && building.vertexCount > 0
			&& building.vertexStart + building.vertexCount <= vertices
			&& building.indexStart >= 0 && building.indexCount > 0
			&& building.indexStart + building.indexCount <= indices,
			"Invalid building vertex/index ranges");
	}
	return { buffer, meta, vertices, indices, vOffset, iOffset };
}

function parentOf(tile) {
	return {
		z: OUTPUT_ZOOM,
		x: Math.floor(tile.x / 2),
		y: Math.floor(tile.y / 2)
	};
}

function reprojectCoordinate(encoded, parity) {
	// Signed int16 value represents (Z15-local position - 4096) * 4.
	// Parent-coordinate = parity * 4096 + Z15-coordinate / 2.
	const output = Math.round(encoded / 2 + parity * 16384 - 8192);
	assert(output >= -32768 && output <= 32767,
		"Repacked vertex exceeds signed Z14 tile-local range");
	return output;
}

export function repackLod21Parent(children, parent) {
	assert(Array.isArray(children) && children.length > 0, "Missing Z15 child tiles");
	const seen = new Set();
	const chunks = [];
	const buildings = [];
	let totalVertices = 0;
	let totalIndices = 0;
	for (const { tile, buffer } of children) {
		assert(tile.z === ZOOM && Math.floor(tile.x / 2) === parent.x
			&& Math.floor(tile.y / 2) === parent.y, "Unexpected source tile");
		const key = `${tile.x}/${tile.y}`;
		assert(!seen.has(key), "Duplicate source tile");
		seen.add(key);
		const parsed = decodeLod21Tile(buffer);
		assert(parsed.meta.tile.z === tile.z
			&& parsed.meta.tile.x === tile.x
			&& parsed.meta.tile.y === tile.y, "Source tile metadata mismatch");
		const vertices = Buffer.from(buffer.subarray(
			parsed.vOffset, parsed.iOffset
		));
		const px = tile.x % 2;
		const py = tile.y % 2;
		for (let index = 0; index < parsed.vertices; index++) {
			const offset = index * STRIDE;
			vertices.writeInt16LE(
				reprojectCoordinate(vertices.readInt16LE(offset), px), offset
			);
			vertices.writeInt16LE(
				reprojectCoordinate(vertices.readInt16LE(offset + 2), py), offset + 2
			);
		}
		const indices = Buffer.from(buffer.subarray(parsed.iOffset));
		for (let index = 0; index < parsed.indices; index++) {
			indices.writeUInt32LE(
				indices.readUInt32LE(index * 4) + totalVertices, index * 4
			);
		}
		for (const building of parsed.meta.buildings) {
			buildings.push({
				...building,
				vertexStart: building.vertexStart + totalVertices,
				indexStart: building.indexStart + totalIndices,
				anchorX: Number((4096 * px + building.anchorX / 2).toFixed(3)),
				anchorY: Number((4096 * py + building.anchorY / 2).toFixed(3))
			});
		}
		chunks.push({ vertices, indices });
		totalVertices += parsed.vertices;
		totalIndices += parsed.indices;
	}
	const metadata = {
		schemaVersion: 1,
		tile: parent,
		extent: EXTENT,
		vertexStride: STRIDE,
		quantization: {
			xyRenderUnits: 0.25,
			xyOrigin: EXTENT / 2,
			zMeters: 0.01,
			normalScale: 32767
		},
		buildings
	};
	const metaBytes = Buffer.from(JSON.stringify(metadata), "utf8");
	const padding = (4 - metaBytes.length % 4) % 4;
	const output = Buffer.alloc(
		HEADER + metaBytes.length + padding + totalVertices * STRIDE
		+ totalIndices * 4
	);
	output.write(MAGIC, 0, 8, "ascii");
	for (const [offset, value] of [
		[8, 1], [12, EXTENT], [16, totalVertices],
		[20, totalIndices], [24, buildings.length], [28, metaBytes.length]
	]) output.writeUInt32LE(value, offset);
	metaBytes.copy(output, HEADER);
	let vOffset = HEADER + metaBytes.length + padding;
	let iOffset = vOffset + totalVertices * STRIDE;
	for (const chunk of chunks) {
		chunk.vertices.copy(output, vOffset);
		chunk.indices.copy(output, iOffset);
		vOffset += chunk.vertices.length;
		iOffset += chunk.indices.length;
	}
	decodeLod21Tile(output);
	return output;
}

export async function repackLod21Directory(input, output) {
	const release = JSON.parse(await fs.readFile(
		path.join(input, "release.json"), "utf8"
	));
	assert(release.binary?.magic === MAGIC && release.binary?.zoom === ZOOM
		&& release.binary?.version === 1 && release.binary?.extent === EXTENT,
		"Input release is not compatible with KSL21B01 Z15");
	const present = release.tiles?.presentTilesZ15;
	assert(Array.isArray(present) && present.length, "Missing source tile index");
	const parents = new Map();
	for (const key of present) {
		const [z, x, y] = key.split("/").map(Number);
		assert(z === ZOOM && Number.isInteger(x) && Number.isInteger(y),
			"Invalid release tile key");
		const tile = { z, x, y };
		const parent = parentOf(tile);
		const parentKey = `${parent.z}/${parent.x}/${parent.y}`;
		const children = parents.get(parentKey) || [];
		children.push(tile);
		parents.set(parentKey, children);
	}
	const presentZ14 = [];
	let totalVertices = 0;
	let totalBuildings = 0;
	for (const [key, childTiles] of [...parents.entries()].sort(
		(a, b) => a[0].localeCompare(b[0])
	)) {
		const children = await Promise.all(childTiles.map(async (tile) => ({
			tile,
			buffer: await fs.readFile(path.join(
				input, "tiles", String(tile.z), String(tile.x), `${tile.y}.bin`
			))
		})));
		const [z, x, y] = key.split("/").map(Number);
		const binary = repackLod21Parent(children, { z, x, y });
		const decoded = decodeLod21Tile(binary);
		const filename = path.join(output, "tiles", String(z), String(x), `${y}.bin`);
		await fs.mkdir(path.dirname(filename), { recursive: true });
		await fs.writeFile(filename, binary);
		presentZ14.push(key);
		totalVertices += decoded.vertices;
		totalBuildings += decoded.meta.buildings.length;
	}
	assert(totalVertices === release.counts.vertices
		&& totalBuildings === release.counts.cityGmlBuildingObjects,
		"Repacking lost or duplicated CityGML geometry");
	const result = {
		schemaVersion: 1,
		generatedAt: release.generatedAt,
		source: release.source,
		sourceRelease: "../LOD21/release.json",
		binary: { ...release.binary, zoom: OUTPUT_ZOOM },
		tiles: { urlTemplate: "tiles/{z}/{x}/{y}.bin", presentTilesZ14: presentZ14 },
		counts: {
			vertices: totalVertices,
			cityGmlBuildingObjects: totalBuildings,
			tiles: presentZ14.length,
			sourceTiles: present.length
		}
	};
	await fs.writeFile(path.join(output, "release.json"),
		JSON.stringify(result, null, "\t") + "\n");
	return result;
}

if (process.argv[1] && import.meta.url === new URL(
	`file://${path.resolve(process.argv[1])}`
).href) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) {
		console.error("Usage: node repack-z14.mjs INPUT_LOD21_DIR OUTPUT_LOD21Z14_DIR");
		process.exitCode = 2;
	} else {
		repackLod21Directory(path.resolve(input), path.resolve(output))
			.then((release) => console.log(JSON.stringify(release.counts)))
			.catch((error) => {
				console.error(error.stack || error);
				process.exitCode = 1;
			});
	}
}
