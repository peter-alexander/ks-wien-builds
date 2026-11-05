#!/usr/bin/env node
/**
 * Create retry matrices from per-shard download reports. Only unresolved
 * shards use a fresh runner. A no-op sentinel avoids an empty matrix.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

export function planRepairShards(shards,reports,previous=[]){
	const expected=new Set(shards.map(x=>x.shard));
	if(expected.size!==shards.length||!expected.size)
		throw new Error("Invalid original source shard plan");
	const retry=[];
	for(const shard of shards){
		const current=reports.get(shard.shard)??previous.find(x=>x.shard===shard.shard)?.report;
		if(!current || current.requested!==shard.sheetCount ||
			!Array.isArray(current.failed)||!Number.isSafeInteger(current.skipped))
			throw new Error("Incomplete CityGML receipt for shard "+shard.shard);
		if(current.failed.length || current.skipped)retry.push({shard:shard.shard});
	}
	return {include:retry.length?retry:[{shard:-1}],pending:retry.length};
}
export async function createRepairPlan({root,reportsDir,previousDir=null,outFile}={}){
	const plan=JSON.parse(await fs.readFile(path.join(root,"shards.json"),"utf8"));
	const current=new Map();
	const readReports=async dir=>{
		const found=new Map();
		if(!dir)return found;
		for(const file of await fs.readdir(dir).catch(e=>{
			if(e.code==="ENOENT")return [];throw e;
		})){
			const hit=/^shard-(\d+)\.json$/.exec(file);
			if(!hit)continue;
			found.set(Number(hit[1]),JSON.parse(await fs.readFile(path.join(dir,file),"utf8")));
		}
		return found;
	};
	const prior=await readReports(previousDir);
	const latest=await readReports(reportsDir);
	for(const item of plan.shards){
		current.set(item.shard,latest.get(item.shard)??prior.get(item.shard));
	}
	const result=planRepairShards(plan.shards,current);
	await fs.mkdir(path.dirname(outFile),{recursive:true});
	await fs.writeFile(outFile,JSON.stringify(result,null,"\t")+"\n");
	console.log("Unresolved original CityGML shards:",result.pending,"of",plan.shards.length);
	return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	const [root,reportsDir,previousDir,outFile]=process.argv.slice(2);
	createRepairPlan({root,reportsDir,previousDir:previousDir==="-"?null:previousDir,outFile})
		.catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
