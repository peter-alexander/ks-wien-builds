import {
	decodeWienMaptoolkitFeatureGeometry3D,
	wienMaptoolkitFeatureGeometrySignature
} from "./wien-maptoolkit-geometry.js";

const ROOF_REPLACEMENT_MODES = new Set([
	"maptoolkit-roof-replacement",
	"maptoolkit-roof-replacement-pilot"
]);

function unique(values) {
	return [...new Set((values || []).map((v) => String(v ?? "").trim()).filter(Boolean))].sort();
}

function tileKey(value) {
	if (typeof value === "string") return value;
	return `${value?.z}/${value?.x}/${value?.y}`;
}

function validTile(key) {
	const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
	if (!match) return false;
	const [z, x, y] = match.slice(1).map(Number);
	return z === 15 && x >= 0 && x < 2 ** z && y >= 0 && y < 2 ** z;
}

/** Interpret the production manifest without guessing replacements by building ID. */
export function normalizeWienRoofReplacementTargets(release) {
	const normalized = [];
	for (const raw of release?.maptoolkitRoofOverrides?.targets || []) {
		const historicalCode = String(raw?.historicalCode || "").trim();
		const replacementTile = String(raw?.tile || "").trim();
		const sources = Array.isArray(raw?.featureTiles)
			? raw.featureTiles
			: [{ tile: replacementTile, featureSignatures: raw?.featureSignatures }];
		if (!historicalCode || !validTile(replacementTile) || !sources.length) continue;
		const featureTiles = [];
		let valid = true;
		const seen = new Set();
		for (const source of sources) {
			const key = String(source?.tile || "").trim();
			const signatures = unique(source?.featureSignatures)
				.map((value) => value.toLowerCase());
			if (!validTile(key) || !signatures.length
				|| signatures.some((value) => !/^[0-9a-f]{8}$/.test(value))
				|| seen.has(key)) {
				valid = false;
				break;
			}
			seen.add(key);
			featureTiles.push({ tile: key, featureSignatures: signatures });
		}
		if (!valid || !seen.has(replacementTile)) continue;
		normalized.push({
			historicalCode,
			replacementTile,
			bwGebId: String(raw.bwGebId ?? "").trim(),
			ogdKsIds: unique(raw.ogdKsIds),
			featureTiles
		});
	}
	return normalized;
}

/** Count signatures, not just their presence: collisions must fail closed. */
export function countWienMaptoolkitSignatures(buffer, runtime) {
	if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) return null;
	const { VectorTile, Protobuf } = runtime || {};
	if (typeof VectorTile !== "function" || typeof Protobuf !== "function") {
		throw new TypeError("VectorTile and Protobuf readers required.");
	}
	const tile = new VectorTile(new Protobuf(new Uint8Array(buffer)));
	const layer = tile.layers?.buildings3d;
	const counts = new Map();
	if (!layer) return counts;
	for (let i = 0; i < layer.length; i++) {
		const geometry = decodeWienMaptoolkitFeatureGeometry3D(layer.feature(i));
		if (!geometry.length) continue;
		const fingerprint = wienMaptoolkitFeatureGeometrySignature(geometry);
		counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
	}
	return counts;
}

/**
 * Validate a complete, atomic replacement proposal for one LOD2.1 tile.
 *
 * All Maptoolkit tiles referenced by a cross-tile override must be available
 * and every signature must occur exactly once. Missing or changed geometry
 * leaves the original roof intact. The result is only a *candidate plan*:
 * the caller must first build the replacement mesh successfully and then
 * publish all affected tile exclusions together.
 */
export function planWienRoofReplacements({
	release,
	lod21TileData,
	replacementTile,
	buffersByTile,
	runtime
} = {}) {
	const key = tileKey(replacementTile);
	if (!validTile(key)) throw new RangeError("Invalid Wiener replacement tile.");
	const available = new Set(
		(lod21TileData?.metadata?.buildings || [])
			.filter((b) => ROOF_REPLACEMENT_MODES.has(String(b?.rolloutMode || "")))
			.map((b) => String(b.historicalCode || "").trim())
			.filter(Boolean)
	);
	const plan = {
		historicalCodes: [],
		exclusionsByTile: new Map(),
		ogdKsIds: []
	};
	if (!available.size) return plan;

	const candidates = normalizeWienRoofReplacementTargets(release)
		.filter((target) => target.replacementTile === key
			&& available.has(target.historicalCode));
	const countsByTile = new Map();
	const getCounts = (tileId) => {
		if (countsByTile.has(tileId)) return countsByTile.get(tileId);
		const buffer = buffersByTile?.get?.(tileId);
		const value = countWienMaptoolkitSignatures(buffer, runtime);
		countsByTile.set(tileId, value);
		return value;
	};
	const reserved = new Map();
	for (const target of candidates) {
		const allExact = target.featureTiles.every((featureTile) => {
			const counts = getCounts(featureTile.tile);
			if (!counts) return false;
			return featureTile.featureSignatures.every((signature) => (
				counts.get(signature) === 1
				&& !reserved.get(featureTile.tile)?.has(signature)
			));
		});
		if (!allExact) continue;
		plan.historicalCodes.push(target.historicalCode);
		plan.ogdKsIds.push(...target.ogdKsIds);
		for (const featureTile of target.featureTiles) {
			const set = reserved.get(featureTile.tile) || new Set();
			for (const signature of featureTile.featureSignatures) set.add(signature);
			reserved.set(featureTile.tile, set);
		}
	}
	plan.historicalCodes = unique(plan.historicalCodes);
	plan.ogdKsIds = unique(plan.ogdKsIds);
	plan.exclusionsByTile = new Map(
		[...reserved].map(([tileId, signatures]) => [tileId, [...signatures].sort()])
	);
	return plan;
}

/**
 * Exact FMZK parts to suppress only after the corresponding LOD2.1 mesh
 * has been built. A BW_GEB_ID alone must never remove unrelated extensions.
 */
export function getWienLod21CoveredOgdKsIds(
	tileData,
	{ activeRoofReplacementCodes = [], excludedBuildingIds = [] } = {}
) {
	const active = new Set(unique(activeRoofReplacementCodes));
	const excluded = new Set(unique(excludedBuildingIds));
	return unique((tileData?.metadata?.buildings || [])
		.filter((building) => {
			if (excluded.has(String(building?.bwGebId ?? "").trim())) return false;
			if (!ROOF_REPLACEMENT_MODES.has(String(building?.rolloutMode || ""))) return true;
			return active.has(String(building.historicalCode || "").trim());
		})
		.flatMap((building) => building.ogdKsIds || []));
}
