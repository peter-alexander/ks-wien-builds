#!/usr/bin/env node
/**
 * Inventory original LOD2.1 500 m CityGML download sheets from the COMPLETE
 * current FMZK Z15 tile index. Nothing from Maptoolkit is used.
 *
 * Vienna 500 m sheet grid (EPSG:31256):
 * sheet AAA BBB -> eastings [500*(AAA-100),500*(AAA-99)),
 * northings [300000+500*BBB,300500+500*BBB).
 *
 * The spatial grouping is intended for independent later roof-matching jobs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { BASE } from "../wien-native-pilot/build.mjs";

const CRS = "EPSG:31256";
proj4.defs(CRS,
	"+proj=tmerc +lat_0=0 +lon_0=16.3333333333333 +k=1 +x_0=0 +y_0=-5000000 "
	+ "+ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 "
	+ "+units=m +no_defs +type=crs"
);
const MAX_SHEETS = 3000;
const MAX_FEATURES = 2000000;
const BLOCK_SIZE = 8;

export function sheetFromProjected(easting, northing) {
	if (![easting,northing].every(Number.isFinite)) throw new TypeError("Non-finite Vienna coordinates");
	const eastId = Math.floor(easting / 500) + 100;
	const northId = Math.floor((northing - 300000) / 500);
	if (eastId < 0 || eastId > 999 || northId < 0 || northId > 999) {
		throw new RangeError("Out-of-range Vienna 500 m sheet " + [easting,northing]);
	}
	return String(eastId).padStart(3,"0") + String(northId).padStart(3,"0");
}

export function sheetsForProjectedBounds([west,south,east,north], padMetres = 2) {
	if (![west,south,east,north].every(Number.isFinite) || west > east || south > north
		|| padMetres < 0 || padMetres > 50) throw new RangeError("Invalid source-coordinate bounds");
	const sx = Math.floor((west - padMetres) / 500) + 100;
	const ex = Math.floor((east + padMetres) / 500) + 100;
	const sy = Math.floor((south - padMetres - 300000) / 500);
	const ey = Math.floor((north + padMetres - 300000) / 500);
	if (ex - sx > 8 || ey - sy > 8) {
		throw new RangeError("Single clipped FMZK feature intersects too many original sheets");
	}
	const sheets = [];
	for (let y = sy; y <= ey; y++) {
		for (let x = sx; x <= ex; x++) {
			if (x < 0 || x > 999 || y < 0 || y > 999) {
				throw new RangeError("Projected coordinates beyond Vienna sheet numbering");
			}
			sheets.push(String(x).padStart(3,"0") + String(y).padStart(3,"0"));
		}
	}
	return sheets;
}

function lngLatAt(tile, u, v, extent) {
	const n = 2 ** tile.z;
	const wx = (tile.x + u / extent) / n;
	const wy = (tile.y + v / extent) / n;
	return [
		wx * 360 - 180,
		Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180 / Math.PI
	];
}

export function sheetCoverageForMvtBBox(tile, bbox, extent = 4096) {
	if (!Array.isArray(bbox) || bbox.length !== 4
		|| bbox.some(v=>!Number.isFinite(v)) || !Number.isSafeInteger(extent)
		|| extent <= 0 || bbox[0] > bbox[2] || bbox[1] > bbox[3]) {
		throw new RangeError("Invalid MVT bounding box");
	}
	const [minX,minY,maxX,maxY] = bbox;
	const projected = [];
	for (const [u,v] of [
		[minX,minY],[minX,maxY],[maxX,minY],[maxX,maxY],
		[(minX+maxX)/2,(minY+maxY)/2]
	]) {
		projected.push(proj4("EPSG:4326",CRS,lngLatAt(tile,u,v,extent)));
	}
	return sheetsForProjectedBounds([
		Math.min(...projected.map(p=>p[0])),
		Math.min(...projected.map(p=>p[1])),
		Math.max(...projected.map(p=>p[0])),
		Math.max(...projected.map(p=>p[1]))
	]);
}

export function regionKeyOf(tile, size = BLOCK_SIZE) {
	if (!Number.isSafeInteger(tile.z) || tile.z !== 15
		|| !Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y)) {
		throw new TypeError("Region requires a Z15 tile");
	}
	return Math.floor(tile.x/size) + "-" + Math.floor(tile.y/size);
}

function parseKey(key) {
	const parts = /^15\/(\d+)\/(\d+)$/.exec(key);
	if (!parts) throw new Error("Invalid FMZK tile key " + key);
	return {z:15,x:Number(parts[1]),y:Number(parts[2])};
}

function getFeatureBBox(feature) {
	if (typeof feature.bbox === "function") return feature.bbox();
	// Fallback is geometry only if a vector-tile version lacks bbox().
	const rings = feature.loadGeometry();
	const points = rings.flat();
	if (!points.length) return null;
	return [
		Math.min(...points.map(p=>p.x)),
		Math.min(...points.map(p=>p.y)),
		Math.max(...points.map(p=>p.x)),
		Math.max(...points.map(p=>p.y))
	];
}

async function download(url) {
	for (let attempt = 0; attempt < 4; attempt++) {
		const ctrl = new AbortController();
		const timeout = setTimeout(()=>ctrl.abort(),45000);
		try {
			const response = await fetch(url,{signal:ctrl.signal});
			if(!response.ok) throw new Error("HTTP "+response.status);
			return response.arrayBuffer();
		} catch(error) {
			if(attempt===3) throw new Error("Unable to load "+url+": "+error.message);
			await new Promise(r=>setTimeout(r,1000*(attempt+1)));
		} finally { clearTimeout(timeout); }
	}
}

export function summarizeRegions(tileCoverage, sourceVersion) {
	const regions = new Map();
	const allSheets = new Map();
	let totalFeatureParts = 0;
	for (const [key, details] of tileCoverage) {
		const regionId = regionKeyOf(parseKey(key));
		let region = regions.get(regionId);
		if (!region) {
			region={id:regionId,keys:[],sheets:new Set(),featureParts:0};
			regions.set(regionId,region);
		}
		region.keys.push(key);
		region.featureParts+=details.featureParts;
		totalFeatureParts+=details.featureParts;
		for (const sheet of details.sheets) {
			region.sheets.add(sheet);
			let item=allSheets.get(sheet);
			if(!item){item={sheet,tileKeys:new Set(),featureParts:0};allSheets.set(sheet,item);}
			item.tileKeys.add(key);
			item.featureParts+=details.sheetFeatures.get(sheet)||0;
		}
	}
	if (allSheets.size < 500 || allSheets.size > MAX_SHEETS) {
		throw new Error("Suspicious Vienna CityGML sheet inventory count: "+allSheets.size);
	}
	const result={
		schemaVersion:1,
		sourceRelease:sourceVersion,
		at:new Date().toISOString(),
		projection:CRS,
		originalSheetGrid:"500m, east=floor(x/500)+100; north=floor((y-300000)/500)",
		availableSheetsNotYetConfirmed:true,
		coverage:{tiles:tileCoverage.size,featureParts:totalFeatureParts,sheets:allSheets.size,regions:regions.size},
		sheets:[...allSheets.values()].sort((a,b)=>a.sheet.localeCompare(b.sheet))
			.map(x=>({sheet:x.sheet,tileCount:x.tileKeys.size,featureParts:x.featureParts})),
		regions:[...regions.values()].sort((a,b)=>a.id.localeCompare(b.id))
			.map(x=>({id:x.id,tileKeys:x.keys.sort(),sheets:[...x.sheets].sort(),featureParts:x.featureParts}))
	};
	return result;
}

export async function inventoryOfficialRoofs({
	output="wien-native-city/build/roof-inventory.json",
	release=null,
	loadTile=download,
	concurrency=4
}={}) {
	const official=release || JSON.parse(Buffer.from(await download(BASE+"/LOD1/release.json")).toString("utf8"));
	const keys=official.vectorTiles?.presentTilesZ15;
	if(!Array.isArray(keys)||keys.length<600||official.vectorTiles?.compression!=="none") {
		throw new Error("Source FMZK release missing or too small");
	}
	const results=new Map();
	let next=0;
	const worker=async()=>{
		while(next<keys.length){
			const key=keys[next++];
			const tile=parseKey(key);
			const buffer=await loadTile(BASE+"/LOD1/tiles/"+key+".pbf");
			const vector=new VectorTile(new PbfReader(new Uint8Array(buffer)));
			const layer=vector.layers?.wien_buildings;
			if(!layer?.length) throw new Error("Missing FMZK vector layer for "+key);
			const sheets=new Set(), sheetFeatures=new Map();
			let featureParts=0;
			for(let i=0;i<layer.length;i++){
				const f=layer.feature(i);
				if(f.type!==3 || !f.properties?.KS_ID) continue;
				const bbox=getFeatureBBox(f);
				if(!bbox) continue;
				featureParts++;
				for(const sheet of sheetCoverageForMvtBBox(tile,bbox,layer.extent||4096)){
					sheets.add(sheet);
					sheetFeatures.set(sheet,(sheetFeatures.get(sheet)||0)+1);
				}
			}
			if(!featureParts)throw new Error("No FMZK polygons in "+key);
			results.set(key,{featureParts,sheets,sheetFeatures});
			if(results.size%50===0)console.log("Indexed "+results.size+"/"+keys.length+" Z15 tiles");
		}
	};
	await Promise.all(Array.from({length:Math.min(concurrency,8,keys.length)},worker));
	const report=summarizeRegions(results,official.generatedAt);
	if(report.coverage.tiles!==keys.length || report.coverage.featureParts>MAX_FEATURES){
		throw new Error("Incomplete or pathological city roof inventory");
	}
	await fs.mkdir(path.dirname(output),{recursive:true});
	await fs.writeFile(output,JSON.stringify(report,null,"\t")+"\n");
	console.log(JSON.stringify(report.coverage));
	return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
	inventoryOfficialRoofs().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
}
