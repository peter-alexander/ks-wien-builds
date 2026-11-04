#!/usr/bin/env node
/**
 * Independent Vienna Z15 terrain-aware mesh pilot.
 *
 * Inputs are OUR publicly published OGD FMZK and audited historical LOD2.1
 * tiles, never Maptoolkit/Stadtplan tiles. No runtime geometry rebuilding:
 * tiles contain pre-triangulated, fixed 16-byte vertices + Uint32 indices.
 *
 * Each tile has one anchor per rigid building part. Absolute terrain
 * elevation is never stored. MapLibre supplies the DEM at render time.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import * as THREE from "three";
import {
	buildWienOgdFallbackTileGeometry
} from "../wien-optimized/src/app/buildings/wien-ogd-fallback-geometry.js";
import {
	parseWienLod21Tile,
	decodeWienLod21MeshData,
	createWienLod21ThreeGeometry
} from "../wien-optimized/src/app/buildings/wien-lod21-geometry.js";

export const BASE = "https://peter-alexander.github.io/ks-wien-builds/WienBuildings";
export const MAGIC = "KSWN0001";
export const EXTENT = 8192;
export const CENTER = Object.freeze({ z: 15, x: 17873, y: 11364 }); // Straußengasse
export const RADIUS = 1; // 3x3 contiguous tiles
const MAX_HEIGHT_CM = 65535;

export function makePilotKeys(center = CENTER, radius = RADIUS) {
	if (center.z !== 15 || !Number.isSafeInteger(radius) || radius < 0 || radius > 3) {
		throw new RangeError("Pilot needs Z15 and radius 0..3");
	}
	const keys = [];
	for (let y = center.y - radius; y <= center.y + radius; y++) {
		for (let x = center.x - radius; x <= center.x + radius; x++) {
			if (x < 0 || y < 0 || x >= 2 ** center.z || y >= 2 ** center.z) {
				throw new RangeError("Pilot outside Web Mercator tile grid");
			}
			keys.push(`${center.z}/${x}/${y}`);
		}
	}
	return keys;
}

function clampInt16(value) {
	if (!Number.isFinite(value) || value < -32768 || value > 32767) {
		throw new RangeError(`Packed building coordinate out of range: ${value}`);
	}
	return Math.round(value);
}

function clampHeightCm(value) {
	const height = Math.round(value * 100);
	if (!Number.isFinite(height) || height < 0 || height > MAX_HEIGHT_CM) {
		throw new RangeError(`Invalid relative building height: ${value}`);
	}
	return height;
}

function anchorToTile({ z, x, y }, { lng, lat }) {
	if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
		throw new RangeError("Invalid building terrain anchor");
	}
	const n = 2 ** z;
	const mercX = (lng + 180) / 360 * n;
	const mercY = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
	return [(mercX - x) * EXTENT, (mercY - y) * EXTENT];
}

function surfaceKind(nx, ny, nz) {
	// One-byte semantic surface kind; no textures or three.js dependency in client.
	if (nz > 0.995) return 2; // flat roof
	if (nz > 0.12) return 1; // pitched roof
	return 0; // wall/underside
}

/**
 * Encode a set of independent Three.js BufferGeometries using the existing
 * verified 16-byte packed vertex layout, but a new independent magic/version.
 * Each groundRange represents one rigid part with ONE shared DEM anchor.
 */
