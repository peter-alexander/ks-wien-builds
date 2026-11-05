#!/usr/bin/env node
/**
 * Fail closed before a gh-pages publication unexpectedly discards verified
 * original roof geometry from the last complete native Vienna release.
 * A real source change may legitimately remove roofs, but a large reduction
 * requires inspection, not an automatic destructive commit.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

export function validateProductionDelta(previous,current){
	if(current?.format!=="KSWN0001" ||
		!Number.isSafeInteger(current.publishedTileCount) ||
		current.publishedTileCount<600 ||
		!Number.isSafeInteger(current.lod21Parts) ||
		current.lod21Parts<1000 ||
		!Number.isSafeInteger(current.buildingParts) ||
		current.buildingParts<200000){
		throw new Error("Incomplete or suspicious new native building release");
	}
	if(!previous)return {status:"first-native-release",roofParts:current.lod21Parts};
	if(previous.format!=="KSWN0001" ||
		!Number.isSafeInteger(previous.lod21Parts) ||
		previous.lod21Parts<1000) {
		throw new Error("Previous native roof release cannot be verified");
	}
	const exactFmzk=previous.fmzkRelease===current.fmzkRelease;
	const minimumRatio=exactFmzk?0.85:0.60;
	const minimum=Math.floor(previous.lod21Parts*minimumRatio);
	if(current.lod21Parts<minimum)throw new Error(
		"Large unexplained loss of previously verified historical roofs: "+
		previous.lod21Parts+" -> "+current.lod21Parts+
		"; stop before publishing and audit changed CityGML matches"
	);
	return {status:"verified",sameFmzk:exactFmzk,
		oldRoofParts:previous.lod21Parts,newRoofParts:current.lod21Parts};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	const [oldFile,newFile]=process.argv.slice(2);
	if(!newFile)throw new Error("Usage: validate-production-delta.mjs [OLD_Z15_RELEASE] NEW_Z15_RELEASE");
	const load=async file=>file?JSON.parse(await fs.readFile(file,"utf8")):null;
	(async()=>{
		const previous=oldFile==="-"?null:await load(oldFile);
		const current=await load(newFile);
		console.log(JSON.stringify(validateProductionDelta(previous,current)));
	})().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
