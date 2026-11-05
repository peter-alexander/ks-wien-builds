#!/usr/bin/env node
/**
 * Native pretriangulated FMZK LOD1 geometry at Z14 (and later Z13).
 *
 * IMPORTANT: The already published official-FMZK vector tiles at Z13/Z14
 * carry correctly clipped, zoom-generalized footprints. Build directly from
 * them: never merge child native Z15 roofs or redownload CityGML sources.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {VectorTile} from "@mapbox/vector-tile";
import {PbfReader} from "pbf";
import * as THREE from "three";
import {buildWienOgdFallbackTileGeometry}
	from "../wien-optimized/src/app/buildings/wien-ogd-fallback-geometry.js";
import {encodeNativeTile,BASE}
	from "../wien-native-pilot/build.mjs";
import {readNativeTile} from "./native-tile-patch.mjs";
import {chunkNativeParts} from "./native-chunks.mjs";

export const REFERENCE_OGD_RELEASE="2026-11-03T11:04:51.669Z";
const sha256=buffer=>createHash("sha256").update(buffer).digest("hex");
const pilotKeys14=["14/8936/5680","14/8937/5680"];
const SRC_LAYER="wien_buildings";
export function verifyLowZoomRelease(release,zoom){
	if(![13,14].includes(zoom) || release?.generatedAt!==REFERENCE_OGD_RELEASE ||
		release?.vectorTiles?.minzoom>zoom || release?.vectorTiles?.maxzoom<zoom ||
		release.vectorTiles.layer!==SRC_LAYER ||
		release.vectorTiles.compression!=="none" ||
		release.vectorTiles.extent!==4096 ||
		release.vectorTiles.tileCounts?.[String(zoom)]!==(zoom===14?200:62) ||
		release.vectorTiles.geometryPolicy?.lowZooms!=="13-14" ||
		release.vectorTiles.geometryPolicy?.featureDropping!==false ||
		release.vectorTiles.geometryPolicy?.tinyPolygonReduction!==false ||
		!/^tiles\/\{z\}\/\{x\}\/\{y\}\.pbf$/.test(release.vectorTiles.urlTemplate)){
		throw new Error("Official Wien FMZK zoom source no longer matches verified release");
	}
	return release;
}
export function validateLowZoomKeys(zoom,keys){
	if(![13,14].includes(zoom)||!Array.isArray(keys)||!keys.length ||
		new Set(keys).size!==keys.length ||
		keys.some(key=>{
			const parsed=/^(13|14)\/([0-9]+)\/([0-9]+)$/.exec(key);
			return !parsed || Number(parsed[1])!==zoom ||
				Number(parsed[2])>=2**zoom || Number(parsed[3])>=2**zoom;
		}))throw new Error("Invalid or duplicate FMZK low-zoom tile selection");
	return keys;
}
export async function buildLowZoom({
	zoom=14,keys=pilotKeys14,outDir="wien-native-city/build/z14-pilot",
	fetchTile=fetch,baseUrl=BASE
}={}){
	validateLowZoomKeys(zoom,keys);
	const response=await fetchTile(baseUrl+"/LOD1/release.json");
	if(!response.ok)throw new Error("Official FMZK release unavailable");
	const release=verifyLowZoomRelease(await response.json(),zoom);
	const manifest={schemaVersion:1,format:"KSWN0001",zoom,
		source:"current-official-fmzk-lod1",sourceRelease:release.generatedAt,
		sourceTilePolicy:release.vectorTiles.geometryPolicy,
		tiles:{},parts:0,vertices:0,triangles:0,gzipBytes:0};
	for(const key of keys){
		const [z,x,y]=key.split("/").map(Number);
		const source=await fetchTile(baseUrl+"/LOD1/tiles/"+key+".pbf");
		if(!source.ok)throw new Error("Missing official FMZK tile "+key+" HTTP "+source.status);
		const input=new Uint8Array(await source.arrayBuffer());
		if(!input.byteLength)throw new Error("Empty official FMZK source tile "+key);
		const data=buildWienOgdFallbackTileGeometry(input,{z,x,y},
			{THREE,VectorTile,Protobuf:PbfReader});
		const geometry=data.geometry;
		if(!geometry)throw new Error("Missing official FMZK buildings in "+key);
		try{
			const encoded=encodeNativeTile({z,x,y},[{source:"lod1",geometry}]);
			const parsed=readNativeTile(encoded.raw,
				zoom===13?{maxBytes:256*1024*1024}:undefined);
			if(parsed.parts.length!==encoded.stats.buildingParts ||
				parsed.parts.some(p=>p.info.source!=="lod1"||!p.info.id.startsWith("ogd:"))){
				throw new Error("Unexpected native FMZK source geometry in "+key);
			}
			const chunks=zoom===13?chunkNativeParts(parsed.parts):null;
			const output=path.join(outDir,"tiles",key+".bin.gz");
			await fs.mkdir(path.dirname(output),{recursive:true});
			let bytes=0;
			if(chunks){
				for(const chunk of chunks){
					const chunkName=key+"/"+chunk.index+".bin.gz";
					const target=path.join(outDir,"tiles",chunkName);
					await fs.mkdir(path.dirname(target),{recursive:true});
					await fs.writeFile(target,chunk.compressed);
					chunk.key=chunkName;
					chunk.sha256=sha256(chunk.compressed);
					bytes+=chunk.compressed.length;
					readNativeTile(chunk.compressed);
				}
			}else{
				await fs.writeFile(output,encoded.compressed);
				bytes=encoded.compressed.length;
			}
			manifest.tiles[key]={
				...(chunks?{chunks:chunks.map(({key,parts,rawBytes,gzipBytes,sha256})=>({
					key,parts,rawBytes,gzipBytes,sha256}))}
					:{sha256:sha256(encoded.compressed)}),
				...encoded.stats,gzipBytes:bytes
			};
			manifest.parts+=encoded.stats.buildingParts;
			manifest.vertices+=encoded.stats.vertices;
			manifest.triangles+=encoded.stats.triangles;
			manifest.gzipBytes+=bytes;
		}finally{geometry.dispose();}
	}
	await fs.mkdir(outDir,{recursive:true});
	await fs.writeFile(path.join(outDir,"manifest.json"),JSON.stringify(manifest,null,"\t")+"\n");
	console.log(JSON.stringify({zoom,tiles:keys.length,parts:manifest.parts,
		vertices:manifest.vertices,triangles:manifest.triangles,gzipBytes:manifest.gzipBytes}));
	return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	const zoom=Number(process.argv[2]||14);
	const keys=process.argv.slice(4);
	buildLowZoom({zoom,keys:keys.length?keys:pilotKeys14,outDir:process.argv[3]||"wien-native-city/build/z14-pilot"})
		.catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