export function encodeNativeTile(tile, resources) {
	const buildingRecords = [];
	let totalVertices = 0;
	let totalIndices = 0;
	for (const { geometry, source } of resources) {
		if (!geometry) continue;
		const vertexCount = geometry.getAttribute("position")?.count ?? 0;
		const indexCount = geometry.getIndex()?.count ?? 0;
		const ranges = geometry.userData?.ksGroundRanges;
		if (!Array.isArray(ranges) || !ranges.length || !vertexCount || !indexCount) {
			throw new Error(`Incomplete ${source} geometry`);
		}
		let covered = 0;
		let end = 0;
		for (const range of ranges) {
			if (range.start !== covered || !Number.isSafeInteger(range.count)
				|| range.count <= 0 || covered + range.count > vertexCount) {
				throw new Error(`Non-contiguous ${source} vertex ranges`);
			}
			covered += range.count;
			end++;
		}
		if (covered !== vertexCount || !end) {
			throw new Error(`Unassigned ${source} vertices`);
		}
		totalVertices += vertexCount;
		totalIndices += indexCount;
	}
	if (totalVertices > 2 ** 24 || totalIndices > 2 ** 25) {
		throw new RangeError("Unreasonably large pilot tile");
	}
	const vertexBytes = Buffer.alloc(totalVertices * 16);
	const indexBytes = Buffer.alloc(totalIndices * 4);
	let vertexOffset = 0;
	let indexOffset = 0;
	for (const { geometry, source } of resources) {
		if (!geometry) continue;
		const positions = geometry.getAttribute("position");
		const normals = geometry.getAttribute("normal");
		const indices = geometry.getIndex();
		const ranges = geometry.userData.ksGroundRanges;
		if (!normals || normals.count !== positions.count) {
			throw new Error(`Missing normals for ${source}`);
		}
		let indexCursor = 0;
		for (const range of ranges) {
			const start = range.start;
			const end = start + range.count;
			const rangeIndexStart = indexCursor;
			while (indexCursor < indices.count) {
				const a = indices.getX(indexCursor);
				if (a >= end) break;
				if (indexCursor + 2 >= indices.count) throw new Error("Truncated triangle");
				for (let j = 0; j < 3; j++) {
					const index = indices.getX(indexCursor + j);
					if (!Number.isSafeInteger(index) || index < start || index >= end) {
						throw new Error(`Triangle crosses ${source} part boundaries`);
					}
					indexBytes.writeUInt32LE(vertexOffset + index, (indexOffset + indexCursor + j) * 4);
				}
				indexCursor += 3;
			}
			const [anchorX, anchorY] = anchorToTile(tile, range);
			buildingRecords.push({
				source,
				id: String(range.key || ""),
				vertexStart: vertexOffset + start,
				vertexCount: range.count,
				indexStart: indexOffset + rangeIndexStart,
				indexCount: indexCursor - rangeIndexStart,
				anchorX, anchorY
			});
		}
		if (indexCursor !== indices.count) {
			throw new Error(`Unassigned ${source} indices`);
		}
		for (let i = 0; i < positions.count; i++) {
			const out = (vertexOffset + i) * 16;
			vertexBytes.writeInt16LE(clampInt16((positions.getX(i) - 4096) * 4), out);
			vertexBytes.writeInt16LE(clampInt16((positions.getY(i) - 4096) * 4), out + 2);
			vertexBytes.writeUInt16LE(clampHeightCm(positions.getZ(i)), out + 4);
			const nx = normals.getX(i);
			const ny = normals.getY(i);
			const nz = normals.getZ(i);
			for (const [n, offset] of [[nx, 6], [ny, 8], [nz, 10]]) {
				if (!Number.isFinite(n) || Math.abs(n) > 1.001) {
					throw new Error(`Invalid surface normal: ${n}`);
				}
				vertexBytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, n)) * 32767),
					out + offset);
			}
			vertexBytes.writeUInt8(surfaceKind(nx, ny, nz), out + 12);
		}
		vertexOffset += positions.count;
		indexOffset += indices.count;
	}
	const metadata = {
		kind: "ks-wien-native",
		geometry: "relative-heights-no-terrain",
		vertexStride: 16,
		extent: EXTENT,
		buildings: buildingRecords
	};
	const json = Buffer.from(JSON.stringify(metadata));
	const pad = (4 - json.length % 4) % 4;
	const header = Buffer.alloc(32);
	header.write(MAGIC, 0, "ascii");
	header.writeUInt32LE(1, 8);
	header.writeUInt32LE(EXTENT, 12);
	header.writeUInt32LE(totalVertices, 16);
	header.writeUInt32LE(totalIndices, 20);
	header.writeUInt32LE(buildingRecords.length, 24);
	header.writeUInt32LE(json.length, 28);
	const raw = Buffer.concat([header, json, Buffer.alloc(pad), vertexBytes, indexBytes]);
	return {
		raw,
		stats: {
			buildingParts: buildingRecords.length,
			lod1Parts: buildingRecords.filter((b) => b.source === "lod1").length,
			lod21Parts: buildingRecords.filter((b) => b.source === "lod21").length,
			vertices: totalVertices,
			triangles: totalIndices / 3,
			rawBytes: raw.length,
			gzipBytes: gzipSync(raw, { level: 9 }).length
		}
	};
}

export function safeRoofCandidates(targets) {
	const allowed = new Map();
	for (const target of targets.buildings || []) {
		if (!["direct-strong", "manual-pilot-strong"].includes(target.rolloutMode)) continue;
		// Never suppress part of a current FMZK building for a historical
		// roof when a meaningful footprint difference would create a gap.
		if (!Number.isFinite(target.expectedRemainderM2)
			|| !Number.isFinite(target.historicalOutsideCurrentM2)
			|| target.expectedRemainderM2 > 0.5
			|| target.historicalOutsideCurrentM2 > 0.5
			|| !Array.isArray(target.ksIds) || !target.ksIds.length) continue;
		allowed.set(String(target.historicalCode), target);
	}
	return allowed;
}

export function selectRoofParts(tileData, allowed) {
	const matches = [];
	const candidates = new Map();
	for (const building of tileData?.metadata?.buildings || []) {
		const target = allowed.get(String(building.historicalCode));
		if (!target || String(target.bwGebId) !== String(building.bwGebId)) continue;
		const key = String(building.bwGebId);
		const old = candidates.get(key);
		if (old && old.historicalCode !== target.historicalCode) {
			candidates.set(key, null); // ambiguous roof identity, fail closed
		} else if (old !== null) {
			candidates.set(key, target);
		}
	}
	for (const target of candidates.values()) {
		if (target) matches.push(target);
	}
	return matches;
}

