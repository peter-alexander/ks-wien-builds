/**
 * Wiener building shading carried over from the old WienLOD2Buildings
 * MapLibre fill-extrusion approximation. All three geometry sources use
 * the official Vienna Stadtplan base paint #fafafa on every surface.
 *
 * Vertex RGB attributes are normalized Uint8 sRGB-like values; the shader
 * must not apply Three's standard material color management to them.
 */
export const WIEN_BUILDING_STYLE = Object.freeze({
	id: "maptoolkit-fill3d-0.5.4-light",
	// The Stadtplan's buildings_lod2 and buildings_lod1 both use #fafafa.
	colors: Object.freeze({
		wall: 0xfafafa,
		"pitched-roof": 0xfafafa,
		"flat-roof": 0xfafafa
	}),
	// StadtplanWien/style.json: light = { color: "#fffbfd",
	// anchor: "viewport", intensity: 0.4 }. The style omits position,
	// so we use the MapLibre default [1.15, 210, 30].
	light: Object.freeze({
		color: 0xfffbfd,
		intensity: 0.4,
		anchor: "viewport",
		position: Object.freeze([1.15, 210, 30])
	}),
	lightPosition: Object.freeze([1.15, 210, 30])
});

/**
 * Reproduces the original published buildings_lod2 paint:
 * - flat: interpolate zoom 16 -> 0, 17 -> .3
 * - pitched: max(flat value, mtk:pitch / 85)
 * Unlike the previous separate global opacity preference, this is the
 * source style's actual rule. It is clamped to a valid opacity range.
 */
export function getWienStadtplanBuildingOpacity({ zoom = 0, pitch = 0 } = {}) {
	const validZoom = Number.isFinite(Number(zoom)) ? Number(zoom) : 0;
	const validPitch = Number.isFinite(Number(pitch)) ? Number(pitch) : 0;
	const flat = Math.min(0.3, Math.max(0, (validZoom - 16) * 0.3));
	return Math.min(1, Math.max(flat, Math.max(0, validPitch) / 85));
}

export function getWienBuildingLightDirection(
	lightPosition = WIEN_BUILDING_STYLE.lightPosition,
	bearing = 0
) {
	const [radius, azimuth, polar] = lightPosition;
	const azimuthRadians = (azimuth + 90) * Math.PI / 180;
	const polarRadians = polar * Math.PI / 180;
	const x = radius * Math.cos(azimuthRadians) * Math.sin(polarRadians);
	const y = radius * Math.sin(azimuthRadians) * Math.sin(polarRadians);
	const z = radius * Math.cos(polarRadians);
	const radians = (Number(bearing) || 0) * Math.PI / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const rotatedX = cosine * x - sine * y;
	const rotatedY = sine * x + cosine * y;
	// Maptoolkit keeps the original style light radius (1.15).
	return { x: rotatedX, y: rotatedY, z };
}

