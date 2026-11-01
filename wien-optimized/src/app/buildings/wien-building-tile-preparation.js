import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import * as THREE from "three";
import { parseWienLod21Tile, decodeWienLod21MeshData,
	createWienLod21ThreeGeometry } from "./wien-lod21-geometry.js";
import { buildWienMaptoolkitTileGeometry } from "./wien-maptoolkit-geometry.js";
import { buildWienOgdFallbackTileGeometry } from "./wien-ogd-fallback-geometry.js";
import { getWienLod21CoveredOgdKsIds,
	planWienRoofReplacements } from "./wien-roof-replacement-plan.js";

/**
 * Prepare one Wiener building tile without touching the MapLibre style.
 *
 * Maptoolkit LOD2 is primary; the audited historical LOD2.1 and OGD LOD1
 * fill only missing buildings/parts. Cross-tile roof overrides are NOT
 * activated here: they need a viewport-level atomic commit in the future
 * renderer. All returned BufferGeometry instances belong to the caller.
 */
export async function prepareWienBuildingTile({
	tile,
	dataSource,
	signal = null,
	runtime = { THREE, VectorTile, Protobuf: PbfReader },
	logger = globalThis.console
} = {}) {
	if (typeof dataSource?.tile !== "function") {
		throw new TypeError("Wien building tile preparation requires a data source.");
	}
	const failures = [];
	// A failed Maptoolkit request must not prevent locally published
	// LOD2.1 roof geometry or the OGD LOD1 fallback from loading.
	const optionalMaptoolkit = async () => {
		try {
			return await dataSource.tile("maptoolkit", tile, { signal });
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") throw error;
			failures.push(`maptoolkit: ${String(error?.message || error)}`);
			return null;
		}
	};
	const optionalLod21 = async () => {
		try {
			return await dataSource.tile("lod21", tile, { signal });
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") throw error;
			failures.push(`lod21: ${String(error?.message || error)}`);
			return null;
		}
	};
	const optionalOgd = async () => {
		try {
			return await dataSource.tile("lod1", tile, { signal });
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") throw error;
			failures.push(`lod1: ${String(error?.message || error)}`);
			return null;
		}
	};
	const [lod2Buffer, ogdBuffer, lod21Buffer] = await Promise.all([
		optionalMaptoolkit(),
		optionalOgd(),
		optionalLod21()
	]);
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

	let lod21Data = null;
	if (lod21Buffer) {
		try {
			lod21Data = parseWienLod21Tile(lod21Buffer);
		} catch (error) {
			failures.push(`lod21: ${String(error?.message || error)}`);
		}
	}
	let roofPlan = { historicalCodes: [], exclusionsByTile: new Map(), ogdKsIds: [] };
	if (lod21Data && lod2Buffer && typeof dataSource.release === "function") {
		try {
			const release = await dataSource.release("lod21", { signal });
			const key = `${tile.z}/${tile.x}/${tile.y}`;
			// Cross-tile swaps require a central, atomic controller. Until that
			// exists, permit only manifest targets confined to this one tile.
			const singleTileRelease = {
				maptoolkitRoofOverrides: {
					targets: (release?.maptoolkitRoofOverrides?.targets || []).filter((target) => (
						target?.tile === key
						&& (!Array.isArray(target.featureTiles)
							|| (target.featureTiles.length === 1
								&& target.featureTiles[0].tile === key))
					))
				}
			};
			roofPlan = planWienRoofReplacements({
				release: singleTileRelease,
				lod21TileData: lod21Data,
				replacementTile: tile,
				buffersByTile: new Map([[key, lod2Buffer]]),
				runtime
			});
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") throw error;
			failures.push(`roof-audit: ${String(error?.message || error)}`);
		}
	}

	let lod2Geometry = null;
	let lod21Geometry = null;
	let lod1Geometry = null;
	let preliminaryGeometry = null;
	// Timing excludes downloads and release-metadata requests; captures
	// the synchronous geometry building that may block camera movement.
	const buildStarted = globalThis.performance?.now?.() ?? Date.now();
	try {
		let activeCodes = roofPlan.historicalCodes;
		const buildLod2 = (codes) => {
			const key = `${tile.z}/${tile.x}/${tile.y}`;
			const excludedFeatureSignatures = codes.length
				? roofPlan.exclusionsByTile.get(key) || []
				: [];
			if (!lod2Buffer) return null;
			try {
				return buildWienMaptoolkitTileGeometry(lod2Buffer, tile, runtime, {
					excludedFeatureSignatures
				});
			} catch (error) {
				// Invalid proprietary MVT geometry must not prevent the
				// independent historical roofs from being displayed.
				failures.push(`maptoolkit-mesh: ${String(error?.message || error)}`);
				return null;
			}
		};
		const buildLod21 = (codes, blockedBuildingIds) => {
			if (!lod21Data) return null;
			const mesh = decodeWienLod21MeshData(lod21Data, tile, {
				excludedBuildingIds: blockedBuildingIds,
				activeRoofReplacementCodes: codes
			});
			return createWienLod21ThreeGeometry(mesh, runtime.THREE);
		};
		const buildFallback = (mask, coveredIds) =>
			buildWienOgdFallbackTileGeometry(
				ogdBuffer, tile, runtime, mask, coveredIds
			);

		lod2Geometry = buildLod2(activeCodes);
		let preliminary = buildFallback(
			lod2Geometry?.userData?.ksFallbackMaskTilePoints || [], []
		);
		preliminaryGeometry = preliminary.geometry;
		try {
			lod21Geometry = buildLod21(
				activeCodes, preliminary.lod2ExcludedBuildingIds
			);
		} catch (error) {
			failures.push(`lod21-mesh: ${String(error?.message || error)}`);
		}

		const produced = new Set(lod21Geometry?.userData?.ksLOD21HistoricalCodes || []);
		// Never suppress a real Maptoolkit roof unless the matching replacement
		// has actually been constructed as a visible geometry.
		if (activeCodes.some((code) => !produced.has(code))) {
			lod21Geometry?.dispose?.();
			lod21Geometry = null;
			lod2Geometry?.dispose?.();
			lod2Geometry = buildLod2([]);
			preliminaryGeometry?.dispose?.();
			preliminaryGeometry = null;
			preliminary = buildFallback(
				lod2Geometry?.userData?.ksFallbackMaskTilePoints || [], []
			);
			preliminaryGeometry = preliminary.geometry;
			activeCodes = [];
			try {
				lod21Geometry = buildLod21([], preliminary.lod2ExcludedBuildingIds);
			} catch (error) {
				failures.push(`lod21-mesh: ${String(error?.message || error)}`);
			}
		}
		// Release temporary fallback buffers; only the final OGD geometry
		// should be kept by the renderer.
		preliminaryGeometry?.dispose?.();
		preliminaryGeometry = null;
		const coveredIds = lod21Geometry
			? getWienLod21CoveredOgdKsIds(lod21Data, {
				activeRoofReplacementCodes: activeCodes,
				excludedBuildingIds: preliminary.lod2ExcludedBuildingIds
			})
			: [];
		const fallback = buildFallback(
			lod2Geometry?.userData?.ksFallbackMaskTilePoints || [], coveredIds
		);
		lod1Geometry = fallback.geometry;
		if (failures.length) logger?.warn?.("Wien building tile degraded:", {
			tile, failures
		});
		return {
			tile,
			lod2Geometry,
			lod21Geometry,
			lod1Geometry,
			activeRoofReplacementCodes: [...activeCodes],
			excludedOgdKsIds: coveredIds,
			failures,
			mainThreadGeometryMs: (globalThis.performance?.now?.() ?? Date.now()) - buildStarted,
			dispose() {
				lod2Geometry?.dispose?.();
				lod21Geometry?.dispose?.();
				lod1Geometry?.dispose?.();
			}
		};
	} catch (error) {
		preliminaryGeometry?.dispose?.();
		lod2Geometry?.dispose?.();
		lod21Geometry?.dispose?.();
		lod1Geometry?.dispose?.();
		throw error;
	}
}

