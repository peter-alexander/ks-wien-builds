#!/usr/bin/env node
/**
 * Bounded, restartable controller for the 18 independent Vienna Z15 regions.
 * Exactly one regional workflow at a time: the regional workflow itself
 * keeps at most four CityGML download jobs in flight.
 *
 * Reuses the verified first region; never publishes to gh-pages.
 */
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {setTimeout as sleep} from "node:timers/promises";

export const VERIFIED_REGION="2234-1420";
export const VERIFIED_RUN=41900416698;
const WORKFLOW="wien-native-region.yml";
const ROOT=path.dirname(fileURLToPath(import.meta.url));

function inventory(){
	return JSON.parse(fs.readFileSync(path.join(ROOT,"roof-inventory.snapshot.json"),"utf8"));
}
export function pendingCityRegions(data){
	if(data?.coverage?.tiles!==678 || data?.regions?.length!==18 ||
		!data.regions.some(region=>region.id===VERIFIED_REGION) ||
		new Set(data.regions.map(region=>region.id)).size!==18 ||
		new Set(data.regions.flatMap(region=>region.tileKeys)).size!==678){
		throw new Error("Unverified citywide original-FMZK 678-tile inventory");
	}
	return data.regions.map(region=>region.id).filter(id=>id!==VERIFIED_REGION);
}
export function validateReceipts(data,receipts,{sha}={}){
	const pending=pendingCityRegions(data);
	const found=new Map();
	for(const receipt of receipts){
		if(!receipt || !pending.includes(receipt.region) ||
			!Number.isSafeInteger(receipt.runId) || receipt.runId<=0 ||
			(sha && receipt.sha!==sha) || found.has(receipt.region)){
			throw new Error("Invalid, duplicate, or unexpected Vienna region receipt");
		}
		found.set(receipt.region,receipt);
	}
	if(found.size!==pending.length)throw new Error(
		"Citywide assembly blocked: missing successful regional receipts ("+
		found.size+"/"+pending.length+")");
	return new Map([[VERIFIED_REGION,VERIFIED_RUN],
		...pending.map(id=>[id,found.get(id).runId])]);
}
function gh(args){
	const stdout=execFileSync("gh",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],
		env:process.env,maxBuffer:16*1024*1024});
	return stdout.trim();
}
function ghJson(args){return JSON.parse(gh(args));}
function validRegion(id){
	if(!pendingCityRegions(inventory()).includes(id))throw new Error("Unknown/unplanned region "+id);
}
async function watchRegion(id,{repository,sha,receiptDir}){
	validRegion(id);
	if(!repository || !/^[^/]+\/[^/]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)){
		throw new Error("Explicit repository and pinned git revision required");
	}
	const targetName="Z15 Vienna region "+id;
	const launched=Date.now();
	gh(["workflow","run",WORKFLOW,"--repo",repository,"--ref","main","--field","region="+id]);
	console.log("Dispatched "+id+"; waiting for matching, pinned region workflow.");
	let runId=null;
	const deadline=Date.now()+100*60*1000;
	while(Date.now()<deadline){
		if(runId===null){
			const list=ghJson(["run","list","--repo",repository,"--workflow",WORKFLOW,
				"--limit","100","--json","databaseId,displayTitle,headSha,createdAt,status,conclusion"]);
			const matches=list.filter(run=>
				run.displayTitle===targetName &&
				run.headSha===sha &&
				Date.parse(run.createdAt)>=launched-10000
			).sort((a,b)=>b.databaseId-a.databaseId);
			if(matches.length>0){
				runId=matches[0].databaseId;
				console.log("Region "+id+" run "+runId);
			}
		}else{
			const run=ghJson(["run","view",String(runId),"--repo",repository,
				"--json","status,conclusion,headSha,displayTitle"]);
			if(run.headSha!==sha || run.displayTitle!==targetName){
				throw new Error("Unexpected source revision or region run identity");
			}
			if(run.status==="completed"){
				if(run.conclusion!=="success")throw new Error("Regional build failed: "+id+
					" ("+run.conclusion+") run "+runId);
				fs.mkdirSync(receiptDir,{recursive:true});
				fs.writeFileSync(path.join(receiptDir,id+".json"),
					JSON.stringify({region:id,runId,sha},null,"\t")+"\n");
				console.log("Region successful: "+id+" run "+runId);
				return;
			}
		}
		await sleep(25000);
	}
	throw new Error("Regional workflow not completed within 100 minutes: "+id);
}
function loadReceipts(folder){
	return fs.readdirSync(folder).filter(name=>name.endsWith(".json"))
		.map(name=>JSON.parse(fs.readFileSync(path.join(folder,name),"utf8")));
}
function downloadRegions({receiptsDir,regionsDir,repository,sha}){
	const runs=validateReceipts(inventory(),loadReceipts(receiptsDir),{sha});
	for(const [id,runId] of runs){
		const remote=ghJson(["run","view",String(runId),"--repo",repository,
			"--json","status,conclusion"]);
		if(remote.status!=="completed"||remote.conclusion!=="success"){
			throw new Error("Regional artifact run was not successful: "+id);
		}
		const folder=path.join(regionsDir,"wien-native-roof-region-"+id);
		fs.mkdirSync(folder,{recursive:true});
		gh(["run","download",String(runId),"--repo",repository,
			"--name","wien-native-roof-region-"+id,"--dir",folder]);
		if(!fs.existsSync(path.join(folder,"manifest.json")) ||
			!fs.existsSync(path.join(folder,"source-state.json"))){
			throw new Error("Missing verified regional metadata: "+id);
		}
		console.log("Region artifact verified: "+id+" ("+runId+")");
	}
}
async function main(){
	const command=process.argv[2];
	if(command==="plan"){
		const planned=pendingCityRegions(inventory());
		console.log("regions="+JSON.stringify(planned));
		console.error("Planning "+planned.length+" remaining regions; verified "+VERIFIED_REGION+
			" will be reused from run "+VERIFIED_RUN);
	}else if(command==="watch"){
		const id=process.argv[3];
		await watchRegion(id,{repository:process.env.GITHUB_REPOSITORY,
			sha:process.env.GITHUB_SHA,receiptDir:process.argv[4]});
	}else if(command==="download"){
		downloadRegions({receiptsDir:process.argv[3],regionsDir:process.argv[4],
			repository:process.env.GITHUB_REPOSITORY,sha:process.env.GITHUB_SHA});
	}else throw new Error("Usage: city-run-controller.mjs plan|watch ID RECEIPTS_DIR|download RECEIPTS_DIR REGIONS_DIR");
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	main().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});
}
