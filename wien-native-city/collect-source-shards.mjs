#!/usr/bin/env node
/**
 * Merge exactly one final, non-overlapping original CityGML source set per
 * region. Latest completed repair stage takes precedence for each shard.
 * Fail closed on unexpected filenames, missing shards or duplicate sheets.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {splitSheets} from "../wien-lod21/split-download-manifest.mjs";
import {selectedSheets} from "../wien-lod21/download-sheets.mjs";

const ZIP=/^(\d{6})_lod2_gml\.zip(?:\.http\.json|\.missing\.json)?$/;
export async function collectRegionSources({regionRoot,inputsDir}={}){
	const root=path.resolve(regionRoot),inputs=path.resolve(inputsDir);
	const manifest=JSON.parse(await fs.readFile(path.join(root,"sources.json"),"utf8"));
	const sources=selectedSheets(manifest);
	const shardPlan=JSON.parse(await fs.readFile(path.join(root,"shards.json"),"utf8"));
	const shards=shardPlan.shards;
	const destination=path.join(root,"downloads");
	await fs.mkdir(destination,{recursive:true});
	const accounted=new Set();
	for(const shard of shards){
		const expected=new Set(splitSheets(sources,shard.shard,shards.length));
		if(expected.size!==shard.sheetCount)throw new Error("Inconsistent original shard "+shard.shard);
		let chosen=null;
		for(const stage of [3,2,1]){
			const dir=path.join(inputs,
				"wien-region-"+path.basename(root).replace(/^region-/,"")+"-pass"+stage+"-"+shard.shard);
			try{
				const stat=await fs.stat(dir);
				if(stat.isDirectory()){chosen=dir;break;}
			}catch(e){if(e.code!=="ENOENT")throw e;}
		}
		if(!chosen)throw new Error("Missing all source downloads for shard "+shard.shard);
		const found=new Set();
		for(const file of await fs.readdir(chosen)){
			const hit=ZIP.exec(file);
			if(!hit)throw new Error("Unexpected original CityGML input "+file);
			const sheet=hit[1];
			if(!expected.has(sheet))throw new Error("Unexpected source sheet "+sheet);
			found.add(sheet);
			const dest=path.join(destination,file);
			await fs.copyFile(path.join(chosen,file),dest);
		}
		for(const sheet of expected){
			if(accounted.has(sheet))throw new Error("Duplicate original CityGML sheet "+sheet);
			accounted.add(sheet);
			if(!found.has(sheet))throw new Error("Unresolved original CityGML "+sheet+
				" in shard "+shard.shard);
		}
	}
	if(accounted.size!==sources.length)throw new Error("Incomplete regional CityGML input set");
	console.log("Collected",accounted.size,"disjoint source sheet entries across",
		shards.length,"short independent jobs");
	return accounted.size;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	const [regionRoot,inputsDir]=process.argv.slice(2);
	collectRegionSources({regionRoot,inputsDir}).catch(e=>{
		console.error(e?.stack||e);process.exitCode=1;
	});
}
