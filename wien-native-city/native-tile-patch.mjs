#!/usr/bin/env node
/**
 * Read, retain and replace individual already-triangulated KSWN0001 parts.
 *
 * Historical CityGML ZIPs aren't needed for unchanged building parts:
 * their packed vertices, semantic surface flags, normals, terrain anchor
 * and triangle indices are re-used from the *published* native tile.
 *
 * No Three.js dependency and no new meshing at update time.
 */
import {gzipSync, gunzipSync} from "node:zlib";
import {createHash} from "node:crypto";

export const NATIVE_MAGIC = "KSWN0001";
export const NATIVE_EXTENT = 8192;
const HEADER_BYTES = 32;
const STRIDE = 16;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PARTS = 200000;

function requireNumber(value, message, minimum = 0) {
	if (!Number.isSafeInteger(value) || value < minimum) throw new Error(message);
	return value;
}

export function groupKey(record) {
	if (!["lod1", "lod21"].includes(record.source)
		|| typeof record.id !== "string" || !record.id
		|| record.id.length > 256) {
		throw new Error("Invalid stable building-part identity");
	}
	return record.source + ":" + record.id;
}

export function readNativeTile(input, {maxBytes=MAX_BYTES} = {}) {
	if(!Number.isSafeInteger(maxBytes) || maxBytes<MAX_BYTES || maxBytes>256*1024*1024){
		throw new Error("Unsafe native build-time buffer limit");
	}
	let raw = Buffer.isBuffer(input) ? input : Buffer.from(input);
	if (raw[0] === 0x1f && raw[1] === 0x8b) {
		raw = gunzipSync(raw, {maxOutputLength: maxBytes});
	}
	if (raw.length < HEADER_BYTES || raw.length > maxBytes ||
		raw.subarray(0,8).toString("ascii") !== NATIVE_MAGIC ||
		raw.readUInt32LE(8) !== 1 || raw.readUInt32LE(12) !== NATIVE_EXTENT) {
		throw new Error("Unsupported or excessively large KSWN0001 tile");
	}
	const vertexCount = raw.readUInt32LE(16);
	const indexCount = raw.readUInt32LE(20);
	const partCount = raw.readUInt32LE(24);
	const metadataLength = raw.readUInt32LE(28);
	requireNumber(partCount, "Invalid native part count", 1);
	if (partCount > MAX_PARTS || metadataLength > Math.min(32*1024*1024,maxBytes/2) ||
		indexCount % 3 || vertexCount === 0 || indexCount === 0) {
		throw new Error("Invalid native tile header cardinality");
	}
	const metadataEnd = HEADER_BYTES + metadataLength;
	const vertexStart = (metadataEnd + 3) & ~3;
	const indexStart = vertexStart + vertexCount * STRIDE;
	if (indexStart + indexCount*4 !== raw.length) {
		throw new Error("Invalid KSWN0001 buffer offsets");
	}
	const metadata = JSON.parse(raw.subarray(HEADER_BYTES,metadataEnd).toString("utf8"));
	if (!Array.isArray(metadata?.buildings) ||
		metadata.buildings.length !== partCount ||
		metadata.vertexStride !== STRIDE ||
		metadata.geometry !== "relative-heights-no-terrain") {
		throw new Error("Unexpected KSWN0001 building metadata");
	}
	const parts = [];
	let nextVertex = 0, nextIndex = 0;
	for (const item of metadata.buildings) {
		groupKey(item);
		const vs = requireNumber(item.vertexStart,"Invalid vertex start");
		const vc = requireNumber(item.vertexCount,"Invalid vertex count",1);
		const is = requireNumber(item.indexStart,"Invalid index start");
		const ic = requireNumber(item.indexCount,"Invalid index count",3);
		if (vs !== nextVertex || is !== nextIndex || ic % 3 ||
			vs+vc > vertexCount || is+ic > indexCount ||
			![item.anchorX,item.anchorY].every(Number.isFinite)) {
			throw new Error("Noncontiguous native building ranges");
		}
		if (item.sourceSheets !== undefined &&
			(!Array.isArray(item.sourceSheets) ||
			!item.sourceSheets.length ||
			item.sourceSheets.some(s=>typeof s !== "string" || !/^[0-9]{6}$/.test(s)))) {
			throw new Error("Invalid original CityGML provenance");
		}
		if(item.replacesKsIds!==undefined &&
			(item.source!=="lod21" || !Array.isArray(item.replacesKsIds) ||
			!item.replacesKsIds.length ||
			item.replacesKsIds.some(id=>typeof id!=="string" ||
				!/^[A-Za-z0-9:._-]{1,128}$/.test(id)))) {
			throw new Error("Invalid replaced official FMZK building IDs");
		}
		const vertices = Buffer.from(raw.subarray(vertexStart+vs*STRIDE,vertexStart+(vs+vc)*STRIDE));
		const indices = Buffer.alloc(ic*4);
		for(let i=0;i<ic;i++) {
			const idx = raw.readUInt32LE(indexStart+(is+i)*4);
			if(idx<vs || idx>=vs+vc)throw new Error("Triangle crosses building-part boundaries");
			indices.writeUInt32LE(idx-vs,i*4);
		}
		const {vertexStart:ignoredV,vertexCount:ignoredVC,
			indexStart:ignoredI,indexCount:ignoredIC,...rest} = item;
		parts.push({info:rest,vertices,indices});
		nextVertex += vc;
		nextIndex += ic;
	}
	if(nextVertex!==vertexCount || nextIndex!==indexCount){
		throw new Error("Not all native geometry belongs to a building part");
	}
	return {kind:metadata.kind, geometry:metadata.geometry,
		extent:metadata.extent, parts};
}

