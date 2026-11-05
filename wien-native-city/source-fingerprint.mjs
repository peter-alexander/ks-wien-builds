#!/usr/bin/env node
/**
 * Fingerprint one complete WFS export and decide whether pinned FMZK source
 * geometry can be reused. A build timestamp alone is NOT source versioning.
 * In an identical export, retain the previous FMZK source ID so unchanged
 * native Z13/Z14 and historical Z15 tiles can be combined safely.
 */
import fs from "node:fs/promises";
import {createReadStream} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {computeBuilderRevision} from "./incremental-plan.mjs";

const LOWZOOM_INPUTS=[
	"wien-native-city/build-lowzoom.mjs",
	"wien-native-city/build-lowzoom-city.mjs",
	"wien-native-city/native-chunks.mjs",
	"wien-native-city/native-tile-patch.mjs",
	"wien-native-pilot/build.mjs",
	"wien-optimized/src/app/buildings/wien-ogd-fallback-geometry.js"
];

async function sha256File(file){
	const hash=createHash("sha256");
	for await(const chunk of createReadStream(file))hash.update(chunk);
	return hash.digest("hex");
}
export async function fingerprintOfficialFmzk({
	geojsonFile,sourceReleaseFile,previousReleaseFile=null,outFile,codeRoot="."
}={}){
	if(!geojsonFile||!sourceReleaseFile||!outFile)throw new Error("Missing authoritative FMZK export");
	const release=JSON.parse(await fs.readFile(sourceReleaseFile,"utf8"));
	if(!Number.isFinite(Date.parse(release.generatedAt)) ||
		release.vectorTiles?.layer!=="wien_buildings" ||
		release.counts?.output<100000)
		throw new Error("Incomplete or malformed FMZK WFS export");
	const fmzkSourceSha256=await sha256File(geojsonFile);
	const code=[];
	for(const name of LOWZOOM_INPUTS){
		code.push({path:name,content:await fs.readFile(path.join(codeRoot,name),"utf8")});
	}
	const lowZoomBuilderRevision=computeBuilderRevision(code);
	let previous=null;
	if(previousReleaseFile){
		try{previous=JSON.parse(await fs.readFile(previousReleaseFile,"utf8"));}
		catch(error){if(error.code!=="ENOENT")throw error;}
	}
	const fmzkReuse=previous?.format==="KSWN0001" &&
		previous.fmzkSourceSha256===fmzkSourceSha256 &&
		typeof previous.fmzkRelease==="string" &&
		Number.isFinite(Date.parse(previous.fmzkRelease));
	const lowZoomReuse=Boolean(fmzkReuse &&
		previous.lowZoomBuilderRevision===lowZoomBuilderRevision);
	if(fmzkReuse)release.generatedAt=previous.fmzkRelease;
	release.fmzkSourceSha256=fmzkSourceSha256;
	release.lowZoomBuilderRevision=lowZoomBuilderRevision;
	await fs.writeFile(sourceReleaseFile,JSON.stringify(release,null,"\t")+"\n");
	const report={schemaVersion:1,fmzkSourceSha256,lowZoomBuilderRevision,
		fmzkReuse:Boolean(fmzkReuse),lowZoomReuse,
		fmzkRelease:release.generatedAt};
	await fs.mkdir(path.dirname(outFile),{recursive:true});
	await fs.writeFile(outFile,JSON.stringify(report,null,"\t")+"\n");
	console.log("FMZK source fingerprint:",JSON.stringify(report));
	return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
	const [geojsonFile,sourceReleaseFile,previousReleaseFile,outFile]=process.argv.slice(2);
	fingerprintOfficialFmzk({geojsonFile,sourceReleaseFile,previousReleaseFile,outFile})
		.catch(error=>{console.error(error?.stack||error);process.exitCode=1;});
}
