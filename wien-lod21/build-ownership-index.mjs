/**
 * Generate a conservative Z15 ownership candidate index from geometry
 * actually emitted by the LOD2.1 build (not the aspirational target list).
 *
 * This is NOT a Maptoolkit buildings2d/3d identity crosswalk and MUST NOT
 * be used to hide native Stadtplan buildings without a separate audit.
 */
export function makeWienLod21OwnershipIndex(tileData, generatedAt) {
	const tiles = {};
	let objects = 0;
	let identifiers = 0;
	for (const [key, data] of [...tileData.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (!/^15\/\d+\/\d+$/.test(key)) throw new Error(`Invalid Z15 tile: ${key}`);
		const parts = new Map();
		for (const building of data?.buildings || []) {
			if (!(Number(building?.indexCount) > 0 && Number(building?.vertexCount) > 0)) continue;
			const code = String(building.historicalCode || "").trim();
			if (!code) throw new Error(`LOD2.1 building without historical code: ${key}`);
			const ids = [...new Set((building.ogdKsIds || [])
				.map((id) => String(id ?? "").trim()).filter(Boolean))].sort();
			const mode = String(building.rolloutMode || "");
			const fingerprintGuarded = mode.startsWith("maptoolkit-roof-replacement");
			const previous = parts.get(code);
			if (previous && (previous.mode !== mode
				|| JSON.stringify(previous.ogdKsIds) !== JSON.stringify(ids))) {
				throw new Error(`Conflicting building ownership: ${key} ${code}`);
			}
			parts.set(code, { mode, ogdKsIds: ids, fingerprintGuarded });
			objects++;
		}
		if (!parts.size) continue;
		const buildings = [...parts.entries()].sort(([a], [b]) => a.localeCompare(b))
			.map(([historicalCode, item]) => ({ historicalCode, ...item }));
		identifiers += buildings.length;
		tiles[key] = buildings;
	}
	return {
		schemaVersion: 1,
		generatedAt,
		zoom: 15,
		meaning: "candidate-only; hide OGD ids only when corresponding detailed mesh is ready and cross-source exclusions are validated",
		nativeStadtplanIdsVerified: false,
		tiles,
		counts: { tileCount: Object.keys(tiles).length, geometryObjects: objects, historicalBuildings: identifiers }
	};
}