export function createWienBuildingMaterial(
	THREE,
	style = WIEN_BUILDING_STYLE
) {
	if (typeof THREE?.RawShaderMaterial !== "function"
		|| typeof THREE?.Vector3 !== "function"
		|| typeof THREE?.Vector4 !== "function") {
		throw new TypeError("Wien building styling requires Three.js RawShaderMaterial.");
	}
	const lighting = style.light || WIEN_BUILDING_STYLE.light;
	const light = getWienBuildingLightDirection(lighting.position);
	const lightColor = lighting.color;
	// Adapted from the MIT-licensed Maptoolkit Fill3DLayer 0.5.4 shader.
	// Our normals are already outward-facing in (east,south,up) space;
	// the source plugin needs an extra correction for its own raw normals.
	const material = new THREE.RawShaderMaterial({
		uniforms: {
			uLightDirection: { value: new THREE.Vector3(light.x, light.y, light.z) },
			uLightColor: {
				value: new THREE.Vector3(
					((lightColor >>> 16) & 255) / 255,
					((lightColor >>> 8) & 255) / 255,
					(lightColor & 255) / 255
				)
			},
			uLightIntensity: { value: lighting.intensity },
			uCoverageRow0: { value: new THREE.Vector4(0, 0, 0, 0) },
			uCoverageRow1: { value: new THREE.Vector4(0, 0, 0, 0) },
			uCoverageRow2: { value: new THREE.Vector4(0, 0, 0, 0) },
			uCoverageRow3: { value: new THREE.Vector4(0, 0, 0, 0) },
			uCoarseTile: { value: 0 },
			uOpacity: { value: 1 }
		},
		vertexShader: `
			precision highp float;
			uniform mat4 modelViewMatrix;
			uniform mat4 projectionMatrix;
			uniform vec3 uLightDirection;
			uniform vec3 uLightColor;
			uniform float uLightIntensity;
			attribute vec3 position;
			attribute vec3 normal;
			attribute vec3 color;
			varying vec3 vLitColor;
			varying vec2 vTilePosition;
			void main() {
				float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
				vec3 surfaceNormal = normalize(normal);
				float directional = clamp(dot(surfaceNormal, uLightDirection), 0.0, 1.0);
				directional = mix(
					1.0 - uLightIntensity,
					max(1.0 - luminance + uLightIntensity, 1.0),
					directional
				);
				vec3 base = color + vec3(0.03);
				vLitColor = clamp(
					base * directional * uLightColor,
					(vec3(1.0) - uLightColor) * 0.3,
					vec3(1.0)
				);
				vTilePosition = position.xy;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: `
			precision highp float;
			uniform vec4 uCoverageRow0;
			uniform vec4 uCoverageRow1;
			uniform vec4 uCoverageRow2;
			uniform vec4 uCoverageRow3;
			uniform float uCoarseTile;
			uniform float uOpacity;
			varying vec3 vLitColor;
			varying vec2 vTilePosition;

			void main() {
				// Z13 and Z14 use 4x4 fractional coverage masks. Mask
				// only tiles whose higher-resolution geometry is ready.
				if (uCoarseTile > 0.5) {
					float col = clamp(floor(vTilePosition.x / 2048.0), 0.0, 3.0);
					float row = clamp(floor(vTilePosition.y / 2048.0), 0.0, 3.0);
					vec4 coveredRow = row < 0.5 ? uCoverageRow0
						: (row < 1.5 ? uCoverageRow1
						: (row < 2.5 ? uCoverageRow2 : uCoverageRow3));
					float covered = col < 0.5 ? coveredRow.x
						: (col < 1.5 ? coveredRow.y
						: (col < 2.5 ? coveredRow.z : coveredRow.w));
					if (covered > 0.5) discard;
				}
							gl_FragColor = vec4(vLitColor, uOpacity);
			}
		`,
		side: THREE.DoubleSide,
		transparent: false,
		opacity: 1,
		depthTest: true,
		depthWrite: true,
		toneMapped: false
	});
	material.userData.ksBuildingStyle = style.id;
	return material;
}

export function updateWienBuildingMaterialLight(
	material,
	bearing = 0,
	style = WIEN_BUILDING_STYLE
) {
	const vector = material?.uniforms?.uLightDirection?.value;
	if (typeof vector?.set !== "function") return;
	const direction = getWienBuildingLightDirection(
		style.light?.position || style.lightPosition,
		style.light?.anchor === "map" ? 0 : bearing
	);
	vector.set(direction.x, direction.y, direction.z);
}

export function updateWienBuildingMaterialOpacity(material, opacity) {
	if (!material) return;
	const normalized = Math.max(0, Math.min(1, Number(opacity) || 0));
	const transparent = normalized < 0.999;
	const changed = material.transparent !== transparent;
	material.opacity = normalized;
	material.transparent = transparent;
	// Match the old shader: transparent buildings still occlude the shared
	// MapLibre depth buffer and prevent symbols from bleeding through walls.
	material.depthWrite = true;
	if (material.uniforms?.uOpacity) material.uniforms.uOpacity.value = normalized;
	if (changed) material.needsUpdate = true;
}
