#!/usr/bin/env node
/**
 * Rehydrate an unchanged region from its verified deployed binary tiles.
 * Only allowed if BOTH the complete current FMZK source AND original CityGML
 * sources and geometry-builder revision match the previous release.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {sourceChanged} from "./incremental-plan.mjs";
import {currentNativeBuilderRevision} from "./assemble-regions.mjs";
import {readNativeTile} from "./native-tile-patch.mjs";

const BASE="https://peter-alexander.github.io/ks-wien-builds/WienBuildings";
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
async function fetchVerifiedTile(key,entry,fetchImpl=fetch){
	if(!/^15\/\d+\/\d+$/.test(key) || !/^[a-f0-9]{64}$/.test(entry?.sha256||""))
		throw new Error("Unverifiable published native tile "+key);
	const url=BASE+"/tiles/"+key+".bin.gz";
	let error;
	for(let attempt=0;attempt<3;attempt++){
		try{
			const ctrl=new AbortController();
			const timeout=setTimeout(()=>ctrl.abort(),60000);
			let response;
			try{response=await fetchImpl(url,{signal:ctrl.signal,cache:"no-store"});}
			finally{clearTimeout(timeout);}
			if(!response.ok)throw new Error("HTTP "+response.status+" "+key);
			const content=Buffer.from(await response.arrayBuffer());
			if(content.length!==entry.gzipBytes||sha256(content)!==entry.sha256)
				throw new Error("Published native geometry digest mismatch "+key);
			const decoded=readNativeTile(content);
			if(decoded.parts.length!==entry.buildingParts ||
				decoded.parts.filter(p=>p.info.source==="lod21").length!==entry.lod21Parts)
				throw new Error("Previously published tile failed native decoder "+key);
			return content;
		}catch(e){error=e;}
	}
	throw new Error("Cannot safely reuse "+key+": "+error);
}
export async function reuseProductionRegion({
	regionRoot,oldReleaseFile,allowReuse=false,fetchImpl=fetch
}={}){
	if(!allowReuse)return false;
	const root=path.resolve(regionRoot);
	const old=JSON.parse(await fs.readFile(oldReleaseFile,"utf8"));
	const plan=JSON.parse(await fs.readFile(path.join(root,"plan.json"),"utf8"));
	const state=JSON.parse(await fs.readFile(path.join(root,"source-state.json"),"utf8"));
	if(old?.format!=="KSWN0001" ||
		old.fmzkRelease!==plan.fmzkRelease ||
		old.buildRevision!==await currentNativeBuilderRevision() ||
		old.publishedTileCount<600 ||
		old.dependencyIndex?.tileKeys?.length!==old.publishedTileCount)
		return false;
	if(state?.schemaVersion!==1||state.sheetCount!==plan.sourceSheets.length ||
		plan.sourceSheets.some(sheet=>!state.sources?.[sheet] ||
			sourceChanged(old.sources?.[sheet],state.sources[sheet])))
		return false;
	const tileMap=new Map();
	for(const key of plan.tiles){
		const metric=old.tiles?.[key];
		if(!metric)return false;
		tileMap.set(key,metric);
	}
	const out=path.join(root,"NativeRegion");
	const report={schemaVersion:2,format:"KSWN0001",region:plan.region,
		sourceRelease:plan.fmzkRelease,sourceSheetCount:plan.sourceSheets.length,
		tiles:{},parts:0,roofs:0,gzipBytes:0};
	// Reuse is still an auditable build: every byte is checked against the
	// previous release before it can participate in the new final index.
	for(const [key,metric] of tileMap){
		const binary=await fetchVerifiedTile(key,metric,fetchImpl);
		const dest=path.join(out,"tiles",key+".bin.gz");
		await fs.mkdir(path.dirname(dest),{recursive:true});
		await fs.writeFile(dest,binary);
		report.tiles[key]={...metric};
		report.parts+=metric.buildingParts;
		report.roofs+=metric.lod21Parts;
		report.gzipBytes+=metric.gzipBytes;
	}
	await fs.copyFile(path.join(root,"source-state.json"),path.join(out,"source-state.json"));
	await fs.writeFile(path.join(out,"manifest.json"),JSON.stringify(report,null,"\t")+"\n");
	console.log("Reused verified unchanged native region:",plan.region,plan.tiles.length,"tiles");
	return true;
}
