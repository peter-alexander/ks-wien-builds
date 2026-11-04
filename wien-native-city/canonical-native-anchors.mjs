/**
 * Reconcile DEM sample points for the same logical building across Z15 tiles.
 *
 * Region builders keep their already triangulated geometry. A complete release
 * has all tiles and can establish one deterministic world-space anchor for
 * every building. We store canonical anchors for groups with multiple parts,
 * so future incremental updates can reuse them without historical GML ZIPs.
 */
import {createHash} from "node:crypto";
import {readNativeTile,writeNativeTile,NATIVE_EXTENT} from "./native-tile-patch.mjs";

export function logicalNativeBuildingId(info){
	if(info?.source==="lod1"){
		const match=/^ogd:(.+):([0-9]+)$/.exec(info.id||"");
		if(!match || match[1].startsWith("legacy-"))throw new Error("No stable official FMZK KS_ID");
		return "lod1:ogd:"+match[1];
	}
	if(info?.source==="lod21" && typeof info.id==="string" && info.id.startsWith("lod21:")){
		if(!info.sourceSheets?.length)throw new Error("Historical roof has no source lineage");
		return "lod21:"+info.id;
	}
	throw new Error("Unknown native building source or identity");
}

function tileOrigin(key){
	const match=/^15\/([0-9]+)\/([0-9]+)$/.exec(key);
	if(!match)throw new Error("Invalid Z15 tile key "+key);
	return [Number(match[1])*NATIVE_EXTENT,Number(match[2])*NATIVE_EXTENT];
}

export function reconcileNativeAnchors(tiles){
	if(!(tiles instanceof Map)||!tiles.size)throw new Error("Native release has no tiles");
	const first=new Map(),multi=new Map();
	let affectedIdentities=0,anchorDisagreements=0;
	// Map iteration order is deterministic (audited inventory region/tile order).
	for(const [key,record] of tiles){
		const [ox,oy]=tileOrigin(key);
		for(const part of readNativeTile(record.binary).parts){
			const id=logicalNativeBuildingId(part.info);
			const world=[ox+part.info.anchorX,oy+part.info.anchorY];
			if(!first.has(id)){first.set(id,world);continue;}
			if(!multi.has(id)){multi.set(id,first.get(id));affectedIdentities++;}
			const old=first.get(id);
			if(Math.hypot(world[0]-old[0],world[1]-old[1])>0.001)anchorDisagreements++;
		}
	}
	const output=new Map();
	let correctedParts=0,changedTiles=0,totalBytes=0;
	for(const [key,record] of tiles){
		const [ox,oy]=tileOrigin(key);
		const parsed=readNativeTile(record.binary);
		let changed=false;
		for(const part of parsed.parts){
			const anchor=multi.get(logicalNativeBuildingId(part.info));
			if(!anchor)continue;
			const x=anchor[0]-ox,y=anchor[1]-oy;
			if(Math.hypot(part.info.anchorX-x,part.info.anchorY-y)>0.001){
				part.info.anchorX=x;
				part.info.anchorY=y;
				changed=true;
				correctedParts++;
			}
		}
		const binary=changed?writeNativeTile(parsed.parts).compressed:record.binary;
		if(changed)changedTiles++;
		totalBytes+=binary.length;
		output.set(key,{...record,binary,
			sha256:createHash("sha256").update(binary).digest("hex"),
			metric:{...record.metric,gzipBytes:binary.length}});
	}
	return {tiles:output,canonicalAnchors:Object.fromEntries([...multi].sort((a,b)=>a[0].localeCompare(b[0]))),
		affectedIdentities,anchorDisagreements,correctedParts,changedTiles,totalBytes};
}
