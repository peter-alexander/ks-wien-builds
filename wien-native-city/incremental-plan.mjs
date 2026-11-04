#!/usr/bin/env node
/**
 * Safe per-original-CityGML source -> previously published binary-tile plan.
 * No historical CityGML ZIP archive is required when a verified source is
 * unchanged. Never use a failed HTTP check as proof of no change.
 */
import {createHash} from "node:crypto";

function assertKey(key) {
	if(!/^15\/\d+\/\d+$/.test(key)) throw new Error("Invalid Z15 native tile key "+key);
}

function assertedSourceMap(sources) {
	if(!sources || typeof sources!=="object" || Array.isArray(sources)) {
		throw new Error("Missing original roof source metadata");
	}
	for(const [sheet, state] of Object.entries(sources)) {
		if(!/^\d{6}$/.test(sheet) || !state || !["present","missing"].includes(state.status)){
			throw new Error("Unverified original CityGML source: "+sheet);
		}
		if(state.status==="present" && !state.etag && !state.lastModified && !state.sha256){
			throw new Error("Unversioned original CityGML ZIP: "+sheet);
		}
		if(state.status==="missing" && state.httpStatus!==404) {
			throw new Error("Historic source may be missing only after verified HTTP 404: "+sheet);
		}
	}
	return sources;
}

export function sourceChanged(previous,current) {
	if(!previous || !current || !["present","missing"].includes(current.status)){
		return true;
	}
	if(previous.status!==current.status)return true;
	if(current.status==="missing")return false;
	if(current.sha256 && previous.sha256 && current.sha256===previous.sha256)return false;
	if(current.etag && previous.etag)return current.etag!==previous.etag;
	if(current.lastModified && previous.lastModified && current.contentLength && previous.contentLength){
		return current.lastModified!==previous.lastModified ||
			current.contentLength!==previous.contentLength;
	}
	return true;
}

/** In the first release, region-level dependencies deliberately OVERinvalidate.
 * They cannot omit tiles that cross a sheet boundary, even when exact per-roof
 * provenance has not yet been established. Refine later with building IDs. */
export function mapSheetsToTiles(inventory) {
	if(inventory?.schemaVersion!==1 ||
		!Array.isArray(inventory.sheets) ||
		!Array.isArray(inventory.regions) ||
		inventory.coverage?.tiles<600) {
		throw new Error("Missing original Vienna CityGML coverage inventory");
	}
	const expectedSheets=new Set(inventory.sheets.map(x=>x.sheet));
	const sheetTiles=new Map([...expectedSheets].map(sheet=>[sheet,new Set()]));
	const allTileKeys=new Set();
	for(const region of inventory.regions){
		for(const key of region.tileKeys){
			assertKey(key);
			allTileKeys.add(key);
		}
		for(const sheet of region.sheets){
			if(!sheetTiles.has(sheet))throw new Error("Region references unknown original CityGML sheet "+sheet);
			for(const key of region.tileKeys)sheetTiles.get(sheet).add(key);
		}
	}
	if(allTileKeys.size!==inventory.coverage.tiles ||
		sheetTiles.size!==inventory.coverage.sheets ||
		[...sheetTiles.values()].some(set=>!set.size)){
		throw new Error("Unindexed source sheets or missing official current building tiles");
	}
	return {
		tileKeys:[...allTileKeys].sort(),
		sheets:Object.fromEntries([...sheetTiles].sort((a,b)=>a[0].localeCompare(b[0]))
			.map(([sheet,keys])=>[sheet,[...keys].sort()]))
	};
}

/** buildRevision: hash of all code/config inputs which influence geometry,
 * not only the git branch HEAD (documentation-only commits must not rebuild). */
export function computeBuilderRevision(fileContents) {
	if(!Array.isArray(fileContents) || !fileContents.length ||
		fileContents.some(x=>typeof x.path!=="string" || typeof x.content!=="string")){
		throw new Error("Invalid native building input fingerprints");
	}
	const hash=createHash("sha256");
	for(const f of [...fileContents].sort((a,b)=>a.path.localeCompare(b.path))){
		hash.update(f.path+"\0"+f.content.length+"\0"+f.content+"\0");
	}
	return hash.digest("hex");
}

export function planChangedTiles({
	oldRelease=null,newSources,fmzkRelease,buildRevision,dependencyIndex
}={}) {
	assertedSourceMap(newSources);
	if(!dependencyIndex || !Array.isArray(dependencyIndex.tileKeys) ||
		!dependencyIndex.sheets || !Number.isSafeInteger(dependencyIndex.tileKeys.length)
		|| dependencyIndex.tileKeys.length<600) {
		throw new Error("Incomplete current whole-Wien building dependency index");
	}
	const indexedSheets=Object.keys(dependencyIndex.sheets);
	if(indexedSheets.length!==Object.keys(newSources).length ||
		indexedSheets.some(sheet=>!(sheet in newSources))) {
		throw new Error("CityGML source status incomplete; keep published tiles unchanged");
	}
	if(typeof fmzkRelease!=="string" || !fmzkRelease ||
		typeof buildRevision!=="string" || !/^[a-f0-9]{64}$/.test(buildRevision)) {
		throw new Error("Unpinned FMZK source/build code");
	}
	const allKeys=new Set(dependencyIndex.tileKeys);
	for(const [sheet,keys] of Object.entries(dependencyIndex.sheets)){
		if(!/^\d{6}$/.test(sheet) || !Array.isArray(keys) || !keys.length ||
			keys.some(key=>!allKeys.has(key))) {
			throw new Error("Invalid conservative source-to-tile dependency index");
		}
	}
	const full=!oldRelease ||
		oldRelease.fmzkRelease!==fmzkRelease ||
		oldRelease.buildRevision!==buildRevision ||
		oldRelease.format!=="KSWN0001" ||
		oldRelease.publishedTileCount!==allKeys.size;
	const changedSheets=indexedSheets.filter(sheet=>
		!oldRelease || sourceChanged(oldRelease?.sources?.[sheet],newSources[sheet])
	).sort();
	const changedKeys=new Set();
	if(full){for(const key of allKeys)changedKeys.add(key);}
	else for(const sheet of changedSheets){
		for(const key of dependencyIndex.sheets[sheet])changedKeys.add(key);
	}
	return {
		schemaVersion:1,
		status:full?"full-rebuild":changedKeys.size?"partial-rebuild":"unchanged",
		fmzkRelease,buildRevision,
		changedSheets,
		affectedTiles:[...changedKeys].sort(),
		tileCount:allKeys.size,
		reusableTiles:allKeys.size-changedKeys.size
	};
}
