import { WIEN_BUILDING_STYLE } from "./wien-building-style.js";

/**
 * Wiener CityGML LOD2.1 fallback geometry (KSL21B01 v1).
 * Kept independent of MapLibre, network requests and Three.js so the same
 * decoded buffers can be reused by the future building/shadow renderers.
 * Layout and semantics match the former WienLOD2Buildings implementation.
 */
const MAGIC = "KSL21B01";
const VERSION = 1;
const EXTENT = 8192;
const HEADER_BYTES = 32;
const VERTEX_STRIDE = 16;
const XY_QUANTIZATION = 4;
const Z_CM = 100;
const NORMAL_SCALE = 32767;
const ROOF_REPLACEMENT_MODES = new Set([
	"maptoolkit-roof-replacement",
	"maptoolkit-roof-replacement-pilot"
]);

export const DEFAULT_WIEN_BUILDING_COLORS = WIEN_BUILDING_STYLE.colors;

function distinct(values) {
	return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function validRange(start, count, size) {
	return Number.isSafeInteger(start) && Number.isSafeInteger(count)
		&& start >= 0 && count > 0 && start <= size && count <= size - start;
}

function tileAnchor(tile, x, y, extent) {
	if (!Number.isInteger(tile?.z) || !Number.isInteger(tile?.x)
		|| !Number.isInteger(tile?.y) || ![14, 15].includes(tile.z)
		|| tile.x < 0 || tile.y < 0
		|| tile.x >= 2 ** tile.z || tile.y >= 2 ** tile.z
		|| !Number.isFinite(x) || !Number.isFinite(y)) {
		throw new RangeError("Invalid LOD2.1 tile or anchor.");
	}
	const scale = 2 ** tile.z;
	const worldY = (tile.y + y / extent) / scale;
	return {
		lng: (tile.x + x / extent) / scale * 360 - 180,
		lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI
	};
}

export function parseWienLod21Tile(arrayBuffer) {
	if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < HEADER_BYTES) {
		throw new Error("Wien LOD2.1: missing or truncated binary header.");
	}
	const view = new DataView(arrayBuffer);
	const magic = new TextDecoder().decode(new Uint8Array(arrayBuffer, 0, 8));
	const version = view.getUint32(8, true);
	const extent = view.getUint32(12, true);
	const vertexCount = view.getUint32(16, true);
	const indexCount = view.getUint32(20, true);
	const buildingCount = view.getUint32(24, true);
	const metadataLength = view.getUint32(28, true);
	if (magic !== MAGIC || version !== VERSION || extent !== EXTENT) {
		throw new Error("Wien LOD2.1: incompatible binary format.");
	}
	const metadataEnd = HEADER_BYTES + metadataLength;
	if (metadataEnd > arrayBuffer.byteLength) {
		throw new Error("Wien LOD2.1: invalid metadata length.");
	}
	let metadata;
	try {
		metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
			new Uint8Array(arrayBuffer, HEADER_BYTES, metadataLength)
		));
	} catch (_) {
		throw new Error("Wien LOD2.1: invalid metadata JSON.");
	}
	const vertexOffset = metadataEnd + ((4 - metadataLength % 4) % 4);
	const indexOffset = vertexOffset + vertexCount * VERTEX_STRIDE;
	const expectedBytes = indexOffset + indexCount * 4;
	if (metadata?.vertexStride !== VERTEX_STRIDE
		|| metadata?.extent !== undefined && metadata.extent !== EXTENT
		|| !Array.isArray(metadata?.buildings)
		|| metadata.buildings.length !== buildingCount
		|| !Number.isSafeInteger(expectedBytes)
		|| expectedBytes !== arrayBuffer.byteLength) {
		throw new Error("Wien LOD2.1: inconsistent tile structure.");
	}
	for (const building of metadata.buildings) {
		if (!validRange(building?.vertexStart, building?.vertexCount, vertexCount)
			|| !validRange(building?.indexStart, building?.indexCount, indexCount)
			|| building.indexCount % 3 !== 0
			|| !Number.isFinite(building?.anchorX)
			|| !Number.isFinite(building?.anchorY)) {
			throw new Error("Wien LOD2.1: invalid building geometry range.");
		}
	}
	return { view, metadata, extent, vertexCount, indexCount,
		vertexOffset, indexOffset, vertexStride: VERTEX_STRIDE };
}

