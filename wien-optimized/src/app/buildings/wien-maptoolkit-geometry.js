import { WIEN_BUILDING_STYLE } from "./wien-building-style.js";

/**
 * Vienna Maptoolkit buildings3d geometry decoder, extracted from
 * kartensammlung-maplibre/Components/WienLOD2Buildings.js.
 *
 * The proprietary 3D MVT ClosePath(2) surface grouping, triangulation,
 * normal classification and FNV fingerprint algorithm are intentionally
 * unchanged. Fingerprints must match ks-wien-builds roof-replacement
 * manifests byte-for-byte; never replace them with feature IDs.
 *
 * No MapLibre map, web request, or Solar3DScene dependency.
 */
const SOURCE_EXTENT = 4096;
const RENDER_EXTENT = 8192;
const EARTH_CIRCUMFERENCE_METERS = 40_075_016.68557849;
const ROOF_MIN_UP_NORMAL = 0.2;
const FLAT_ROOF_MIN_UP_NORMAL = 0.985;
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


function tileCenterLngLat(tile) {
	return tilePointLngLat(tile);
}


function samePoint3D(a, b) {
	return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
}


function openPath(path) {
	const points = [];

	for (const point of (path || [])) {
		if (!points.length || !samePoint3D(points[points.length - 1], point)) {
			points.push(point);
		}
	}

	if (points.length > 1 && samePoint3D(points[0], points[points.length - 1])) {
		points.pop();
	}

	return points;
}


function decodeFeatureGeometry3D(feature) {
	const pbf = feature?._pbf;
	const geometryOffset = Number(feature?._geometry);
	if (!pbf || !Number.isFinite(geometryOffset) || geometryOffset < 0) {
		throw new Error("Wien LOD2: Feature besitzt keine lesbare 3D-Geometrie.");
	}

	pbf.pos = geometryOffset;
	const end = pbf.readVarint() + pbf.pos;
	const groups = [];
	let group = [];
	let path = null;
	let command = 1;
	let commandLength = 0;
	let x = 0;
	let y = 0;
	let z = 0;

	while (pbf.pos < end) {
		if (commandLength <= 0) {
			const commandAndLength = pbf.readVarint();
			command = commandAndLength & 0x7;
			commandLength = commandAndLength >> 3;
		}

		commandLength -= 1;
		if (command === 1 || command === 2) {
			if (command === 1) path = [];
			x += pbf.readSVarint();
			y += pbf.readSVarint();
			z += pbf.readSVarint();
			path.push({ x, y, z });
		} else if (command === 7) {
			if (!path?.length) {
				throw new Error("Wien LOD2: Flaechenabschluss ohne 3D-Pfad.");
			}

			// ClosePath(2) beginnt eine neue Flaeche; ClosePath(1) fuegt der
			// vorigen Flaeche einen Innenring hinzu. Das ist die proprietaere
			// Gruppierung des Wiener 3D-MVT-Formats.
			if (commandLength > 0) {
				group.push(path);
				groups.push(group);
				group = [];
				commandLength -= 1;
			} else if (groups.length) {
				groups[groups.length - 1].push(path);
			} else {
				groups.push([path]);
			}
		} else {
			throw new Error(`Wien LOD2: Unbekanntes 3D-MVT-Geometriekommando ${command}.`);
		}
	}

	return groups;
}


function newellNormal(points) {
	const normal = { x: 0, y: 0, z: 0 };

	for (let index = 0; index < points.length; index += 1) {
		const current = points[index];
		const next = points[(index + 1) % points.length];
		normal.x += (current.y - next.y) * (current.z + next.z);
		normal.y += (current.z - next.z) * (current.x + next.x);
		normal.z += (current.x - next.x) * (current.y + next.y);
	}

	return normal;
}


