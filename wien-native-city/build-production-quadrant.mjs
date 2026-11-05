#!/usr/bin/env node
/**
 * One bounded 4x4 FMZK/CityGML native geometry quadrant from a pinned,
 * same-run local FMZK snapshot. Spawned separately to bound peak memory.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {collectCurrentGroups,matchCityGml}
	from "../wien-native-pilot/build-roof-targets.mjs";
import {buildPilot} from "../wien-native-pilot/build.mjs";

export async function buildQuadrant({regionRoot,index}={}){
	if(typeof regionRoot!=="string" || !Number.isInteger(index)||index<0||index>3)
		throw new Error("Invalid native quadrant build");
	const root=path.resolve(regionRoot);
	const plan=JSON.parse(await fs.readFile(path.join(root,"plan.json"),"utf8"));
	const quadrant=plan.quadrants[index];
	if(!quadrant)throw new Error("Quadrant not in current FMZK region");
	const out=path.join(root,"quadrant-"+index);
	await fs.mkdir(out,{recursive:true});
	const groups=await collectCurrentGroups({keys:quadrant.tileKeys});
	const matched=await matchCityGml({
		groups,sourceDir:path.join(root,"source"),
		targetsFile:path.join(out,"roof-targets.json"),
		auditFile:path.join(out,"roof-matching-audit.json")
	});
	console.log("Quadrant",quadrant.id,"matching original roofs:",matched.targets.length);
	return {out,quadrant,targets:matched.targets.length};
}

if(process.argv[1] && path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
	const [root,index]=process.argv.slice(2);
	buildQuadrant({regionRoot:root,index:Number(index)}).catch(error=>{
		console.error(error?.stack||error);process.exitCode=1;
	});
}
