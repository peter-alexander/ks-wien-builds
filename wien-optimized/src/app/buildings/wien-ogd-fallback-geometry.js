import { WIEN_BUILDING_STYLE } from "./wien-building-style.js";

/**
 * Vienna OGD FMZK LOD1 fallback, ported from kartensammlung-maplibre.
 * Distinguishes exact KS_ID exclusions (LOD2.1) from whole BW_GEB_ID
 * exclusions (Maptoolkit LOD2) to avoid duplicate buildings.
 *
 * No global MapLibre layer mutations: the controller can use the returned
 * exclusion metadata when swapping tile generations atomically.
 */
const SOURCE_EXTENT = 4096;
const RENDER_EXTENT = 8192;
const OGD_SOURCE_LAYER = "wien_buildings";
const ACTIVE_BUILDING_STYLE = { material: "maplibre-fill-extrusion",
	colors: WIEN_BUILDING_STYLE.colors };

function tilePointLngLat({ z, x, y }, pointX = 0.5, pointY = 0.5) {
	const scale = Math.pow(2, z);
	const worldX = (x + pointX) / scale;
	const worldY = (y + pointY) / scale;
	return {
		lng: worldX * 360 - 180,
		lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI
	};
}


function colorBytes(color, THREE, linear) {
	if (!linear) {
		return [
			(color >> 16) & 0xff,
			(color >> 8) & 0xff,
			color & 0xff
		];
	}

	const converted = new THREE.Color(color);
	return [
		Math.round(converted.r * 255),
		Math.round(converted.g * 255),
		Math.round(converted.b * 255)
	];
}


function normalizeFallbackExcludedIds(ids) {
	return [...new Set(
		(ids || [])
			.map((id) => String(id || "").trim())
			.filter(Boolean)
	)].sort();
}


function normalizeFallbackBuildingIds(ids) {
	return [...new Set(
		(ids || [])
			.map((id) => String(id ?? "").trim())
			.filter(Boolean)
	)].sort();
}


function samePoint2D(a, b) {
	return !!a && !!b && a.x === b.x && a.y === b.y;
}


function openRing2D(ring) {
	const points = [];
	for (const point of (ring || [])) {
		if (!points.length || !samePoint2D(points[points.length - 1], point)) {
			points.push(point);
		}
	}
	if (points.length > 1 && samePoint2D(points[0], points[points.length - 1])) {
		points.pop();
	}
	return points;
}


function signedArea2D(ring) {
	let area = 0;
	for (let index = 0; index < ring.length; index += 1) {
		const current = ring[index];
		const next = ring[(index + 1) % ring.length];
		area += current.x * next.y - next.x * current.y;
	}
	return area / 2;
}


function classifyFallbackRings(rings, renderUnitsPerExtentUnit) {
	const polygons = [];
	let polygon = null;
	let outerClockwise = null;

	for (const rawRing of (rings || [])) {
		const ring = openRing2D(rawRing)
			.map((point) => ({
				x: point.x * renderUnitsPerExtentUnit,
				y: point.y * renderUnitsPerExtentUnit
			}));
		if (ring.length < 3) continue;
		const area = signedArea2D(ring);
		if (area === 0) continue;
		if (outerClockwise === null) outerClockwise = area < 0;
		if ((area < 0) === outerClockwise) {
			polygon = [ring];
			polygons.push(polygon);
		} else if (polygon) {
			polygon.push(ring);
		}
	}

	return polygons;
}


function pointInRing2D(point, ring) {
	let inside = false;
	for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
		const a = ring[index];
		const b = ring[previous];
		const crosses = (
			(a.y > point.y) !== (b.y > point.y)
			&& point.x < (
				(b.x - a.x) * (point.y - a.y)
				/ ((b.y - a.y) || Number.EPSILON)
				+ a.x
			)
		);
		if (crosses) inside = !inside;
	}
	return inside;
}


function fallbackPolygonContainsPoint(polygon, point) {
	if (!polygon?.length || !pointInRing2D(point, polygon[0])) return false;
	for (let index = 1; index < polygon.length; index += 1) {
		if (pointInRing2D(point, polygon[index])) return false;
	}
	return true;
}


function fallbackBuildingHeights(properties) {
	const base = Math.max(0, Number(properties?.render_min_height) || 0);
	const height = Number(properties?.render_height);
	if (!Number.isFinite(height) || height <= base || height > 350) return null;
	return { base, height };
}