function normalizedNewellNormal(points) {
	const normal = newellNormal(points);
	const magnitude = Math.hypot(normal.x, normal.y, normal.z);
	if (magnitude < 1e-7) return null;
	return {
		x: normal.x / magnitude,
		y: normal.y / magnitude,
		z: normal.z / magnitude
	};
}


function dot3(a, b) {
	return a.x * b.x + a.y * b.y + a.z * b.z;
}


function projectRingToSurface(points, normal, THREE) {
	const basisX = { x: 1.1, y: 1.1, z: 1.1 };
	const normalComponent = dot3(basisX, normal);
	basisX.x -= normal.x * normalComponent;
	basisX.y -= normal.y * normalComponent;
	basisX.z -= normal.z * normalComponent;

	let magnitude = Math.hypot(basisX.x, basisX.y, basisX.z);
	if (magnitude < 1e-7) {
		basisX.x = Math.abs(normal.x) < 0.9 ? 1 : 0;
		basisX.y = Math.abs(normal.x) < 0.9 ? 0 : 1;
		basisX.z = 0;
		const fallbackComponent = dot3(basisX, normal);
		basisX.x -= normal.x * fallbackComponent;
		basisX.y -= normal.y * fallbackComponent;
		basisX.z -= normal.z * fallbackComponent;
		magnitude = Math.hypot(basisX.x, basisX.y, basisX.z);
	}

	basisX.x /= magnitude;
	basisX.y /= magnitude;
	basisX.z /= magnitude;
	const basisY = {
		x: normal.y * basisX.z - normal.z * basisX.y,
		y: normal.z * basisX.x - normal.x * basisX.z,
		z: normal.x * basisX.y - normal.y * basisX.x
	};

	return points.map((point) => new THREE.Vector2(
		dot3(point, basisX),
		dot3(point, basisY)
	));
}


function normalizeSurfaceRings(surface) {
	if (!Array.isArray(surface)) return [];
	if (surface.length && Array.isArray(surface[0])) return surface;
	return [surface];
}


function triangulateSurfaceIndices3D(surface, THREE) {
	const rings = normalizeSurfaceRings(surface)
		.map(openPath)
		.filter((ring) => ring.length >= 3);
	const contour = rings.shift();
	if (!contour || contour.length < 3) return null;

	const contourNormal = normalizedNewellNormal(contour);
	if (!contourNormal) return null;
	const projectedContour = projectRingToSurface(contour, contourNormal, THREE);

	const holes = [];
	const projectedHoles = [];
	for (const ring of rings) {
		const ringNormal = normalizedNewellNormal(ring) || contourNormal;
		const projectedRing = projectRingToSurface(ring, ringNormal, THREE);
		holes.push(ring);
		projectedHoles.push(projectedRing);
	}

	const triangles = THREE.ShapeUtils.triangulateShape(projectedContour, projectedHoles);
	return triangles.length ? {
		vertices: contour.concat(...holes),
		triangles
	} : null;
}


function getFeatureMetadata(groups) {
	const metadata = openPath(groups?.[0]?.[0]);
	if (metadata.length === 2) {
		return {
			baseDecimeters: Math.min(metadata[0].z, metadata[1].z),
			anchorX: (metadata[0].x + metadata[1].x) / 2,
			anchorY: (metadata[0].y + metadata[1].y) / 2,
			hasBounds: true
		};
	}

	const points = (groups || []).flat(2);
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const elevations = points.map((point) => point.z);
	return {
		baseDecimeters: elevations.length ? Math.min(...elevations) : 0,
		anchorX: xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0,
		anchorY: ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0,
		hasBounds: false
	};
}


function getFeatureSurfaceGroups(groups) {
	return getFeatureMetadata(groups).hasBounds ? groups.slice(1) : groups;
}


