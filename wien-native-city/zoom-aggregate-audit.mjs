#!/usr/bin/env node
/**
 * Measure what changes when pretriangulated Z15 native buildings are combined
 * to Z14 and Z13. This is a read-only geometry audit, not yet a LOD renderer.
 *
 * Parent tiles must NOT simply copy child tile coordinates: each quantized
 * child position has to be transformed to the parent's extent. Cross-tile
 * building parts must be checked for duplicates and source consistency.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {readNativeTile,NATIVE_EXTENT} from "./native-tile-patch.mjs";
import {logicalNativeBuildingId} from "./canonical-native-anchors.mjs";

const STRIDE=16;
export function parentOfTile(key,zoom){
	const match=/^15\/([0-9]+)\/([0-9]+)$/.exec(key);
	if(!match || ![13,14].includes(zoom))throw new Error("Expected a Z15 source and Z13/Z14 target");
	const x=Number(match[1]),y=Number(match[2]);
	const shift=15-zoom,scale=2**shift;
	return `${zoom}/${Math.floor(x/scale)}/${Math.floor(y/scale)}`;
}
export function rebaseXY(bytes,vertex,childKey,zoom){
	const [,sx,sy]=childKey.split("/").map(Number);
	if(!Number.isSafeInteger(sx) || !Number.isSafeInteger(sy) || ![13,14].includes(zoom)){
		throw new Error("Unsupported native parent tile");
	}
	const scale=2**(15-zoom);
	const ox=(sx%scale)*NATIVE_EXTENT;
	const oy=(sy%scale)*NATIVE_EXTENT;
	const childX=bytes.readInt16LE(vertex*STRIDE)/4+NATIVE_EXTENT/2;
	const childY=bytes.readInt16LE(vertex*STRIDE+2)/4+NATIVE_EXTENT/2;
	return [(ox+childX)/scale,(oy+childY)/scale];
}
function primitiveBounds(part,key,zoom){
	const n=part.vertices.length/STRIDE;
	let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
	for(let i=0;i<n;i++){
		const [x,y]=rebaseXY(part.vertices,i,key,zoom);
		minX=Math.min(minX,x);maxX=Math.max(maxX,x);
		minY=Math.min(minY,y);maxY=Math.max(maxY,y);
	}
	return [minX,minY,maxX,maxY];
}
export async function auditParentGeometry(root,release,zoom,{sampleParentLimit=0}={}){
	if(![13,14].includes(zoom))throw new Error("Unsupported native parent zoom");
	const grouped=new Map();
	for(const [key,metric] of Object.entries(release.tiles)){
		const parent=parentOfTile(key,zoom);
		if(!grouped.has(parent))grouped.set(parent,[]);
		grouped.get(parent).push({key,metric});
	}
	const results=[];
	const chosen=[...grouped].sort((a,b)=>a[0].localeCompare(b[0]));
	for(const [parent,children] of sampleParentLimit?chosen.slice(0,sampleParentLimit):chosen){
		const identities=new Map();
		const seenGeometry=new Map();
		let parts=0,vertices=0,triangles=0,pitched=0,metadataBytes=0;
		let exceededBounds=0,duplicatesAcrossChildren=0;
		const groupsPerChild=[];
		for(const {key,metric} of children){
			const file=path.join(root,"tiles",key+".bin.gz");
			const buffer=await fs.readFile(file);
			if(buffer.length!==metric.gzipBytes)throw new Error("Source tile changed unexpectedly: "+key);
			const data=readNativeTile(buffer);
			let localGroups=0;
			for(const part of data.parts){
				const id=logicalNativeBuildingId(part.info);
				let list=identities.get(id);
				if(!list){list=new Set();identities.set(id,list);}
				else if(!list.has(key) && list.size)duplicatesAcrossChildren++;
				list.add(key);
				parts++;
				vertices+=part.vertices.length/STRIDE;
				triangles+=part.indices.length/12;
				if(part.info.source==="lod21")pitched++;
				metadataBytes+=Buffer.byteLength(JSON.stringify(part.info));
				const bounds=primitiveBounds(part,key,zoom);
				if(bounds.some((v,i)=>i<2?v<-0.5:v>NATIVE_EXTENT+0.5))exceededBounds++;
				const ident=part.info.source+":"+part.info.id;
				// A part can be genuinely clipped across child tiles; it must
				// not be removed just because the stable identity repeats.
				if(seenGeometry.has(ident) && seenGeometry.get(ident)!==key) localGroups++;
				seenGeometry.set(ident,key);
			}
			groupsPerChild.push(localGroups);
		}
		const rawEstimate=32+metadataBytes+vertices*STRIDE+triangles*12;
		results.push({parent,childTiles:children.length,parts,logicalBuildings:identities.size,
			vertices,triangles,pitched,metadataBytes,rawEstimate,
			rawExceeds16MiB:rawEstimate>=16*1024*1024,
			duplicateIdentities:duplicatesAcrossChildren,
			duplicatePartIdentifiers:groupsPerChild.reduce((a,b)=>a+b,0),
			outOfParentBounds:exceededBounds});
	}
	const totals=results.reduce((sum,x)=>{
		for(const key of ["childTiles","parts","logicalBuildings","vertices","triangles","pitched",
			"rawEstimate","duplicateIdentities","duplicatePartIdentifiers",
			"outOfParentBounds"]){sum[key]=(sum[key]||0)+x[key];}
		sum.overLimitParents=(sum.overLimitParents||0)+Number(x.rawExceeds16MiB);
		return sum;
	},{});
	return {schemaVersion:1,zoom,sourceTiles:Object.keys(release.tiles).length,
		parentTiles:grouped.size,auditedParents:results.length,
		totals,parents:results};
}
if(process.argv[1] && process.argv[1].endsWith("/zoom-aggregate-audit.mjs")){
	if(process.argv.length<5)throw new Error("Usage: zoom-aggregate-audit.mjs RELEASE_DIR ZOOM OUT_FILE [SAMPLE_PARENT_LIMIT]");
	const [root,zoom,outFile,limit]=process.argv.slice(2);
	const release=JSON.parse(await fs.readFile(path.join(root,"release.json"),"utf8"));
	const result=await auditParentGeometry(root,release,Number(zoom),
		{sampleParentLimit:Number(limit||0)});
	await fs.mkdir(path.dirname(outFile),{recursive:true});
	await fs.writeFile(outFile,JSON.stringify(result,null,"\t")+"\n");
	console.log(JSON.stringify({zoom:result.zoom,sourceTiles:result.sourceTiles,
		parentTiles:result.parentTiles,auditedParents:result.auditedParents,totals:result.totals}));
}
