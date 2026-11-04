#!/usr/bin/env node
/**
 * Persist compact, verified original-CityGML source revisions, not ZIP bytes.
 * The published release stores this state; the ZIPs may be discarded AFTER
 * every tile using the sources has been successfully rebuilt and published.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {selectedSheets} from "../wien-lod21/download-sheets.mjs";

export async function collectSourceState({manifest,sourceDir,readFile=fs.readFile}={}){
	if(!manifest||!sourceDir)throw new Error("Missing source manifest or downloaded original CityGML folder");
	const sheets=selectedSheets(manifest);
	const sources={};
	for(const sheet of sheets){
		const prefix=path.join(sourceDir,sheet+"_lod2_gml.zip");
		const archive=await readFile(prefix).catch(error=>{
			if(error?.code==="ENOENT")return null;
			throw error;
		});
		if(archive){
			const metadata=JSON.parse(await readFile(prefix+".http.json","utf8"));
			if(metadata.schemaVersion!==1 || metadata.sheet!==sheet ||
				!/^[a-f0-9]{64}$/.test(metadata.sha256||"")) {
				throw new Error("Source archive has no valid SHA256 metadata: "+sheet);
			}
			const sha256=createHash("sha256").update(archive).digest("hex");
			if(sha256!==metadata.sha256)throw new Error("CityGML ZIP changed without version record: "+sheet);
			sources[sheet]={
				status:"present",
				etag:metadata.etag||null,
				lastModified:metadata.lastModified||null,
				contentLength:metadata.contentLength||null,
				sha256
			};
		}else{
			const missing=JSON.parse(await readFile(prefix+".missing.json","utf8"));
			if(missing.sheet!==sheet || missing.httpStatus!==404 ||
				missing.status!=="confirmed-missing" ||
				!Number.isFinite(Date.parse(missing.checkedAt))) {
				throw new Error("Unverified missing original CityGML source: "+sheet);
			}
			sources[sheet]={status:"missing",httpStatus:404,checkedAt:missing.checkedAt};
		}
	}
	if(Object.keys(sources).length!==sheets.length)throw new Error("Unaccounted original CityGML archive");
	return {schemaVersion:1,source:"Stadt Wien / MA41 original LOD2.1 CityGML ZIP",
		sheetCount:sheets.length,verifiedAt:new Date().toISOString(),sources};
}

if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
	if(process.argv.length!==5)throw new Error("Usage: source-state.mjs sources.json download-folder output.json");
	const [, ,manifestFile,downloadFolder,outputFile]=process.argv;
	const report=await collectSourceState({
		manifest:JSON.parse(await fs.readFile(manifestFile,"utf8")),
		sourceDir:downloadFolder
	});
	await fs.mkdir(path.dirname(outputFile),{recursive:true});
	await fs.writeFile(outputFile,JSON.stringify(report,null,"\t")+"\n");
	console.log("Verified",report.sheetCount,"CityGML source revisions:",
		Object.values(report.sources).filter(x=>x.status==="missing").length,"HTTP-404 missing");
}
