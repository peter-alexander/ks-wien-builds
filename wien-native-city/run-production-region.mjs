#!/usr/bin/env node
/**
 * Complete, repeatable native Z15 region from an immutable SAME-RUN FMZK
 * source snapshot and original CityGML sheets. No historical Action run IDs
 * and no deleted legacy GitHub Pages endpoints.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readNativeTile} from "./native-tile-patch.mjs";

function run(executable,args,env=process.env){
	const result=spawnSync(executable,args,{stdio:"inherit",env,maxBuffer:16*1024*1024});
	if(result.error)throw result.error;
	if(result.status!==0)throw new Error(executable+" failed (exit "+result.status+")");
}
function node(args){run(process.execPath,args);}
export async function assembleProductionRegion({regionRoot,region}={}){
	if(!/^\d+-\d+$/.test(region||""))throw new Error("Invalid Z15 region");
	const root=path.resolve(regionRoot);
	const plan=JSON.parse(await fs.readFile(path.join(root,"plan.json"),"utf8"));
	if(plan.region!==region||plan.tiles.length<1||plan.quadrants.length<1)
		throw new Error("Invalid current source region plan");
	const tiles=new Map();
	let parts=0,roofs=0,bytes=0;
	for(let i=0;i<plan.quadrants.length;i++){
		const quadrant=plan.quadrants[i];
		const dir=path.join(root,"quadrant-"+i,"Native");
		const manifest=JSON.parse(await fs.readFile(path.join(dir,"manifest.json"),"utf8"));
		if(manifest.sourceReleases?.lod1!==plan.fmzkRelease ||
			Object.keys(manifest.tiles).length!==quadrant.tileKeys.length)
			throw new Error("Mixed FMZK source or missing native quadrant "+i);
		for(const [key,metric] of Object.entries(manifest.tiles)){
			if(!quadrant.tileKeys.includes(key)||tiles.has(key))
				throw new Error("Unexpected or duplicate Z15 tile "+key);
			const input=await fs.readFile(path.join(dir,"tiles",key+".bin.gz"));
			const decoded=readNativeTile(input);
			const count=decoded.parts.filter(p=>p.info.source==="lod21").length;
			if(decoded.parts.length!==metric.buildingParts||count!==metric.lod21Parts ||
				decoded.parts.some(p=>p.info.source==="lod21"&&!p.info.sourceSheets?.length))
				throw new Error("Invalid independently decodable Z15 geometry "+key);
			tiles.set(key,{content:input,metric});
			parts+=decoded.parts.length;
			roofs+=count;
			bytes+=input.length;
		}
	}
	if(tiles.size!==plan.tiles.length||plan.tiles.some(key=>!tiles.has(key)))
		throw new Error("Incomplete official FMZK region geometry");
	const out=path.join(root,"NativeRegion");
	const manifest={schemaVersion:2,format:"KSWN0001",region,
		sourceRelease:plan.fmzkRelease,sourceSheetCount:plan.sourceSheets.length,
		tiles:{},parts,roofs,gzipBytes:bytes};
	for(const [key,{content,metric}] of tiles){
		const file=path.join(out,"tiles",key+".bin.gz");
		await fs.mkdir(path.dirname(file),{recursive:true});
		await fs.writeFile(file,content);
		manifest.tiles[key]={...metric,sha256:createHash("sha256").update(content).digest("hex")};
	}
	await fs.mkdir(out,{recursive:true});
	await fs.copyFile(path.join(root,"source-state.json"),path.join(out,"source-state.json"));
	await fs.writeFile(path.join(out,"manifest.json"),JSON.stringify(manifest,null,"\t")+"\n");
	console.log(JSON.stringify({region,tiles:tiles.size,parts,roofs,bytes}));
	return manifest;
}
async function main(){
	const region=process.argv[2],root=path.resolve(process.argv[3]||"");
	if(!/^\d+-\d+$/.test(region||"")||!process.argv[3])
		throw new Error("Usage: run-production-region.mjs REGION OUTPUT_DIRECTORY");
	node(["wien-native-city/region-plan.mjs","--region",region,"--out",root]);
	const targets=path.join(root,"sources.json");
	const downloads=path.join(root,"downloads");
	node(["wien-lod21/download-sheets.mjs","--targets",targets,
		"--cache-dir",downloads,"--summary",path.join(root,"download-report.json"),
		"--revalidate","strict","--missing-policy","confirmed-404",
		"--parallel","3","--interval-ms","1500","--attempts","4",
		"--threshold","3","--cooldown-ms","60000","--max-cooldowns","2",
		"--retry-ms","4000"]);
	node(["wien-native-city/source-state.mjs",targets,downloads,path.join(root,"source-state.json")]);
	const archiveNames=(await fs.readdir(downloads)).filter(x=>x.endsWith("_lod2_gml.zip"));
	const source=path.join(root,"source");
	await fs.mkdir(source,{recursive:true});
	for(const name of archiveNames){
		const file=path.join(downloads,name);
		run("unzip",["-tqq",file]);
		run("unzip",["-oq",file,"-d",source]);
	}
	const plan=JSON.parse(await fs.readFile(path.join(root,"plan.json"),"utf8"));
	for(let i=0;i<plan.quadrants.length;i++){
		node(["--max-old-space-size=4096","wien-native-city/build-production-quadrant.mjs",root,String(i)]);
		const dest=path.join(root,"quadrant-"+i);
		const roofTargets=path.join(dest,"roof-targets.json");
		const targetInfo=JSON.parse(await fs.readFile(roofTargets,"utf8"));
		const nativeDest=path.join(dest,"Native");
		const tileKeys=plan.quadrants[i].tileKeys;
		if(targetInfo.buildings?.length){
			const lod=path.join(dest,"LOD21");
			node(["--max-old-space-size=4096","--expose-gc","wien-lod21/build.mjs",
				"--input",source,"--output",lod,"--targets",roofTargets]);
			node(["--max-old-space-size=4096","wien-native-city/build-production-roof-tile.mjs",
				nativeDest,JSON.stringify(tileKeys),lod,roofTargets]);
		}else{
			node(["--max-old-space-size=4096","wien-native-city/build-production-roof-tile.mjs",
				nativeDest,JSON.stringify(tileKeys)]);
		}
	}
	await assembleProductionRegion({regionRoot:root,region});
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
	main().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