function selected(building, excluded, active) {
	const id = String(building.bwGebId ?? "").trim();
	if (id && excluded.has(id)) return false;
	if (!ROOF_REPLACEMENT_MODES.has(String(building.rolloutMode || ""))) return true;
	return active.has(String(building.historicalCode || "").trim());
}

export function decodeWienLod21MeshData(
	tileData,
	tile,
	{ excludedBuildingIds = [], activeRoofReplacementCodes = [], colors = DEFAULT_WIEN_BUILDING_COLORS } = {}
) {
	if (!tileData?.view || !Array.isArray(tileData?.metadata?.buildings)) {
		throw new TypeError("Expected parsed Wien LOD2.1 tile.");
	}
	const excluded = new Set(distinct(excludedBuildingIds));
	const active = new Set(distinct(activeRoofReplacementCodes));
	const positions = [];
	const normals = [];
	const colorBytes = [];
	const indices = [];
	const groundRanges = [];
	const buildingIds = [];
	const historicalCodes = [];
	const relativeHeights = [];
	const center = tileData.extent / 2;
	const view = tileData.view;

	for (const building of tileData.metadata.buildings) {
		if (!selected(building, excluded, active)) continue;
		const start = positions.length / 3;
		const vertexStart = building.vertexStart;
		const vertexCount = building.vertexCount;
		const indexStart = building.indexStart;
		const indexCount = building.indexCount;
		const buildingId = String(building.bwGebId ?? "").trim();
		const historicalCode = String(building.historicalCode ?? "").trim();

		for (let v = 0; v < vertexCount; v += 1) {
			const offset = tileData.vertexOffset + (vertexStart + v) * tileData.vertexStride;
			const height = view.getUint16(offset + 4, true) / Z_CM;
			const kind = view.getUint8(offset + 12);
			const color = kind === 1 ? colors["pitched-roof"]
				: kind === 2 ? colors["flat-roof"] : colors.wall;
			if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
				throw new TypeError("Wien LOD2.1: invalid surface color.");
			}
			positions.push(
				center + view.getInt16(offset, true) / XY_QUANTIZATION,
				center + view.getInt16(offset + 2, true) / XY_QUANTIZATION,
				height
			);
			normals.push(
				view.getInt16(offset + 6, true) / NORMAL_SCALE,
				view.getInt16(offset + 8, true) / NORMAL_SCALE,
				view.getInt16(offset + 10, true) / NORMAL_SCALE
			);
			colorBytes.push((color >>> 16) & 255, (color >>> 8) & 255, color & 255);
			relativeHeights.push(height);
		}

		for (let i = 0; i < indexCount; i += 1) {
			const sourceIndex = view.getUint32(
				tileData.indexOffset + (indexStart + i) * 4, true
			);
			if (sourceIndex < vertexStart || sourceIndex >= vertexStart + vertexCount) {
				throw new Error("Wien LOD2.1: index outside building range.");
			}
			indices.push(start + sourceIndex - vertexStart);
		}

		const anchor = tileAnchor(tile, building.anchorX, building.anchorY, tileData.extent);
		groundRanges.push({
			start, count: vertexCount,
			key: `lod21:${buildingId || historicalCode || start}`,
			...anchor,
			lastTerrainSignature: "",
			lastElevation: 0
		});
		if (buildingId) buildingIds.push(buildingId);
		if (historicalCode) historicalCodes.push(historicalCode);
	}

	if (!positions.length || !indices.length) return null;
	return {
		positions: Float32Array.from(positions),
		normals: Float32Array.from(normals),
		colors: Uint8Array.from(colorBytes),
		indices: Uint32Array.from(indices),
		relativeHeights: Float32Array.from(relativeHeights),
		groundRanges,
		buildingIds: distinct(buildingIds),
		historicalCodes: distinct(historicalCodes)
	};
}

export function createWienLod21ThreeGeometry(mesh, THREE) {
	if (!mesh) return null;
	if (typeof THREE?.BufferGeometry !== "function"
		|| typeof THREE?.BufferAttribute !== "function") {
		throw new TypeError("Three.js BufferGeometry and BufferAttribute required.");
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
	geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
	geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3, true));
	geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
	geometry.userData.ksRelativeHeights = mesh.relativeHeights;
	geometry.userData.ksGroundRanges = mesh.groundRanges;
	geometry.userData.ksVertexCount = mesh.positions.length / 3;
	geometry.userData.ksLOD21BuildingIds = mesh.buildingIds;
	geometry.userData.ksLOD21HistoricalCodes = mesh.historicalCodes;
	return geometry;
}
