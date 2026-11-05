#!/usr/bin/env node
/**
 * Build all existing official FMZK Z14/Z13 native LOD1 tiles from a sparse,
 * pinned checkout of OUR published OGD vector tiles.
 *
 * The actual source directory (not the Z15 tile inventory) determines coverage.
 * This matters because Z14 has 200 existing tiles vs only 199 parents
 * containing a published Z15 building tile.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildLowZoom,verifyLowZoomRelease,validateLowZoomKeys} from "./build-lowzoom.mjs";

export async function listExistingLowZoomKeys(sourceDir,zoom){
	const root=path.join(sourceDir,"tiles",String(zoom));
	const result=[];
	for(const dir of await fs.readdir(root,{withFileTypes:true})){
		if(!dir.isDirectory() || !/^\d+$/.test(dir.name))throw new Error("Unexpected FMZK tile column");
		for(const file of await fs.readdir(path.join(root,dir.name),{withFileTypes:true})){
			if(!file.isFile()||!/^\d+\.pbf$/.test(file.name)){
				throw new Error("Unexpected FMZK low-zoom tile file");
			}
			result.push(`${zoom}/${dir.name}/${file.name.slice(0,-4)}`);
		}
	}
	validateLowZoomKeys(zoom,result);
	return result.sort((a,b)=>a.localeCompare(b));
}
export async function buildWholeLowZoom({
	sourceDir,outDir,zoom=14
}={}){
	if(!sourceDir||!outDir)throw new Error("Provide published FMZK source directory and output");
	const release=verifyLowZoomRelease(
		JSON.parse(await fs.readFile(path.join(sourceDir,"release.json"),"utf8")),zoom);
	const keys=await listExistingLowZoomKeys(sourceDir,zoom);
	const expected=release.vectorTiles.tileCounts[String(zoom)];
	if(keys.length!==expected)throw new Error(
		"Incomplete official FMZK coverage: "+keys.length+" of "+expected);
	const fetchTile=async url=>{
		const relative=new URL(url).pathname.split("/LOD1/")[1];
		if(!relative || !/^(release\.json|tiles\/(13|14)\/\d+\/\d+\.pbf)$/.test(relative)){
			throw new Error("Unexpected local FMZK read path: "+relative);
		}
		const bytes=await fs.readFile(path.join(sourceDir,relative));
		return {ok:true,json:async()=>JSON.parse(bytes.toString("utf8")),
			arrayBuffer:async()=>bytes};
	};
	const manifest=await buildLowZoom({zoom,keys,outDir,fetchTile});
	if(Object.keys(manifest.tiles).length!==expected ||
		!manifest.parts||!manifest.vertices||!manifest.triangles){
		throw new Error("Incomplete native low-zoom geometry build");
	}
	console.log("Verified all "+expected+" direct FMZK Z"+zoom+" native LOD1 tiles");
	return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	const [sourceDir,zoom,outDir]=process.argv.slice(2);
	buildWholeLowZoom({sourceDir,zoom:Number(zoom),outDir})
		.catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
