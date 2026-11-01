/**
 * Transferable geometry boundary between the Vienna building worker and
 * the MapLibre/Three.js WebGL thread. Never move WebGL objects across it.
 * Keep the original userData, especially relative heights, ground ranges,
 * fallback masks and historical CityGML lookup fields.
 */
const GEOMETRY_FIELDS = [
	"lod2Geometry", "lod21Geometry", "lod1Geometry"
];

function packAttribute(attribute) {
	if (!attribute) return null;
	if (!ArrayBuffer.isView(attribute.array) || attribute.isInterleavedBufferAttribute) {
		throw new TypeError("Wien building geometry requires contiguous typed-array attributes.");
	}
	return {
		array: attribute.array,
		itemSize: attribute.itemSize,
		normalized: Boolean(attribute.normalized)
	};
}

export function packWienBuildingGeometry(geometry) {
	if (!geometry) return null;
	const attributes = {};
	for (const name of ["position", "normal", "color"]) {
		const attribute = packAttribute(geometry.getAttribute(name));
		if (!attribute) throw new TypeError(`Missing Wiener building attribute: ${name}`);
		attributes[name] = attribute;
	}
	return {
		attributes,
		index: packAttribute(geometry.getIndex()),
		userData: geometry.userData
	};
}

export function unpackWienBuildingGeometry(packed, THREE) {
	if (!packed) return null;
	const geometry = new THREE.BufferGeometry();
	for (const [name, attribute] of Object.entries(packed.attributes)) {
		geometry.setAttribute(name, new THREE.BufferAttribute(
			attribute.array, attribute.itemSize, attribute.normalized
		));
	}
	if (packed.index) {
		geometry.setIndex(new THREE.BufferAttribute(
			packed.index.array, packed.index.itemSize, packed.index.normalized
		));
	}
	geometry.userData = packed.userData || {};
	return geometry;
}

export function packWienBuildingResource(resource) {
	if (!resource) return { payload: null, transfers: [] };
	const payload = {};
	for (const [key, value] of Object.entries(resource)) {
		if (key === "dispose" || key === "meshes" || key.startsWith("_")) continue;
		payload[key] = GEOMETRY_FIELDS.includes(key)
			? packWienBuildingGeometry(value) : value;
	}
	const transfers = new Set();
	function collect(value) {
		if (!value || typeof value !== "object") return;
		if (ArrayBuffer.isView(value)) {
			const buffer = value.buffer;
			if (buffer instanceof ArrayBuffer && buffer.byteLength) transfers.add(buffer);
			return;
		}
		if (value instanceof ArrayBuffer) {
			if (value.byteLength) transfers.add(value);
			return;
		}
		for (const nested of Object.values(value)) collect(nested);
	}
	collect(payload);
	return { payload, transfers: [...transfers] };
}

export function unpackWienBuildingResource(payload, THREE) {
	if (!payload) return null;
	const resource = { ...payload };
	for (const field of GEOMETRY_FIELDS) {
		resource[field] = unpackWienBuildingGeometry(payload[field], THREE);
	}
	resource.dispose = () => {
		for (const field of GEOMETRY_FIELDS) resource[field]?.dispose?.();
	};
	return resource;
}
