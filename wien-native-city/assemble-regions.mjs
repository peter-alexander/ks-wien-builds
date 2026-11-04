#!/usr/bin/env node
/**
 * Assemble 18 independently audited 8x8 native Vienna regions into a single
 * complete release, with exact Z15 coverage and persistent ZIP-free sources.
 * Aborts before publishing on any missing region, differing original source
 * revision, unexpected roof provenance or incompatible native geometry.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {readNativeTile} from "./native-tile-patch.mjs";
import {mapSheetsToTiles,computeBuilderRevision} from "./incremental-plan.mjs";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const BUILDER_INPUTS=[
	"wien-native-pilot/build.mjs",
	"wien-native-pilot/build-roof-targets.mjs",
	"wien-lod21/build.mjs",
	"wien-optimized/src/app/buildings/wien-ogd-fallback-geometry.js",
	"wien-native-city/region-plan.mjs",
	"wien-native-city/native-tile-patch.mjs"
];

export function sameSourceVersion(a,b) {
	if(a?.status!==b?.status)return false;
	if(a?.status==="missing")return a.httpStatus===404 && b.httpStatus===404;
	if(a?.status==="present"){
		if(a.sha256 && b.sha256)return a.sha256===b.sha256;
		if(a.etag&&b.etag)return a.etag===b.etag;
		return a.lastModified && a.lastModified===b.lastModified &&
			a.contentLength===b.contentLength;
	}
	return false;
}

export async function assembleCityRelease({
	inventory,regionsDir,outDir,readFile=fs.readFile,
	minExpectedLod1Parts=200000,minExpectedLod21Parts=1000
}={}){
	const index=mapSheetsToTiles(inventory);
	const sourceReleases=new Map();
	const tiles=new Map();
	let lod1Parts=0,lod21Parts=0,bytes=0;
	for(const region of inventory.regions){
		const directory=path.join(regionsDir,"wien-native-roof-region-"+region.id);
		const manifest=JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8"));
		const sources=JSON.parse(await readFile(path.join(directory,"source-state.json"),"utf8"));
		if(manifest.schemaVersion!==2 || manifest.format!=="KSWN0001" ||
			manifest.region!==region.id || manifest.sourceRelease!==inventory.sourceRelease ||
			manifest.sourceSheetCount!==region.sheets.length ||
			sources.schemaVersion!==1 ||
			sources.sheetCount!==region.sheets.length ||
			Object.keys(sources.sources).length!==region.sheets.length) {
			throw new Error("Wrong or missing native region release source: "+region.id);
		}
		for(const sheet of region.sheets){
			const state=sources.sources[sheet];
			if(!state||!["present","missing"].includes(state.status)) {
				throw new Error("No verified original CityGML source sheet "+sheet);
			}
			const old=sourceReleases.get(sheet);
			if(old && !sameSourceVersion(old,state)){
				throw new Error("Different source revisions across city regions for "+sheet);
			}
			sourceReleases.set(sheet,state);
		}
		const present=Object.keys(manifest.tiles);
		if(present.length!==region.tileKeys.length ||
			present.some(key=>!region.tileKeys.includes(key))) {
			throw new Error("Incomplete regional output tile set "+region.id);
		}
		for(const [key,metric] of Object.entries(manifest.tiles)){
			if(tiles.has(key))throw new Error("Duplicate current FMZK Z15 tile "+key);
			const filename=path.join(directory,"tiles",key+".bin.gz");
			const binary=await readFile(filename);
			const hash=createHash("sha256").update(binary).digest("hex");
			const parsed=readNativeTile(binary);
			if(hash!==metric.sha256 || binary.length!==metric.gzipBytes ||
				parsed.parts.length!==metric.buildingParts ||
				parsed.parts.filter(p=>p.info.source==="lod21").length!==metric.lod21Parts) {
				throw new Error("Invalid native binary geometry or SHA256 for "+key);
			}
			for(const part of parsed.parts){
				if(part.info.source==="lod21") {
					if(!part.info.sourceSheets?.length ||
						part.info.sourceSheets.some(sheet=>!region.sheets.includes(sheet))){
						throw new Error("Historical roof without matching original CityGML sheet: "+key);
					}
					lod21Parts++;
				}else if(part.info.source==="lod1"){
					if(!part.info.id.startsWith("ogd:") ||
						part.info.id.startsWith("ogd:legacy-")){
						throw new Error("Unstable official FMZK building part key: "+key);
					}
					lod1Parts++;
				}else throw new Error("Unrecognized building source in native city release");
			}
			tiles.set(key,{binary,sha256:hash,metric});
			bytes+=binary.length;
		}
	}
	if(tiles.size!==index.tileKeys.length ||
		index.tileKeys.some(key=>!tiles.has(key)) ||
		sourceReleases.size!==inventory.coverage.sheets) {
		throw new Error("Incomplete full Vienna native release source or tile coverage");
	}
	if(lod21Parts<minExpectedLod21Parts || lod1Parts<minExpectedLod1Parts) {
		throw new Error("Insufficient historical roofs or current FMZK source coverage");
	}
	const buildFiles=[];
	const projectRoot=path.join(ROOT,"..");
	for(const filename of BUILDER_INPUTS){
		buildFiles.push({path:filename,
			content:await fs.readFile(path.join(projectRoot,filename),"utf8")});
	}
	const builderRevision=computeBuilderRevision(buildFiles);
	const metadata={
		schemaVersion:2,format:"KSWN0001",generatedAt:new Date().toISOString(),
		fmzkRelease:inventory.sourceRelease,
		buildRevision,publishedTileCount:tiles.size,
		buildingParts:lod1Parts+lod21Parts,lod1Parts,lod21Parts,
		gzipBytes:bytes,
		sources:Object.fromEntries([...sourceReleases].sort((a,b)=>a[0].localeCompare(b[0]))),
		dependencyIndex:index,
		tiles:Object.fromEntries([...tiles].sort((a,b)=>a[0].localeCompare(b[0]))
			.map(([key,value])=>[key,{
				sha256:value.sha256,gzipBytes:value.binary.length,
				buildingParts:value.metric.buildingParts,
				lod21Parts:value.metric.lod21Parts
			}]))
	};
	await fs.mkdir(outDir,{recursive:true});
	for(const [key,value] of tiles){
		const filename=path.join(outDir,"tiles",key+".bin.gz");
		await fs.mkdir(path.dirname(filename),{recursive:true});
		await fs.writeFile(filename,value.binary);
	}
	await fs.writeFile(path.join(outDir,"release.json"),JSON.stringify(metadata,null,"\t")+"\n");
	console.log("Full native Vienna:",tiles.size,"tiles,",lod21Parts,"verified original roof parts,",bytes,"bytes");
	return metadata;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	if(process.argv.length!==4){
		throw new Error("Usage: assemble-regions.mjs REGION_ARTIFACTS_DIR OUTPUT_DIR");
	}
	const inventory=JSON.parse(await fs.readFile(new URL("./roof-inventory.snapshot.json",import.meta.url)));
	assembleCityRelease({inventory,regionsDir:path.resolve(process.argv[2]),
		outDir:path.resolve(process.argv[3])}).catch(e=>{
		console.error(e?.stack||e);process.exitCode=1;
	});
}
