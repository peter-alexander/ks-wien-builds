#!/usr/bin/env node
/**
 * Inspect real, already triangulated Z15 KSWN0001 region tiles.
 * Detect unstable IDs and differing absolute-world DEM anchors across tiles.
 * Exercise an actual binary patch without modifying the source artifact.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {readNativeTile,writeNativeTile,patchNativeTile,groupKey,NATIVE_EXTENT} from "./native-tile-patch.mjs";

const sha256=buffer=>createHash("sha256").update(buffer).digest("hex");
const keyOf=(record)=>{
	if(record.source==="lod1") {
		const match=/^ogd:(.+):([0-9]+)$/.exec(record.id);
		if(!match || !match[1] || match[1].startsWith("legacy-")) {
			throw new Error("FMZK part has no stable KS_ID: "+record.id);
		}
		return "lod1:ogd:"+match[1];
	}
	if(!record.sourceSheets?.length)throw new Error("Missing original CityGML lineage");
	return groupKey(record);
};

export async function auditNativeRegion(root,{readFile=fs.readFile}={}){
	const manifest=JSON.parse(await readFile(path.join(root,"manifest.json"),"utf8"));
	if(manifest.schemaVersion!==2 || manifest.format!=="KSWN0001")throw new Error("Unsupported native region manifest");
	const identities=new Map();
	let parts=0,roofs=0,bytes=0;
	let patchVerified=false;
	const examples=[];
	for(const [key,metric] of Object.entries(manifest.tiles)){
		if(!/^15\/[0-9]+\/[0-9]+$/.test(key))throw new Error("Invalid Z15 tile key "+key);
		const [,x,y]=key.split("/").map(Number);
		const encoded=await readFile(path.join(root,"tiles",key+".bin.gz"));
		if(sha256(encoded)!==metric.sha256)throw new Error("Tile checksum mismatch "+key);
		const tile=readNativeTile(encoded);
		if(tile.parts.length!==metric.buildingParts)throw new Error("Tile count mismatch "+key);
		bytes+=encoded.length;
		let roofCount=0;
		const local=new Set();
		for(const part of tile.parts){
			parts++;
			const partKey=groupKey(part.info);
			local.add(partKey);
			if(part.info.source==="lod21")roofCount++;
			const id=keyOf(part.info);
			const worldX=x*NATIVE_EXTENT+part.info.anchorX;
			const worldY=y*NATIVE_EXTENT+part.info.anchorY;
			const entry=identities.get(id)||{tiles:new Set(),anchors:[],partKeys:new Set()};
			entry.tiles.add(key);
			entry.partKeys.add(partKey);
			entry.anchors.push({tile:key,x:worldX,y:worldY});
			identities.set(id,entry);
		}
		if(roofCount!==metric.lod21Parts)throw new Error("Roof count mismatch "+key);
		roofs+=roofCount;
		if(!patchVerified && tile.parts.length>=2 && local.size>=2){
			// A historical building may legitimately consist of multiple parts
			// with the SAME logical building ID. Replace its entire group.
			const selectedKey=groupKey(tile.parts[0].info);
			const oldGroup=tile.parts.filter(part=>groupKey(part.info)===selectedKey);
			const replacements=oldGroup.map(part=>({
				info:structuredClone(part.info),
				vertices:Buffer.from(part.vertices),
				indices:Buffer.from(part.indices)
			}));
			const height=replacements[0].vertices.readUInt16LE(4);
			replacements[0].vertices.writeUInt16LE((height+1)%65536,4);
			const modified=writeNativeTile(replacements);
			const updated=patchNativeTile({base:encoded,replacements:modified.compressed,
				invalidate:[selectedKey]});
			const result=readNativeTile(updated.compressed);
			if(result.parts.length!==tile.parts.length)throw new Error("Real tile patch lost building parts");
			const oldUnchanged=tile.parts.filter(part=>groupKey(part.info)!==selectedKey);
			const newUnchanged=result.parts.filter(part=>groupKey(part.info)!==selectedKey);
			if(oldUnchanged.length!==newUnchanged.length)throw new Error("Real tile patch lost an unrelated building");
			for(let i=0;i<oldUnchanged.length;i++){
				if(groupKey(oldUnchanged[i].info)!==groupKey(newUnchanged[i].info)
					|| !oldUnchanged[i].vertices.equals(newUnchanged[i].vertices)
					|| !oldUnchanged[i].indices.equals(newUnchanged[i].indices)){
					throw new Error("Unchanged building was remeshed by patch");
				}
			}
			const newGroup=result.parts.filter(part=>groupKey(part.info)===selectedKey);
			if(newGroup.length!==oldGroup.length
				||newGroup[0].vertices.equals(oldGroup[0].vertices)){
				throw new Error("Group replacement did not preserve all parts and change intended geometry");
			}
			patchVerified=true;
		}
	}
	if(parts!==manifest.parts || roofs!==manifest.roofs || bytes!==manifest.gzipBytes){
		throw new Error("Region manifest global totals do not match tile contents");
	}
	let crossTile=0,anchorDisagreements=0,maxAnchorDelta=0;
	for(const [id,entry] of identities){
		if(entry.tiles.size<2)continue;
		crossTile++;
		const first=entry.anchors[0];
		const maxDelta=Math.max(...entry.anchors.map(a=>Math.hypot(a.x-first.x,a.y-first.y)));
		maxAnchorDelta=Math.max(maxAnchorDelta,maxDelta);
		// Tile-unit coordinates can differ slightly from floating-point rounding.
		if(maxDelta>1){
			anchorDisagreements++;
			if(examples.length<25)examples.push({id,tiles:[...entry.tiles],anchorDeltaTileUnits:maxDelta});
		}
	}
	return {schemaVersion:1,region:manifest.region,tiles:Object.keys(manifest.tiles).length,
		parts,roofs,bytes,identities:identities.size,crossTileIdentities:crossTile,
		anchorDisagreements,maxAnchorDeltaTileUnits:maxAnchorDelta,
		realTilePatchVerified:patchVerified,examples};
}

if(process.argv[1] && path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
	const root=path.resolve(process.argv[2]||"");
	const output=path.resolve(process.argv[3]||"native-region-audit.json");
	auditNativeRegion(root).then(async report=>{
		await fs.mkdir(path.dirname(output),{recursive:true});
		await fs.writeFile(output,JSON.stringify(report,null,"\\t")+"\\n");
		console.log(JSON.stringify(report));
		if(!report.realTilePatchVerified)throw new Error("No real populated tile available for patch validation");
	}).catch(error=>{console.error(error);process.exitCode=1;});
}
