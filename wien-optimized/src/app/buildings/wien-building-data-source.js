// Data access for the former WienLOD2Buildings renderer. No map or WebGL side effects.
export const WIEN_BUILDING_SOURCES = Object.freeze({
	// Vienna's published buildings TileJSON still advertises .pbf.
	maptoolkit: "https://mtk.wien.gv.at/dataconnector/wien/buildings3d/{z}/{x}/{y}.pbf",
	maptoolkitLegacy: "https://mtk.wien.gv.at/dataconnector/wien/buildings3d/{z}/{x}/{y}.mvt",
	lod21Release: "https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD21/release.json",
	lod21Ownership: "https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD21/ownership-z15.json",
	lod21Tiles: "https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD21/tiles/{z}/{x}/{y}.bin",
	lod21z14Release: "https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD21/release-z14.json",
	lod21z14Tiles: "https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD21/tiles/{z}/{x}/{y}.bin",
	lod1Release: "https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD1/release.json",
	lod1FeatureCoverage: "https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD1/feature-coverage-z15.json",
	lod1Tiles: "https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD1/tiles/{z}/{x}/{y}.pbf"
});

const SOURCE_ZOOM = 15;
const LOD21_MAGIC = "KSL21B01";
const LOD21_VERSION = 1;
const LOD21_EXTENT = 8192;

export function validateWienLod21Release(release, zoom = SOURCE_ZOOM) {
	if (release?.binary?.magic !== LOD21_MAGIC
		|| release?.binary?.version !== LOD21_VERSION
		|| release?.binary?.zoom !== zoom
		|| release?.binary?.extent !== LOD21_EXTENT) {
		throw new Error("Incompatible Wien LOD2.1 binary release.");
	}
	return release;
}

export function validateWienLod1Release(release) {
	const layer = release?.vectorTiles;
	if (layer?.layer !== "wien_buildings"
		|| !Number.isInteger(layer.minzoom)
		|| !Number.isInteger(layer.maxzoom)
		|| layer.minzoom > SOURCE_ZOOM
		|| layer.maxzoom < SOURCE_ZOOM) {
		throw new Error("Incompatible Wien LOD1 release.");
	}
	return release;
}

export function wienBuildingTileUrl(template, tile, {
	minZoom = SOURCE_ZOOM,
	maxZoom = SOURCE_ZOOM
} = {}) {
	const { z, x, y } = tile || {};
	if (![z, x, y].every(Number.isInteger)
		|| z < minZoom || z > maxZoom || x < 0 || y < 0
		|| x >= 2 ** z || y >= 2 ** z) {
		throw new RangeError("Invalid Wien building tile coordinates.");
	}
	return template.replace("{z}", String(z))
		.replace("{x}", String(x)).replace("{y}", String(y));
}

/**
 * Validate the optional build-generated candidate index. It is not a native
 * Stadtplan identity crosswalk and cannot by itself authorize hiding layers.
 */
export function validateWienOwnershipIndex(index, release) {
	if (index?.schemaVersion !== 1 || index?.zoom !== 15
		|| index?.nativeStadtplanIdsVerified !== false
		|| index?.generatedAt !== release?.generatedAt
		|| !index.tiles || typeof index.tiles !== "object"
		|| Array.isArray(index.tiles)) {
		throw new Error("Incompatible Vienna building ownership index.");
	}
	const available = new Set(release?.tiles?.presentTilesZ15 || []);
	for (const [key, buildings] of Object.entries(index.tiles)) {
		if (!/^15\/\d+\/\d+$/.test(key) || !available.has(key)
			|| !Array.isArray(buildings)) {
			throw new Error("Invalid Vienna ownership tile.");
		}
		for (const building of buildings) {
			if (!String(building?.historicalCode || "").trim()
				|| !Array.isArray(building.ogdKsIds)
				|| !building.ogdKsIds.every((id) => typeof id === "string" && id.length > 0)
				|| typeof building.fingerprintGuarded !== "boolean") {
				throw new Error("Invalid Vienna ownership building.");
			}
		}
	}
	return index;
}