async function request(url, asJson = false) {
	let error = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 45000);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
			return asJson ? await response.json() : await response.arrayBuffer();
		} catch (failure) {
			error = failure;
			if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
		} finally {
			clearTimeout(timer);
		}
	}
	throw error;
}

export async function buildPilot({
	outputDir = "wien-native-pilot/build",
	center = CENTER,
	radius = RADIUS,
	fetchData = request
} = {}) {
	const release = await fetchData(`${BASE}/LOD1/release.json`, true);
	const roofs = await fetchData(`${BASE}/LOD21/release.json`, true);
	const rawTargets = JSON.parse(await fs.readFile(
		fileURLToPath(new URL("../wien-lod21/targets.production.json", import.meta.url)), "utf8"
	));
	if (release?.vectorTiles?.compression !== "none"
		|| release?.vectorTiles?.layer !== "wien_buildings"
		|| release?.vectorTiles?.maxzoom !== 15
		|| roofs?.binary?.magic !== "KSL21B01") {
		throw new Error("Unexpected building source schema; abort pilot build");
	}
	const allowed = safeRoofCandidates(rawTargets);
	const lod1Tiles = new Set(release.vectorTiles.presentTilesZ15 || []);
	const roofTiles = new Set(roofs.tiles?.presentTilesZ15 || []);
	const keys = makePilotKeys(center, radius);
	const manifest = {
		schemaVersion: 1,
		format: MAGIC,
		zoom: 15,
		center,
		radius,
		sourceReleases: {
			lod1: release.generatedAt,
			lod21: roofs.generatedAt
		},
		tiles: {},
		generatedAt: new Date().toISOString(),
		terrainAltitudeStored: false,
		roofPolicy: "exact-audited-direct-strong-only",
		notes: "LOD1 complete, roofs only where current part identifiers match an exact small-footprint-difference historical roof. Not a citywide LOD2 dataset."
	};
	for (const key of keys) {
		if (!lod1Tiles.has(key)) {
			throw new Error(`LOD1 coverage missing for pilot key ${key}`);
		}
		const [z, x, y] = key.split("/").map(Number);
		const tile = { z, x, y };
		const lod1Buffer = await fetchData(`${BASE}/LOD1/tiles/${key}.pbf`);
		let roofGeometry = null;
		const excludedKsIds = new Set();
		if (roofTiles.has(key)) {
			const roofBuffer = await fetchData(`${BASE}/LOD21/tiles/${key}.bin`);
			const parsed = parseWienLod21Tile(roofBuffer);
			const selected = selectRoofParts(parsed, allowed);
			if (selected.length) {
				const selectedIds = new Set(selected.map((b) => String(b.bwGebId)));
				const notSelected = parsed.metadata.buildings
					.map((b) => String(b.bwGebId))
					.filter((id) => !selectedIds.has(id));
				const mesh = decodeWienLod21MeshData(parsed, tile, {
					excludedBuildingIds: notSelected
				});
				roofGeometry = createWienLod21ThreeGeometry(mesh, THREE);
				if (!roofGeometry) throw new Error(`Selected roof missing geometry: ${key}`);
				const actualIds = new Set(
					roofGeometry.userData.ksLOD21HistoricalCodes || []
				);
				for (const target of selected) {
					if (!actualIds.has(target.historicalCode)) {
						throw new Error(`Selected roof ${target.historicalCode} absent in ${key}`);
					}
					for (const id of target.ksIds) excludedKsIds.add(id);
				}
			}
		}
		const lod1 = buildWienOgdFallbackTileGeometry(
			lod1Buffer, tile,
			{ THREE, VectorTile, Protobuf: PbfReader },
			[], [...excludedKsIds]
		).geometry;
		if (!lod1 && !roofGeometry) throw new Error(`Empty pilot tile ${key}`);
		try {
			const { raw, stats } = encodeNativeTile(tile, [
				{ source: "lod1", geometry: lod1 },
				{ source: "lod21", geometry: roofGeometry }
			]);
			const output = path.join(outputDir, "tiles", key + ".bin");
			await fs.mkdir(path.dirname(output), { recursive: true });
			await fs.writeFile(output, raw);
			manifest.tiles[key] = {
				...stats,
				replacedFmzkParts: excludedKsIds.size
			};
			console.log(`${key}: ${stats.buildingParts} parts, ${stats.vertices} vertices, ${stats.rawBytes} B (${stats.gzipBytes} B gzip)`);
		} finally {
			lod1?.dispose();
			roofGeometry?.dispose();
		}
	}
	await fs.mkdir(outputDir, { recursive: true });
	await fs.writeFile(path.join(outputDir, "manifest.json"),
		JSON.stringify(manifest, null, "\t") + "\n");
	return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	buildPilot().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