export function writeNativeTile(parts, {gzip = true} = {}) {
	if(!Array.isArray(parts) || !parts.length || parts.length>MAX_PARTS){
		throw new Error("Empty or oversized native tile part set");
	}
	const records=[];
	const faceTriangles={wall:0,pitchedRoof:0,flatRoof:0};
	let totalVertices=0,totalIndices=0;
	const buffers=[],indices=[];
	for(const part of parts) {
		if(!part || !Buffer.isBuffer(part.vertices) || !Buffer.isBuffer(part.indices)
			|| part.vertices.length%STRIDE || part.indices.length%12
			|| !part.vertices.length || !part.indices.length) {
			throw new Error("Invalid packed native geometry input");
		}
		const info=part.info;
		groupKey(info);
		if(![info.anchorX,info.anchorY].every(Number.isFinite)) {
			throw new Error("Invalid native geometry terrain anchor");
		}
		if(info.sourceSheets !== undefined &&
			(!Array.isArray(info.sourceSheets) ||
			!info.sourceSheets.length ||
			info.sourceSheets.some(sheet=>!/^\d{6}$/.test(sheet)))) {
			throw new Error("Invalid native source sheet lineage");
		}
		if(info.replacesKsIds!==undefined &&
			(info.source!=="lod21" || !Array.isArray(info.replacesKsIds) ||
			!info.replacesKsIds.length ||
			info.replacesKsIds.some(id=>typeof id!=="string" ||
				!/^[A-Za-z0-9:._-]{1,128}$/.test(id)))) {
			throw new Error("Invalid replaced official FMZK building IDs");
		}
		const vc=part.vertices.length/STRIDE,ic=part.indices.length/4;
		records.push({...info,
			vertexStart:totalVertices,vertexCount:vc,
			indexStart:totalIndices,indexCount:ic});
		buffers.push(part.vertices);
		const adjusted=Buffer.alloc(part.indices.length);
		for(let i=0;i<ic;i++) {
			const idx=part.indices.readUInt32LE(i*4);
			if(idx>=vc) throw new Error("Packed part index outside its vertices");
			adjusted.writeUInt32LE(idx+totalVertices,i*4);
			if(i%3===0) {
				const surface=part.vertices.readUInt8(idx*STRIDE+12);
				if(surface===0)faceTriangles.wall++;
				else if(surface===1)faceTriangles.pitchedRoof++;
				else if(surface===2)faceTriangles.flatRoof++;
				else throw new Error("Invalid packed surface kind");
			}
		}
		indices.push(adjusted);
		totalVertices+=vc;
		totalIndices+=ic;
	}
	const metadata={
		kind:"ks-wien-native",
		geometry:"relative-heights-no-terrain",
		vertexStride:STRIDE,
		extent:NATIVE_EXTENT,
		buildings:records
	};
	const json=Buffer.from(JSON.stringify(metadata));
	const padding=(4-json.length%4)%4;
	const header=Buffer.alloc(HEADER_BYTES);
	header.write(NATIVE_MAGIC,0,"ascii");
	header.writeUInt32LE(1,8);
	header.writeUInt32LE(NATIVE_EXTENT,12);
	header.writeUInt32LE(totalVertices,16);
	header.writeUInt32LE(totalIndices,20);
	header.writeUInt32LE(records.length,24);
	header.writeUInt32LE(json.length,28);
	const raw=Buffer.concat([header,json,Buffer.alloc(padding),...buffers,...indices]);
	if(raw.length>MAX_BYTES)throw new Error("Native tile exceeds safe maximum size");
	const compressed=gzipSync(raw,{level:9});
	return {raw,compressed:gzip?compressed:raw,sha256:createHash("sha256").update(raw).digest("hex"),
		stats:{parts:records.length,lod1Parts:records.filter(r=>r.source==="lod1").length,
			lod21Parts:records.filter(r=>r.source==="lod21").length,
			vertices:totalVertices,triangles:totalIndices/3,faceTriangles,
			rawBytes:raw.length,gzipBytes:compressed.length}};
}

/**
 * Caller must supply all replacement parts and exact old logical identities
 * to invalidate. Supports a 1:many replacement and preserving thousands of
 * unrelated parts byte-for-byte, without parsing historical source CityGML.
 *
 * Deleting geometry without a replacement is forbidden unless explicitly
 * authorized, because removing a pitched roof may require FMZK fallback.
 */
export function patchNativeTile({
	base, replacements, invalidate, allowDeletion = false
}={}) {
	const original=readNativeTile(base);
	const changed=readNativeTile(replacements);
	const invalidated=new Set(invalidate);
	if(!invalidated.size)throw new Error("No invalidated building identity supplied");
	for(const key of invalidated) {
		if(typeof key!=="string" || key.length>300 || !/^(lod1|lod21):/.test(key)) {
			throw new Error("Invalid native building group invalidation");
		}
	}
	const existing=new Set(original.parts.map(part=>groupKey(part.info)));
	const incoming=new Set(changed.parts.map(part=>groupKey(part.info)));
	if([...incoming].some(key=>existing.has(key) && !invalidated.has(key))) {
		throw new Error("Patch would duplicate a previously stored building part");
	}
	if(!allowDeletion && [...invalidated].some(key=>existing.has(key) && !incoming.has(key))) {
		throw new Error("Patch would erase an existing building without replacement/fallback");
	}
	const kept=original.parts.filter(part=>!invalidated.has(groupKey(part.info)));
	return writeNativeTile([...kept,...changed.parts]);
}
