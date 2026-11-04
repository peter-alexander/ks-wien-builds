/**
 * Compact, source-aware index of already published Z15 native building parts.
 * The ZIP archives are intentionally not required for later comparisons.
 *
 * Every logical building maps to all of its tile keys and deterministic
 * hashes of all parts. A deletion is only a decision for a caller: it does
 * NOT authorize removing geometry without checking FMZK fallback coverage.
 */
import {createHash} from "node:crypto";
import {gzipSync,gunzipSync} from "node:zlib";
import {readNativeTile} from "./native-tile-patch.mjs";
import {logicalNativeBuildingId} from "./canonical-native-anchors.mjs";

const hash=data=>createHash("sha256").update(data).digest("hex");
const ID_SCHEMA=1;
const compare=(a,b)=>a.localeCompare(b);

function partFingerprint(part){
	const info={...part.info};
	// Vertex/index buffers are a contiguous part-local representation.
	// Changing a terrain anchor or provenance is also a real content change.
	return hash(Buffer.concat([
		Buffer.from(JSON.stringify({
			source:info.source,id:info.id,anchorX:info.anchorX,anchorY:info.anchorY,
			sourceSheets:info.sourceSheets||[],replacesKsIds:info.replacesKsIds||[]
		})),Buffer.from([0]),part.vertices,Buffer.from([0]),part.indices
	]));
}

export function indexNativeTiles(tiles){
	if(!(tiles instanceof Map)||!tiles.size)throw new Error("No native Z15 tiles to index");
	const groups=new Map(),tileKeys=[];
	for(const [key,record] of [...tiles].sort((a,b)=>compare(a[0],b[0]))){
		if(!/^15\/[0-9]+\/[0-9]+$/.test(key))throw new Error("Invalid indexed tile "+key);
		if(!Buffer.isBuffer(record?.binary))throw new Error("Missing verified native binary "+key);
		tileKeys.push(key);
		const local=new Map();
		for(const part of readNativeTile(record.binary).parts){
			const id=logicalNativeBuildingId(part.info);
			if(!local.has(id))local.set(id,[]);
			local.get(id).push({partId:part.info.id,sha256:partFingerprint(part),
				sourceSheets:part.info.sourceSheets||[],
				replacesKsIds:part.info.replacesKsIds||[]});
		}
		for(const [id,parts] of local){
			let group=groups.get(id);
			if(!group){
				group={source:id.startsWith("lod21:")?"lod21":"lod1",
					tiles:{},sourceSheets:new Set(),replacesKsIds:new Set(),partCount:0};
				groups.set(id,group);
			}
			for(const part of parts){
				for(const sheet of part.sourceSheets)group.sourceSheets.add(sheet);
				for(const ksId of part.replacesKsIds)group.replacesKsIds.add(ksId);
			}
			group.tiles[key]={
				partCount:parts.length,
				sha256:hash(parts.map(p=>p.partId+"\0"+p.sha256).sort(compare).join("\n"))
			};
			group.partCount+=parts.length;
		}
	}
	const entries=Object.fromEntries([...groups].sort((a,b)=>compare(a[0],b[0])).map(([id,g])=>{
		const tiles=Object.fromEntries(Object.entries(g.tiles).sort((a,b)=>compare(a[0],b[0])));
		const sourceSheets=[...g.sourceSheets].sort(compare);
		const replacesKsIds=[...g.replacesKsIds].sort(compare);
		const fingerprint=hash(JSON.stringify({tiles,sourceSheets,replacesKsIds}));
		return [id,{source:g.source,partCount:g.partCount,tiles,sourceSheets,replacesKsIds,fingerprint}];
	}));
	const replacedBy=new Map();
	for(const [id,group] of Object.entries(entries)){
		if(group.source!=="lod21")continue;
		for(const ksId of group.replacesKsIds){
			if(replacedBy.has(ksId) && replacedBy.get(ksId)!==id){
				throw new Error("Official FMZK building claimed by multiple historical roofs: "+ksId);
			}
			replacedBy.set(ksId,id);
		}
	}
	return {schemaVersion:ID_SCHEMA,format:"KSWN0001",zoom:15,tileCount:tileKeys.length,
		buildingCount:groups.size,buildingParts:[...groups.values()].reduce((sum,g)=>sum+g.partCount,0),
		replacedBy:Object.fromEntries([...replacedBy].sort((a,b)=>compare(a[0],b[0]))),
		buildings:entries};
}

export function serializeNativeBuildingIndex(index){
	const content=Buffer.from(JSON.stringify(index));
	const gzip=gzipSync(content,{level:9});
	return {gzip,sha256:hash(gzip),uncompressedBytes:content.length,compressedBytes:gzip.length};
}

export function readNativeBuildingIndex(input){
	if(!Buffer.isBuffer(input))throw new Error("Building index must be a gzip buffer");
	const data=JSON.parse(gunzipSync(input,{maxOutputLength:256*1024*1024}).toString("utf8"));
	if(data?.schemaVersion!==ID_SCHEMA||data.format!=="KSWN0001"||data.zoom!==15
		||!data.buildings||Array.isArray(data.buildings)
		||data.buildingCount!==Object.keys(data.buildings).length
		||data.tileCount<1 || !data.replacedBy || Array.isArray(data.replacedBy))
		throw new Error("Invalid native building index");
	return data;
}

/**
 * Compare complete before/after snapshots, not incomplete subsets.
 * A removed ID must trigger a fallback or explicit, audited deletion in the
 * update application stage; it is never silently dropped by this planner.
 */
export function diffNativeBuildingIndexes(oldIndex,newIndex){
	for(const index of [oldIndex,newIndex]){
		if(index?.schemaVersion!==ID_SCHEMA || index.format!=="KSWN0001"
			||!index.buildings||index.zoom!==15)throw new Error("Invalid before/after building index");
	}
	const oldIds=new Set(Object.keys(oldIndex.buildings));
	const newIds=new Set(Object.keys(newIndex.buildings));
	const added=[],removed=[],changed=[],unchanged=[];
	const affected=new Set();
	for(const id of new Set([...oldIds,...newIds])){
		const before=oldIndex.buildings[id],after=newIndex.buildings[id];
		if(!before)added.push(id);
		else if(!after)removed.push(id);
		else if(before.fingerprint!==after.fingerprint)changed.push(id);
		else {unchanged.push(id);continue;}
		for(const key of Object.keys(before?.tiles||{}))affected.add(key);
		for(const key of Object.keys(after?.tiles||{}))affected.add(key);
	}
	return {schemaVersion:1,added:added.sort(compare),removed:removed.sort(compare),
		changed:changed.sort(compare),unchangedCount:unchanged.length,
		affectedTiles:[...affected].sort(compare),requiresDeletionReview:removed.length>0};
}
