#!/usr/bin/env node
/**
 * One independently auditable 8x8 Z15 city region with four 4x4 geometric
 * quadrants. Original CityGML files are downloaded ONCE in 16 short jobs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

export function makeRegionPlan(inventory,regionId) {
	if(inventory?.schemaVersion!==1 || inventory.coverage?.tiles<600
		|| typeof regionId!=="string" || !/^\d+-\d+$/.test(regionId)) {
		throw new Error("Invalid whole-Wien FMZK source grid or region ID");
	}
	const region=inventory.regions?.find(x=>x.id===regionId);
	if(!region)throw new Error("Unknown audited Vienna region "+regionId);
	const currentKeys=new Set(inventory.regions.flatMap(x=>x.tileKeys));
	const uniqueKeys=[...new Set(region.tileKeys)].sort();
	const sheets=[...new Set(region.sheets)].sort();
	if(uniqueKeys.length!==region.tileKeys.length ||
		sheets.length!==region.sheets.length ||
		!uniqueKeys.length || uniqueKeys.length>64 ||
		sheets.length<5 || sheets.length>250 ||
		uniqueKeys.some(key=>!currentKeys.has(key)||!/^15\/\d+\/\d+$/.test(key)) ||
		sheets.some(sheet=>!/^[0-9]{6}$/.test(sheet))) {
		throw new Error("Invalid or incomplete city-sector sheet source dependency");
	}
	const quadrants=new Map();
	for(const key of uniqueKeys) {
		const [,x,y]=key.split("/").map(Number);
		const id=Math.floor(x/4)+"-"+Math.floor(y/4);
		if(!quadrants.has(id))quadrants.set(id,[]);
		quadrants.get(id).push(key);
	}
	if(quadrants.size>4 || quadrants.size<1){
		throw new Error("Audited 8x8 region intersects too many 4x4 quadrants");
	}
	return {
		schemaVersion:1,region:regionId,
		fmzkRelease:inventory.sourceRelease,
		tiles:uniqueKeys,sourceSheets:sheets,
		quadrants:[...quadrants].sort((a,b)=>a[0].localeCompare(b[0]))
			.map(([id,tiles])=>({id,tileKeys:tiles.sort()})),
		targets:{schemaVersion:1,buildings:sheets.map(sheet=>({sheet}))}
	};
}

async function main(){
	const argv=process.argv.slice(2);
	if(argv.length!==4 || argv[0]!=="--region" || argv[2]!=="--out"){
		throw new Error("Usage: region-plan.mjs --region 2234-1420 --out directory");
	}
	const inventory=JSON.parse(await fs.readFile(new URL("./roof-inventory.snapshot.json",import.meta.url)));
	const plan=makeRegionPlan(inventory,argv[1]);
	const output=path.resolve(argv[3]);
	await fs.mkdir(output,{recursive:true});
	await fs.writeFile(path.join(output,"plan.json"),JSON.stringify({
		...plan,targets:undefined
	},null,"\t")+"\n");
	await fs.writeFile(path.join(output,"sources.json"),
		JSON.stringify(plan.targets,null,"\t")+"\n");
	console.log("Region",plan.region,plan.tiles.length,"Z15 tiles",
		plan.quadrants.length,"independent geometric quadrants",
		plan.sourceSheets.length,"original CityGML sheets");
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
	main().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