function appendFallbackPolygon({
	polygon,
	heights,
	positions,
	normals,
	colors,
	indices,
	relativeHeights,
	surfaceColors,
	THREE
}) {
	const contour = polygon?.[0] || [];
	if (contour.length < 3) return null;
	const holes = polygon.slice(1).filter((ring) => ring.length >= 3);
	const roofRings = [contour, ...holes];
	const roofPoints = roofRings.flat();
	const triangles = THREE.ShapeUtils.triangulateShape(
		contour.map((point) => new THREE.Vector2(point.x, point.y)),
		holes.map((ring) => ring.map((point) => new THREE.Vector2(point.x, point.y)))
	);
	if (!triangles.length) return null;

	const roofStart = positions.length / 3;
	const [roofRed, roofGreen, roofBlue] = surfaceColors["flat-roof"];

	for (const point of roofPoints) {
		positions.push(point.x, point.y, heights.height);
		normals.push(0, 0, 1);
		colors.push(roofRed, roofGreen, roofBlue);
		relativeHeights.push(heights.height);
	}

	for (const triangle of triangles) {
		indices.push(
			roofStart + triangle[0],
			roofStart + triangle[1],
			roofStart + triangle[2]
		);
	}

	const [wallRed, wallGreen, wallBlue] = surfaceColors.wall;
	for (const ring of roofRings) {
		for (let index = 0; index < ring.length; index += 1) {
			const a = ring[index];
			const b = ring[(index + 1) % ring.length];
			if (samePoint2D(a, b)) continue;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const length = Math.hypot(dx, dy) || 1;
			const nx = dy / length;
			const ny = -dx / length;
			const wallStart = positions.length / 3;
			positions.push(
				a.x, a.y, heights.base,
				b.x, b.y, heights.base,
				b.x, b.y, heights.height,
				a.x, a.y, heights.height
			);
			for (let vertex = 0; vertex < 4; vertex += 1) {
				normals.push(nx, ny, 0);
				colors.push(wallRed, wallGreen, wallBlue);
			}
			relativeHeights.push(
				heights.base,
				heights.base,
				heights.height,
				heights.height
			);
			indices.push(
				wallStart,
				wallStart + 1,
				wallStart + 2,
				wallStart,
				wallStart + 2,
				wallStart + 3
			);
		}
	}

	const firstTriangle = triangles[0];
	if (!firstTriangle?.length) return null;
	const trianglePoints = firstTriangle.map((index) => roofPoints[index]);
	return {
		x: trianglePoints.reduce((sum, point) => sum + point.x, 0) / 3,
		y: trianglePoints.reduce((sum, point) => sum + point.y, 0) / 3
	};
}


