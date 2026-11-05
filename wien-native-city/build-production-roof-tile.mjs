#!/usr/bin/env node
/** Build one bounded Z15 quadrant, preserving only geometrically matched original roofs. */
import path from "node:path";
import {buildPilot} from "../wien-native-pilot/build.mjs";

export async function buildProductionRoofTile({
	outputDir,tileKeys,roofDirectory=null,roofTargets=null
}={}){
	if(!outputDir||!Array.isArray(tileKeys)||!tileKeys.length ||
		tileKeys.some(key=>!/^15\/\d+\/\d+$/.test(key)) ||
		Boolean(roofDirectory)!==Boolean(roofTargets)){
		throw new Error("Invalid production CityGML quadrant inputs");
	}
	return buildPilot({outputDir,tileKeys,fmzkOnly:!roofDirectory,
		localRoofDirectory:roofDirectory||"",localRoofTargets:roofTargets||""});
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
	const [outputDir,keys,roofDirectory,roofTargets]=process.argv.slice(2);
	buildProductionRoofTile({outputDir,tileKeys:JSON.parse(keys),
		roofDirectory,roofTargets}).catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
