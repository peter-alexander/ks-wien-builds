#!/usr/bin/env node
/**
 * Find current FMZK buildings with geometrically matching real pitched roofs
 * in the ORIGINAL Vienna CityGML source (not the small Maptoolkit fallback).
 *
 * All tests are made in the original EPSG:31256 metre coordinate system.
 * Excludes duplicate/ambiguous BEZUG codes and outdated footprints.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import {
	buildingXmlMatches,
	extractFirstLocalTagText,
	parseBuildingFragment,
	parseSemanticSurfaces,
	groundGeometryFromSurfaces,
	getSurfacePoints,
	sourcePointToLngLat,
	unionJstsGeometries,
	intersectionJstsGeometry
} from "../wien-lod21/build.mjs";
import { BASE, makePilotKeys } from "./build.mjs";

const EPSG = "EPSG:31256";
const REPO_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const DEFAULT_SOURCE = path.join(REPO_DIR, "build", "source");
const DEFAULT_TARGETS = path.join(REPO_DIR, "build", "roof-targets.json");
const DEFAULT_AUDIT = path.join(REPO_DIR, "build", "roof-matching-audit.json");
const MIN_COVERAGE = 0.965;
const MIN_IOU = 0.94;
const MIN_PITCHED_RELIEF_M = 0.35;

export function normalizeCode(value) {
	if (value === null || value === undefined || value === "") return "";
	const code = String(value).trim();
	return /^\d{1,6}$/.test(code) ? code.padStart(6, "0") : "";
}

function convertCoordinates(coordinates) {
	if (!Array.isArray(coordinates)) throw new Error("Invalid current FMZK polygon");
	if (typeof coordinates[0] === "number") {
		const [x, y] = proj4("EPSG:4326", EPSG, coordinates.slice(0, 2));
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Projection failure");
		return [x, y];
	}
	return coordinates.map(convertCoordinates);
}

function toSourceGeometry(geojson) {
	if (!["Polygon", "MultiPolygon"].includes(geojson?.type)) return null;
	return { type: geojson.type, coordinates: convertCoordinates(geojson.coordinates) };
}

export function reliefOfRoof(surfaces) {
	return (surfaces || []).filter(s => s.semantic === "roof")
		.reduce((max, surface) => {
			const zs = surface.rings.flatMap(r => r.map(p => p.z));
			return zs.length ? Math.max(max, Math.max(...zs) - Math.min(...zs)) : max;
		}, 0);
}

function sourceBounds(geometry) {
	const envelope = geometry.getEnvelopeInternal?.();
	return envelope && [envelope.getMinX(), envelope.getMinY(), envelope.getMaxX(), envelope.getMaxY()].every(Number.isFinite)
		? [envelope.getMinX(), envelope.getMinY(), envelope.getMaxX(), envelope.getMaxY()]
		: null;
}

export function uniqueInteriorTile(geometry, marginFraction = 0.01) {
	const bbox = sourceBounds(geometry);
	if (!bbox) return null;
	const n = 2 ** 15;
	const coords = [[bbox[0],bbox[1]],[bbox[0],bbox[3]],[bbox[2],bbox[1]],[bbox[2],bbox[3]]];
	let tileX = null, tileY = null;
	for (const xy of coords) {
		const [lng, lat] = proj4(EPSG, "EPSG:4326", xy);
		const wx = (lng + 180) / 360 * n;
		const wy = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
		const x = Math.floor(wx), y = Math.floor(wy);
		if (wx - x < marginFraction || wx - x > 1 - marginFraction
			|| wy - y < marginFraction || wy - y > 1 - marginFraction
			|| tileX !== null && (x !== tileX || y !== tileY)) return null;
		tileX = x;
		tileY = y;
	}
	return "15/" + tileX + "/" + tileY;
}

export function evaluateRoofMatch({ current, historical, currentHeight, pitchedRelief }) {
	if (!current || !historical || current.isEmpty() || historical.isEmpty()) {
		return { accept: false, reason: "missing-footprint" };
	}
	if (!(pitchedRelief > MIN_PITCHED_RELIEF_M)) {
		return { accept: false, reason: "no-pitched-roof" };
	}
	const a = current.getArea();
	const b = historical.getArea();
	if (!(a > 3 && b > 3)) return { accept: false, reason: "tiny-footprint" };
	let overlap;
	try {
		overlap = intersectionJstsGeometry(current, historical, "native-roof-match")?.getArea();
	} catch {
		return { accept: false, reason: "invalid-intersection" };
	}
	const coverCurrent = overlap / a;
	const coverHistorical = overlap / b;
	const unionArea = a + b - overlap;
	const iou = overlap / unionArea;
	if (coverCurrent < MIN_COVERAGE || coverHistorical < MIN_COVERAGE || iou < MIN_IOU) {
		return { accept: false, reason: "outdated-footprint", metrics: { coverCurrent, coverHistorical, iou } };
	}
	// A roof may rise above the OGD flat-roof estimate by several metres.
	// We never infer a construction base offset from the old absolute datum.
	if (!(currentHeight > 1 && currentHeight < 350)) {
		return { accept: false, reason: "invalid-current-height" };
	}
	return {
		accept: true,
		reason: "matches",
		metrics: {
			coverCurrent: Number(coverCurrent.toFixed(5)),
			coverHistorical: Number(coverHistorical.toFixed(5)),
			iou: Number(iou.toFixed(5)),
			currentArea: Number(a.toFixed(2)),
			historicalArea: Number(b.toFixed(2))
		}
	};
}

async function request(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Source HTTP ${response.status}: ${url}`);
	return response.arrayBuffer();
}

function noteGroup(groups, code, id, ksId, geometry, height, point) {
	let group = groups.get(code);
	if (!group) {
		group = { code, buildingIds: new Set(), ksIds: new Set(), geometries: [], heights: [], points: [] };
		groups.set(code, group);
	}
	group.buildingIds.add(id);
	if (ksId) group.ksIds.add(ksId);
	group.geometries.push(geometry);
	group.heights.push(height);
	group.points.push(point);
}

export async function collectCurrentGroups({
	keys = makePilotKeys(),
	fetchData = request
} = {}) {
	const reader = new GeoJSONReader();
	const groups = new Map();
	const seen = new Set();
	for (const key of keys) {
		const [z, x, y] = key.split("/").map(Number);
		const raw = new Uint8Array(await fetchData(`${BASE}/LOD1/tiles/${key}.pbf`));
		const tile = new VectorTile(new PbfReader(raw));
		const layer = tile.layers?.wien_buildings;
		if (!layer?.length) throw new Error(`FMZK source missing in ${key}`);
		for (let i = 0; i < layer.length; i++) {
			const feature = layer.feature(i);
			if (feature.type !== 3) continue;
			const props = feature.properties || {};
			const code = normalizeCode(props.BEZUG);
			const id = String(props.BW_GEB_ID ?? "");
			const ksId = String(props.KS_ID ?? "");
			if (!code || !id || !ksId) continue;
			const unique = key + ":" + ksId;
			if (seen.has(unique)) continue;
			seen.add(unique);
			const geojson = feature.toGeoJSON(x, y, z);
			const shape = toSourceGeometry(geojson.geometry);
			if (!shape) continue;
			let geometry;
			try {
				geometry = reader.read(shape);
				if (!geometry || geometry.isEmpty()) continue;
			} catch { continue; }
			const bbox = sourceBounds(geometry);
			if (!bbox) continue;
			const height = Number(props.render_height);
			if (!(height > 0 && height < 350)) continue;
			noteGroup(groups, code, id, ksId, geometry, height,
				{ x: (bbox[0] + bbox[2]) / 2, y: (bbox[1] + bbox[3]) / 2 });
		}
	}
	return groups;
}

async function listGml(dir) {
	const found = [];
	const walk = async (folder) => {
		for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
			const p = path.join(folder, entry.name);
			if (entry.isDirectory()) await walk(p);
			else if (/\.gml$/i.test(entry.name)) found.push(p);
		}
	};
	await walk(dir);
	return found.sort();
}

export async function matchCityGml({
	sourceDir = DEFAULT_SOURCE,
	targetsFile = DEFAULT_TARGETS,
	auditFile = DEFAULT_AUDIT,
	groups = null
} = {}) {
	const reader = new GeoJSONReader();
	const current = groups || await collectCurrentGroups();
	const files = await listGml(sourceDir);
	if (!files.length) throw new Error("No original CityGML source sheets downloaded");
	const historical = new Map();
	const visited = new Set();
	const sourceSheetsByCode = new Map();
	let parsedObjects = 0;
	for (const file of files) {
		const xml = await fs.readFile(file, "utf8");
		const sheet = path.basename(file, path.extname(file));
		if (!/^[0-9]{6}$/.test(sheet)) throw new Error("Unexpected original CityGML sheet file name: " + file);
		let used = 0;
		for (const fragment of buildingXmlMatches(xml)) {
			const code = normalizeCode(extractFirstLocalTagText(fragment, "name"));
			if (!current.has(code)) continue;
			if (!sourceSheetsByCode.has(code)) sourceSheetsByCode.set(code, new Set());
			sourceSheetsByCode.get(code).add(sheet);
			const building = parseBuildingFragment(fragment, file);
			if (!building) continue;
			const cityId = building.getAttributeNS("http://www.opengis.net/gml", "id")
				|| building.getAttribute("gml:id") || "";
			if (cityId && visited.has(cityId)) continue;
			if (cityId) visited.add(cityId);
			const surfaces = parseSemanticSurfaces(building);
			const ground = groundGeometryFromSurfaces(surfaces, reader);
			if (!ground || ground.isEmpty()) continue;
			const points = getSurfacePoints(surfaces);
			const roofZs = surfaces.filter(s => s.semantic === "roof")
				.flatMap(s => s.rings.flatMap(r => r.map(p => p.z)));
			const groundZs = surfaces.filter(s => s.semantic === "ground")
				.flatMap(s => s.rings.flatMap(r => r.map(p => p.z)));
			if (!points.length || !roofZs.length || !groundZs.length) continue;
			const entry = historical.get(code) || { footprints: [], sourceCount: 0, pitch: 0, sourceHeight: 0 };
			entry.footprints.push(ground);
			entry.pitch = Math.max(entry.pitch, reliefOfRoof(surfaces));
			entry.sourceHeight = Math.max(entry.sourceHeight,
				Math.max(...roofZs) - Math.min(...groundZs));
			entry.sourceCount++;
			historical.set(code, entry);
			used++;
			parsedObjects++;
		}
		console.log(`Scanned ${path.basename(file)}: ${used} candidate objects`);
	}
	const targets = [];
	const reasons = {};
	const diagnostics = [];
	for (const [code, group] of current) {
		let reason = "no-original-roof";
		try {
			if (group.buildingIds.size !== 1) {
				reason = "ambiguous-current-identity";
			} else {
				const old = historical.get(code);
				if (old) {
					const currentShape = unionJstsGeometries(group.geometries);
					const historicalShape = unionJstsGeometries(old.footprints);
					const avgHeight = group.heights.reduce((a, b) => a + b, 0) / group.heights.length;
					const currentTile = uniqueInteriorTile(currentShape);
					const historicalTile = uniqueInteriorTile(historicalShape);
					if (!currentTile || currentTile !== historicalTile) {
						reason = "tile-crossing-or-border";
						reasons[reason] = (reasons[reason] || 0) + 1;
						diagnostics.push({ code, reason, currentTile, historicalTile });
						continue;
					}
					const match = evaluateRoofMatch({
						current: currentShape,
						historical: historicalShape,
						currentHeight: avgHeight,
						pitchedRelief: old.pitch
					});
					reason = match.reason;
					if (match.accept) {
						const lnglat = sourcePointToLngLat({
							x: group.points.reduce((a,p)=>a+p.x,0)/group.points.length,
							y: group.points.reduce((a,p)=>a+p.y,0)/group.points.length,
							z: 0
						});
						targets.push({
							name: "Vienna native roof " + code,
							historicalCode: code,
							sourceSheets: [...sourceSheetsByCode.get(code)].sort(),
							bwGebId: Number([...group.buildingIds][0]),
							ksIds: [...group.ksIds].sort(),
							lng: lnglat.lng,
							lat: lnglat.lat,
							rolloutMode: "direct-strong",
							roofCoverageAudit: {
								...match.metrics,
								sourceRoofReliefM: Number(old.pitch.toFixed(2)),
								sourceHeightM: Number(old.sourceHeight.toFixed(2)),
								currentHeightM: Number(avgHeight.toFixed(2))
							}
						});
					}
					diagnostics.push({ code, sourceCount: old.sourceCount, reason, ...match.metrics });
				}
			}
		} catch (error) {
			reason = "matching-error";
			diagnostics.push({ code, reason, error: String(error).slice(0, 300) });
		}
		reasons[reason] = (reasons[reason] || 0) + 1;
	}
	if (targets.length < 10 || targets.length > 5000) {
		throw new Error(`Suspicious original-roof match count: ${targets.length}; audit before building`);
	}
	targets.sort((a,b)=>a.historicalCode.localeCompare(b.historicalCode));
	await fs.mkdir(path.dirname(targetsFile), { recursive: true });
	await fs.writeFile(targetsFile, JSON.stringify({
		schemaVersion: 1, status: "native-roofs-pilot", zoom: 15, extent: 8192,
		buildings: targets
	}, null, "\t") + "\n");
	await fs.writeFile(auditFile, JSON.stringify({
		sourceSheetCount: files.length,
		cityGmlObjects: parsedObjects,
		currentCodes: current.size,
		matchedCodes: targets.length,
		decisionCounts: reasons,
		diagnostics
	}, null, "\t") + "\n");
	console.log(`Original CityGML matched: ${targets.length} codes in ${files.length} sheets`, reasons);
	return { targets, reasons, parsedObjects };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	matchCityGml().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