function featureGeometrySignature(groups) {
	let hash = 0x811c9dc5;
	const update = (value) => {
		let number = Number(value);
		if (!Number.isFinite(number)) number = 0;
		number |= 0;
		for (let shift = 0; shift < 32; shift += 8) {
			hash ^= (number >>> shift) & 0xff;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
	};

	update(groups?.length || 0);
	for (const group of groups || []) {
		update(0x475250);
		update(group?.length || 0);
		for (const ring of group || []) {
			update(0x52494e47);
			const points = openPath(ring);
			update(points.length);
			for (const point of points) {
				update(point.x);
				update(point.y);
				update(point.z);
			}
		}
	}
	return hash.toString(16).padStart(8, "0");
}


function getTileGroundMetersPerRenderUnit(tileCoordinate) {
	const latitude = tileCenterLngLat(tileCoordinate).lat * Math.PI / 180;
	const projectedTileWidth = EARTH_CIRCUMFERENCE_METERS / Math.pow(2, tileCoordinate.z);
	return projectedTileWidth * Math.cos(latitude) / RENDER_EXTENT;
}


function getMetricSurfaceNormal(surface, xyMetersPerRenderUnit) {
	const contour = openPath(normalizeSurfaceRings(surface)[0] || []);
	if (contour.length < 3) return null;

	return normalizedNewellNormal(contour.map((point) => ({
		x: point.x * xyMetersPerRenderUnit,
		y: point.y * xyMetersPerRenderUnit,
		z: point.z / 10
	})));
}


function getSurfaceKind(surfaceNormal) {
	const upNormal = Math.abs(Number(surfaceNormal?.z) || 0);
	if (upNormal < ROOF_MIN_UP_NORMAL) return "wall";
	return upNormal >= FLAT_ROOF_MIN_UP_NORMAL ? "flat-roof" : "pitched-roof";
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


function buildTileGeometry(
	arrayBuffer,
	tileCoordinate,
	runtime,
	{ excludedFeatureSignatures = [] } = {}
) {
	const { THREE, VectorTile, Protobuf } = runtime;
	const tile = new VectorTile(new Protobuf(new Uint8Array(arrayBuffer)));
	const layer = tile.layers?.buildings3d;
	if (!layer?.length) return null;

	const extent = Number(layer.extent) || SOURCE_EXTENT;
	const renderUnitsPerExtentUnit = RENDER_EXTENT / extent;
	const xyMetersPerRenderUnit = getTileGroundMetersPerRenderUnit(tileCoordinate);
	const positions = [];
	const normals = [];
	const colors = [];
	const indices = [];
	const relativeHeights = [];
	const groundRanges = [];
	const fallbackMaskPoints = [];
	const fallbackMaskTilePoints = [];
	const fallbackMaskTilePointKeys = new Set();
	const surfaceColors = Object.fromEntries(Object.entries(ACTIVE_BUILDING_STYLE.colors)
		.map(([kind, color]) => [
			kind,
			colorBytes(color, THREE, ACTIVE_BUILDING_STYLE.material === "lambert")
		]));
	const excludedSignatures = new Set(
		excludedFeatureSignatures
			.map((value) => String(value || "").trim().toLowerCase())
			.filter(Boolean)
	);

	for (let featureIndex = 0; featureIndex < layer.length; featureIndex += 1) {
		const feature = layer.feature(featureIndex);
		const groups = decodeFeatureGeometry3D(feature);
		if (!groups.length) continue;
		if (
			excludedSignatures.size
			&& excludedSignatures.has(featureGeometrySignature(groups))
		) continue;

		const metadata = getFeatureMetadata(groups);
		const vertexStart = positions.length / 3;

		for (const surface of getFeatureSurfaceGroups(groups)) {
			const renderSurface = surface.map((ring) => ring.map((point) => ({
				x: point.x * renderUnitsPerExtentUnit,
				y: point.y * renderUnitsPerExtentUnit,
				z: point.z - metadata.baseDecimeters
			})));

			const triangulated = triangulateSurfaceIndices3D(renderSurface, THREE);
			if (!triangulated) continue;
			const surfaceNormal = getMetricSurfaceNormal(renderSurface, xyMetersPerRenderUnit);
			if (!surfaceNormal) continue;
			const surfaceKind = getSurfaceKind(surfaceNormal);
			const [red, green, blue] = surfaceColors[surfaceKind];

			// Ein LOD2-Feature kann mehrere OGD-Baukoerperteile ueberdecken.
			// Deshalb verwenden wir je nicht-vertikaler LOD2-Flaeche einen
			// sicheren Innenpunkt statt nur einen Punkt fuer das ganze Feature.
			// Damit lassen sich alle betroffenen OGD-Features eindeutig finden.
			if (surfaceKind !== "wall") {
				const firstTriangle = triangulated.triangles[0];
				if (firstTriangle?.length === 3) {
					const trianglePoints = firstTriangle.map((index) => triangulated.vertices[index]);
					const fallbackMaskPoint = {
						x: trianglePoints.reduce((sum, point) => sum + point.x, 0) / 3,
						y: trianglePoints.reduce((sum, point) => sum + point.y, 0) / 3
					};
					const pointKey = `${fallbackMaskPoint.x.toFixed(3)}:${fallbackMaskPoint.y.toFixed(3)}`;
					if (!fallbackMaskTilePointKeys.has(pointKey)) {
						fallbackMaskTilePointKeys.add(pointKey);
						fallbackMaskTilePoints.push(fallbackMaskPoint);
						const point = tilePointLngLat(
							tileCoordinate,
							fallbackMaskPoint.x / RENDER_EXTENT,
							fallbackMaskPoint.y / RENDER_EXTENT
						);
						if (Number.isFinite(point.lng) && Number.isFinite(point.lat)) {
							fallbackMaskPoints.push([point.lng, point.lat]);
						}
					}
				}
			}

			const vertexOffset = positions.length / 3;
			for (const point of triangulated.vertices) {
				const heightMeters = point.z / 10;
				positions.push(point.x, point.y, heightMeters);
				normals.push(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z);
				colors.push(red, green, blue);
				relativeHeights.push(heightMeters);
			}
			for (const triangle of triangulated.triangles) {
				indices.push(...triangle.map((index) => vertexOffset + index));
			}
		}

		const vertexCount = positions.length / 3 - vertexStart;
		if (vertexCount > 0) {
			const anchor = tilePointLngLat(
				tileCoordinate,
				metadata.anchorX / extent,
				metadata.anchorY / extent
			);
			groundRanges.push({
				start: vertexStart,
				count: vertexCount,
				key: `${metadata.anchorX}:${metadata.anchorY}`,
				lng: anchor.lng,
				lat: anchor.lat,
				lastTerrainSignature: "",
				lastElevation: 0
			});
		}
	}

	if (!positions.length) return null;

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
	geometry.setAttribute("color", new THREE.Uint8BufferAttribute(colors, 3, true));
	geometry.setIndex(indices);
	geometry.userData.ksRelativeHeights = Float32Array.from(relativeHeights);
	geometry.userData.ksGroundRanges = groundRanges;
	geometry.userData.ksFallbackMaskPoints = fallbackMaskPoints;
	geometry.userData.ksFallbackMaskTilePoints = fallbackMaskTilePoints;
	geometry.userData.ksMaptoolkitExcludedFeatureSignatures =
		[...excludedSignatures].sort();
	geometry.userData.ksVertexCount = positions.length / 3;

	return geometry;
}


export {
	decodeFeatureGeometry3D as decodeWienMaptoolkitFeatureGeometry3D,
	featureGeometrySignature as wienMaptoolkitFeatureGeometrySignature,
	getFeatureMetadata as getWienMaptoolkitFeatureMetadata,
	triangulateSurfaceIndices3D as triangulateWienMaptoolkitSurface,
	buildTileGeometry as buildWienMaptoolkitTileGeometry
};