/**
 * Simplified OGD buildings for distant views. WienBuildings/LOD1 publishes
 * Z13–Z15 tiles, with feature dropping disabled at lower zooms.
 *
 * Coarse tiles deliberately do not request proprietary Maptoolkit LOD2 or
 * LOD2.1 binaries. The custom shader masks fine-ready Z15 child quadrants
 * to prevent their simplified Z14 parents from covering pitched roofs.
 */
export async function prepareWienBuildingCoarseTile({
	tile,
	dataSource,
	signal = null,
	runtime = { THREE, VectorTile, Protobuf: PbfReader },
	logger = globalThis.console
} = {}) {
	if (![13, 14].includes(tile?.z) || typeof dataSource?.tile !== "function") {
		throw new TypeError("Wien coarse building tile needs Z13/Z14 and a data source.");
	}
	const failures = [];
	const optional = async (kind) => {
		try {
			return await dataSource.tile(kind, tile, { signal });
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") throw error;
			failures.push(`${kind}: ${String(error?.message || error)}`);
			return null;
		}
	};
	const [ogdBuffer, lod21Buffer] = await Promise.all([
		optional("lod1"),
		tile.z === 14 ? optional("lod21z14") : Promise.resolve(null)
	]);
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	let lod21Geometry = null;
	let lod1Geometry = null;
	let coveredIds = [];
	const buildStartedCoarse = globalThis.performance?.now?.() ?? Date.now();
	try {
		if (lod21Buffer) {
			try {
				const decoded = parseWienLod21Tile(lod21Buffer);
				if (decoded.metadata.tile?.z !== tile.z
					|| decoded.metadata.tile?.x !== tile.x
					|| decoded.metadata.tile?.y !== tile.y) {
					throw new Error("Mismatched historical roof tile coordinates.");
				}
				const mesh = decodeWienLod21MeshData(decoded, tile);
				lod21Geometry = createWienLod21ThreeGeometry(mesh, runtime.THREE);
				if (lod21Geometry) {
					coveredIds = getWienLod21CoveredOgdKsIds(decoded);
				}
			} catch (error) {
				failures.push(`lod21z14-mesh: ${String(error?.message || error)}`);
			}
		}
		lod1Geometry = buildWienOgdFallbackTileGeometry(
			ogdBuffer, tile, runtime, [], coveredIds
		).geometry;
		if (failures.length) logger?.warn?.("Wien distant tile degraded:", {
			tile, failures
		});
		return {
			tile,
			lod2Geometry: null,
			lod21Geometry,
			lod1Geometry,
			excludedOgdKsIds: coveredIds,
			isCoarse: true,
			failures,
			mainThreadGeometryMs: (globalThis.performance?.now?.() ?? Date.now()) - buildStartedCoarse,
			dispose() {
				lod21Geometry?.dispose?.();
				lod1Geometry?.dispose?.();
			}
		};
	} catch (error) {
		lod21Geometry?.dispose?.();
		lod1Geometry?.dispose?.();
		throw error;
	}
}
