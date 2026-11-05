#!/usr/bin/env node
/**
 * Stage a verified Vienna native 3D building dataset (Z13, Z14, Z15).
 * Input: independently audited, unpublished GitHub Actions artifacts.
 *
 * No CityGML/Maptoolkit source required. Fails closed on missing tiles,
 * tampered compressed bytes, inconsistent FMZK revisions and bad Z13 chunks.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

const MIN_ZOOM_COUNTS=Object.freeze({13:50,14:150,15:600});
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
function tileKey(key,zoom){
	const m=/^(13|14|15)\/(\d+)\/(\d+)$/.exec(key);
	return m && Number(m[1])===zoom && Number(m[2])<2**zoom && Number(m[3])<2**zoom;
}
async function readJson(file){return JSON.parse(await fs.readFile(file,"utf8"));}
async function verifiedFile(file,size,sha){
	const bytes=await fs.readFile(file);
	if(bytes.length!==size || hash(bytes)!==sha)throw new Error("Native building file checksum mismatch: "+file);
	return bytes;
}
async function copyVerified(dest,bytes){
	await fs.mkdir(path.dirname(dest),{recursive:true});
	await fs.writeFile(dest,bytes);
}
export async function stageNativeRelease({
	z13Dir,z14Dir,z15Dir,outDir,releaseId="2026-11-05-fmzk-native-v1",
	allowPartial=false
}={}){
	if(![z13Dir,z14Dir,z15Dir,outDir].every(x=>typeof x==="string"&&x) ||
		!/^[a-zA-Z0-9._-]{8,100}$/.test(releaseId)){
		throw new Error("Missing or unsafe native city release paths");
	}
	if(allowPartial)throw new Error("Partial city releases are forbidden");
	const root=outDir;
	const low=new Map();
	for(const [zoom,dir] of [[13,z13Dir],[14,z14Dir]]){
		const manifest=await readJson(path.join(dir,"manifest.json"));
		if(manifest.schemaVersion!==1 || manifest.format!=="KSWN0001" ||
			manifest.zoom!==zoom || manifest.source!=="current-official-fmzk-lod1" ||
			Object.keys(manifest.tiles||{}).length<MIN_ZOOM_COUNTS[zoom]){
			throw new Error("Incomplete Vienna native Z"+zoom+" input manifest");
		}
		let parts=0,vertices=0,triangles=0,bytesCount=0;
		for(const [key,record] of Object.entries(manifest.tiles)){
			if(!tileKey(key,zoom) || record?.buildingParts<1 ||
				record.lod21Parts!==0 || record.lod1Parts!==record.buildingParts){
				throw new Error("Invalid FMZK-native Z"+zoom+" tile "+key);
			}
			if(zoom===13){
				if(!Array.isArray(record.chunks)||!record.chunks.length ||
					record.chunks.length>512)throw new Error("Missing bounded Z13 tile chunks "+key);
				let counted=0;
				for(let i=0;i<record.chunks.length;i++){
					const chunk=record.chunks[i];
					if(chunk.key!==key+"/"+i+".bin.gz" || chunk.parts<1 ||
						chunk.rawBytes>=16*1024*1024)throw new Error("Invalid bounded native Z13 chunk "+key);
					const content=await verifiedFile(path.join(dir,"tiles",chunk.key),
						chunk.gzipBytes,chunk.sha256);
					await copyVerified(path.join(root,"tiles",chunk.key),content);
					counted+=chunk.parts;bytesCount+=chunk.gzipBytes;
				}
				if(counted!==record.buildingParts)throw new Error("Dropped source building parts "+key);
			}else{
				const content=await verifiedFile(path.join(dir,"tiles",key+".bin.gz"),
					record.gzipBytes,record.sha256);
				await copyVerified(path.join(root,"tiles",key+".bin.gz"),content);
				bytesCount+=record.gzipBytes;
			}
			parts+=record.buildingParts;
			vertices+=record.vertices;
			triangles+=record.triangles;
		}
		if(parts!==manifest.parts || vertices!==manifest.vertices ||
			triangles!==manifest.triangles || bytesCount!==manifest.gzipBytes){
			throw new Error("Inconsistent native FMZK Z"+zoom+" totals");
		}
		low.set(zoom,manifest);
	}
	const z15=await readJson(path.join(z15Dir,"release.json"));
	const reference=low.get(14).sourceRelease;
	if(reference!==low.get(13).sourceRelease ||
		reference!==z15.fmzkRelease ||
		z15.format!=="KSWN0001" || z15.publishedTileCount<MIN_ZOOM_COUNTS[15] ||
		Object.keys(z15.tiles||{}).length!==z15.publishedTileCount ||
		z15.lod21Parts<1000 || z15.buildingParts<200000 ||
		Object.keys(z15.sources||{}).length<500 ||
		z15.dependencyIndex?.tileKeys?.length!==z15.publishedTileCount){
		throw new Error("Mixed or incomplete authoritative Vienna Z13-Z15 sources");
	}
	let z15Bytes=0,parts15=0,roofs=0;
	for(const [key,metric] of Object.entries(z15.tiles)){
		if(!tileKey(key,15))throw new Error("Invalid Z15 original roof tile key "+key);
		const bytes=await verifiedFile(path.join(z15Dir,"tiles",key+".bin.gz"),
			metric.gzipBytes,metric.sha256);
		await copyVerified(path.join(root,"tiles",key+".bin.gz"),bytes);
		z15Bytes+=metric.gzipBytes;
		parts15+=metric.buildingParts;
		roofs+=metric.lod21Parts;
	}
	if(z15Bytes!==z15.gzipBytes || parts15!==z15.buildingParts ||
		roofs!==z15.lod21Parts)throw new Error("Z15 native geometry count drift");
	const indexMeta=z15.buildingIndex;
	if(indexMeta?.path!=="building-index.json.gz")throw new Error("No verified Z15 building index");
	const index=await verifiedFile(path.join(z15Dir,indexMeta.path),
		indexMeta.gzipBytes,indexMeta.sha256);
	await copyVerified(path.join(root,indexMeta.path),index);
	const levels={};
	for(const [zoom,manifest] of low){
		const file="release-z"+zoom+".json";
		await fs.writeFile(path.join(root,file),JSON.stringify(manifest,null,"\t")+"\n");
		levels[zoom]={geometry:"pretriangulated-lod1-flat-roofs",
			tiles:Object.keys(manifest.tiles).length,parts:manifest.parts,vertices:manifest.vertices,
			triangles:manifest.triangles,gzipBytes:manifest.gzipBytes,
			manifest:file,
			tilesFormat:zoom===13?"chunked-by-tile":"one-binary-per-tile",
			tileTemplate:zoom===13?"tiles/13/{x}/{y}/{chunk}.bin.gz":
				"tiles/14/{x}/{y}.bin.gz"};
	}
	await fs.writeFile(path.join(root,"release-z15.json"),JSON.stringify(z15,null,"\t")+"\n");
	levels[15]={geometry:"pretriangulated-verified-original-roofs",
		tiles:z15.publishedTileCount,parts:z15.buildingParts,roofParts:z15.lod21Parts,
		gzipBytes:z15.gzipBytes,
		manifest:"release-z15.json",buildingIndex:indexMeta.path,
		tileTemplate:"tiles/15/{x}/{y}.bin.gz"};
	const publication={
		schemaVersion:1,format:"KSWN0001",status:"complete",releaseId,
		fmzkRelease:reference,attribution:"Stadt Wien – data.wien.gv.at, CC BY 4.0",
		source:"Kartensammlung original FMZK and validated original CityGML",
		tileRoot:"tiles/",cacheVersion:releaseId,
		zoomLevels:levels,
		note:"Z13 tiles are split into independently decodable native geometry chunks; Z14 and Z15 use single files."
	};
	// Commit this manifest and all changed XYZ tiles together in one Git commit.
	const bytes=JSON.stringify(publication,null,"\t")+"\n";
	await fs.mkdir(outDir,{recursive:true});
	await fs.writeFile(path.join(outDir,"release.json"),bytes);
	console.log(JSON.stringify({status:"complete",releaseId,
		zoomLevels:Object.fromEntries(Object.entries(levels).map(([z,v])=>
			[z,{tiles:v.tiles,parts:v.parts,geometryBytes:v.gzipBytes}]))}));
	return publication;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	const [z13Dir,z14Dir,z15Dir,outDir,releaseId]=process.argv.slice(2);
	stageNativeRelease({z13Dir,z14Dir,z15Dir,outDir,releaseId}).catch(e=>{
		console.error(e?.stack||e);process.exitCode=1;
	});
}
