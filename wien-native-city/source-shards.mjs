#!/usr/bin/env node
/**
 * Plan bounded independent original-CityGML download shards per 8x8 region.
 * Each source sheet is assigned exactly once within the region.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {splitSheets} from "../wien-lod21/split-download-manifest.mjs";
import {selectedSheets} from "../wien-lod21/download-sheets.mjs";

export const SHARD_SIZE=6;
export function planSourceShards(sheets,size=SHARD_SIZE){
	if(!Array.isArray(sheets)||sheets.length===0||!Number.isSafeInteger(size)||size<1||size>6)
		throw new Error("Invalid CityGML six-sheet shard plan");
	const count=Math.ceil(sheets.length/size);
	if(count>64)throw new Error("More than 64 CityGML source shards for one 8x8 region");
	const shards=Array.from({length:count},(_,i)=>({
		shard:i,sheets:splitSheets(sheets,i,count)
	}));
	if(shards.some(shard=>!shard.sheets.length||shard.sheets.length>size) ||
		new Set(shards.flatMap(shard=>shard.sheets)).size!==sheets.length)
		throw new Error("Missing or duplicated source sheets in shard partition");
	return shards;
}
export async function writeSourceShards({regionRoot,shard=null}={}){
	if(!regionRoot)throw new Error("Missing audited region root");
	const root=path.resolve(regionRoot);
	const source=JSON.parse(await fs.readFile(path.join(root,"sources.json"),"utf8"));
	const shards=planSourceShards(selectedSheets(source));
	if(shard===null){
		const result={schemaVersion:1,size:SHARD_SIZE,shards:shards.map(x=>({
			shard:x.shard,sheetCount:x.sheets.length
		}))};
		await fs.writeFile(path.join(root,"shards.json"),JSON.stringify(result,null,"\t")+"\n");
		console.log(JSON.stringify({shards:shards.length,sheets:selectedSheets(source).length}));
		return result;
	}
	const entry=shards.find(x=>x.shard===shard);
	if(!entry)throw new Error("Unexpected source shard "+shard);
	const target=path.join(root,"shard-"+shard);
	await fs.mkdir(target,{recursive:true});
	const manifest={schemaVersion:1,buildings:entry.sheets.map(sheet=>({sheet}))};
	await fs.writeFile(path.join(target,"targets.json"),JSON.stringify(manifest,null,"\t")+"\n");
	console.log("Region source shard",shard,"/",shards.length,entry.sheets.join(","));
	return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	const [regionRoot,shard]=process.argv.slice(2);
	writeSourceShards({regionRoot,shard:shard===undefined?null:Number(shard)})
		.catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