function buildFallbackTileGeometry(
	arrayBuffer,
	tileCoordinate,
	runtime,
	lod2MaskTilePoints = [],
	lod21ExcludedOgdIds = []
) {
	const exactLod21ExcludedIds = normalizeFallbackExcludedIds(lod21ExcludedOgdIds);
	if (!arrayBuffer?.byteLength) {
		return {
			geometry: null,
			excludedIds: exactLod21ExcludedIds,
			excludedBuildingIds: [],
			lod2ExcludedBuildingIds: []
		};
	}
	const { THREE, VectorTile, Protobuf } = runtime;
	const tile = new VectorTile(new Protobuf(new Uint8Array(arrayBuffer)));
	const layer = tile.layers?.[OGD_SOURCE_LAYER];
	if (!layer?.length) {
		return {
			geometry: null,
			excludedIds: exactLod21ExcludedIds,
			excludedBuildingIds: [],
			lod2ExcludedBuildingIds: []
		};
	}

	const extent = Number(layer.extent) || SOURCE_EXTENT;
	const renderUnitsPerExtentUnit = RENDER_EXTENT / extent;
	const positions = [];
	const normals = [];
	const colors = [];
	const indices = [];
	const relativeHeights = [];
	const groundRanges = [];
	const excludedIds = new Set(exactLod21ExcludedIds);
	const excludedBuildingIds = new Set();
	const lod2ExcludedBuildingIds = new Set();
	const decodedFeatures = [];
	const surfaceColors = Object.fromEntries(Object.entries(ACTIVE_BUILDING_STYLE.colors)
		.map(([kind, color]) => [
			kind,
			colorBytes(color, THREE, ACTIVE_BUILDING_STYLE.material === "lambert")
		]));
	let includedBuildings = 0;
	let excludedByLOD2 = 0;

	// Erste Runde: feststellen, welche logischen Gebaeude durch LOD2 abgedeckt
	// sind. Ein BW_GEB_ID kann aus mehreren FMZK-Baukoerpern bestehen.
	for (let featureIndex = 0; featureIndex < layer.length; featureIndex += 1) {
		const feature = layer.feature(featureIndex);
		if (feature?.type !== 3) continue;
		const properties = feature.properties || {};
		const heights = fallbackBuildingHeights(properties);
		if (!heights) continue;
		const polygons = classifyFallbackRings(
			feature.loadGeometry?.() || [],
			renderUnitsPerExtentUnit
		);
		if (!polygons.length) continue;
		const featureId = String(properties.KS_ID || "").trim();
		const buildingId = String(properties.BW_GEB_ID ?? "").trim();
		const directlyReplaced = polygons.some((polygon) => (
			lod2MaskTilePoints.some((point) => fallbackPolygonContainsPoint(polygon, point))
		));
		if (directlyReplaced) {
			if (buildingId) {
				excludedBuildingIds.add(buildingId);
				lod2ExcludedBuildingIds.add(buildingId);
			} else if (featureId) {
				excludedIds.add(featureId);
			}
		}
		decodedFeatures.push({
			featureIndex,
			featureId,
			buildingId,
			heights,
			polygons
		});
	}

	// Zweite Runde: sobald ein Teil eines BW_GEB_ID LOD2 besitzt, wird das
	// komplette OGD-Gebaeude entfernt. Sonst koennen flache Restprismen
	// geneigte LOD2-Daecher verdecken.
	for (const item of decodedFeatures) {
		const replacedByLOD2 = (
			(item.buildingId && excludedBuildingIds.has(item.buildingId))
			|| (item.featureId && excludedIds.has(item.featureId))
		);
		if (replacedByLOD2) {
			excludedByLOD2 += item.polygons.length;
			continue;
		}

		for (let polygonIndex = 0; polygonIndex < item.polygons.length; polygonIndex += 1) {
			const polygon = item.polygons[polygonIndex];
			const vertexStart = positions.length / 3;
			const anchorTilePoint = appendFallbackPolygon({
				polygon,
				heights: item.heights,
				positions,
				normals,
				colors,
				indices,
				relativeHeights,
				surfaceColors,
				THREE
			});
			const vertexCount = positions.length / 3 - vertexStart;
			if (!vertexCount || !anchorTilePoint) continue;

			const anchor = tilePointLngLat(
				tileCoordinate,
				anchorTilePoint.x / RENDER_EXTENT,
				anchorTilePoint.y / RENDER_EXTENT
			);
			groundRanges.push({
				start: vertexStart,
				count: vertexCount,
				key: `ogd:${item.featureIndex}:${polygonIndex}`,
				lng: anchor.lng,
				lat: anchor.lat,
				lastTerrainSignature: "",
				lastElevation: 0
			});
			includedBuildings += 1;
		}
	}

	let geometry = null;
	if (positions.length) {
		geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
		geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
		geometry.setAttribute("color", new THREE.Uint8BufferAttribute(colors, 3, true));
		geometry.setIndex(indices);
		geometry.userData.ksRelativeHeights = Float32Array.from(relativeHeights);
		geometry.userData.ksGroundRanges = groundRanges;
		geometry.userData.ksVertexCount = positions.length / 3;
		geometry.userData.ksOGDBuildingCount = includedBuildings;
		geometry.userData.ksOGDExcludedByLOD2 = excludedByLOD2;
	}

	return {
		geometry,
		excludedIds: [...excludedIds],
		excludedBuildingIds: [...excludedBuildingIds],
		lod2ExcludedBuildingIds: [...lod2ExcludedBuildingIds]
	};
}

export {
	buildFallbackTileGeometry as buildWienOgdFallbackTileGeometry,
	classifyFallbackRings as classifyWienOgdFallbackRings,
	fallbackPolygonContainsPoint as wienOgdPolygonContainsPoint
};