export function createWienBuildingDataSource({
	fetchImpl = globalThis.fetch,
	urls = WIEN_BUILDING_SOURCES
} = {}) {
	if (typeof fetchImpl !== "function") throw new TypeError("fetch is required.");
	const releases = new Map();
	let ownershipPromise = null;
	let coveragePromise = null;
	const controllers = new Set();
	let destroyed = false;

	async function request(url, signal, asJson, { allowNotFound = false } = {}) {
		if (destroyed) throw new Error("Wien building source destroyed.");
		const controller = new AbortController();
		controllers.add(controller);
		const onAbort = () => controller.abort();
		signal?.addEventListener?.("abort", onAbort, { once: true });
		if (signal?.aborted) controller.abort();
		try {
			const response = await fetchImpl(url, {
				signal: controller.signal,
				credentials: "omit",
				mode: "cors"
			});
			if (allowNotFound && response?.status === 404) return null;
			if (!response?.ok) {
				const error = new Error(`Wien building source HTTP ${response?.status || 0}: ${url}`);
				error.status = Number(response?.status) || 0;
				throw error;
			}
			return asJson ? await response.json() : await response.arrayBuffer();
		} finally {
			signal?.removeEventListener?.("abort", onAbort);
			controllers.delete(controller);
		}
	}

	async function release(kind, { signal } = {}) {
		if (destroyed) throw new Error("Wien building source destroyed.");
		if (!["lod21", "lod21z14", "lod1"].includes(kind)) throw new RangeError("Unknown Wien release.");
		if (releases.has(kind)) return releases.get(kind);
		// The optional Z14 roof release may not have been published yet.
		// Until then keep the existing coarse Z14 layer unchanged.
		const value = await request(urls[kind + "Release"], signal, true, {
			allowNotFound: kind === "lod21z14"
		});
		if (value === null) {
			releases.set(kind, null);
			return null;
		}
		const validated = kind === "lod21"
			? validateWienLod21Release(value)
			: kind === "lod21z14"
				? validateWienLod21Release(value, 14)
				: validateWienLod1Release(value);
		if (!destroyed) releases.set(kind, validated);
		return validated;
	}

	async function ownershipIndex({ signal } = {}) {
		if (destroyed) throw new Error("Wien building source destroyed.");
		if (ownershipPromise) return ownershipPromise;
		ownershipPromise = (async () => {
			const lod21Release = await release("lod21", { signal });
			if (lod21Release?.ownership?.schemaVersion !== 1
				|| lod21Release?.ownership?.nativeStadtplanIdsVerified !== false) return null;
			const raw = await request(urls.lod21Ownership, signal, true);
			return validateWienOwnershipIndex(raw, lod21Release);
		})();
		try {
			return await ownershipPromise;
		} catch (error) {
			ownershipPromise = null;
			throw error;
		}
	}

	async function featureCoverage({ signal } = {}) {
		if (coveragePromise) return coveragePromise;
		coveragePromise = (async () => {
			const lod1 = await release("lod1", { signal });
			if (lod1?.vectorTiles?.featureCoverageZ15?.schemaVersion !== 1) return null;
			const data = await request(urls.lod1FeatureCoverage, signal, true, { allowNotFound: true });
			if (!data || data.schemaVersion !== 1 || data.zoom !== 15
				|| !data.features || typeof data.features !== "object"
				|| Array.isArray(data.features)) return null;
			return data;
		})();
		try {
			return await coveragePromise;
		} catch (error) {
			coveragePromise = null;
			throw error;
		}
	}

	async function tile(kind, coordinates, { signal } = {}) {
		if (!["maptoolkit", "lod21", "lod21z14", "lod1"].includes(kind)) {
			throw new RangeError("Unknown Wien tile source.");
		}
		if (kind !== "maptoolkit") {
			const metadata = await release(kind, { signal });
			// Production manifests list their actual Z15 tiles. Avoid predictable
			// 404 requests and distinguish absent buildings from network errors.
			if (metadata === null) return null;
			const present = kind === "lod21z14"
				? metadata?.tiles?.presentTilesZ14
				: coordinates?.z === SOURCE_ZOOM
					? (kind === "lod21"
						? metadata?.tiles?.presentTilesZ15
						: metadata?.vectorTiles?.presentTilesZ15)
					: null;
			const key = `${coordinates.z}/${coordinates.x}/${coordinates.y}`;
			if (Array.isArray(present) && !present.includes(key)) return null;
			if (kind === "lod1"
				&& (coordinates.z < metadata.vectorTiles.minzoom
					|| coordinates.z > metadata.vectorTiles.maxzoom)) {
				throw new RangeError("Wien LOD1 tile zoom outside published range.");
			}
		}
		const template = kind === "maptoolkit"
			? urls.maptoolkit
			: urls[kind + "Tiles"];
		if (typeof template !== "string" || !template) {
			throw new TypeError(`Missing Wien ${kind} tile URL template.`);
		}
		const url = wienBuildingTileUrl(template, coordinates, kind === "lod1"
			? { minZoom: 13, maxZoom: SOURCE_ZOOM }
			: kind === "lod21z14"
				? { minZoom: 14, maxZoom: 14 }
				: undefined);
		if (kind !== "maptoolkit") {
			return request(url, signal, false, {
				allowNotFound: kind === "lod1" && coordinates.z < SOURCE_ZOOM
			});
		}

		// Use the Vienna-specific published TileJSON (.pbf) by default.
		// Modern Maptoolkit tile endpoints may use .mvt instead.
		// Retry only format/path failures,
		// never transient 5xx errors, CORS failures or aborted requests.
		try {
			return await request(url, signal, false);
		} catch (error) {
			if (![400, 404].includes(error?.status)) throw error;
			if (!urls.maptoolkitLegacy || urls.maptoolkitLegacy === template) {
				if (error.status === 404) return null;
				throw error;
			}
			const legacyUrl = wienBuildingTileUrl(
				urls.maptoolkitLegacy, coordinates
			);
			return request(legacyUrl, signal, false, { allowNotFound: true });
		}
	}

	return Object.freeze({
		release,
		ownershipIndex,
		featureCoverage,
		tile,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			for (const controller of controllers) controller.abort();
			controllers.clear();
			releases.clear();
		}
	});
}
