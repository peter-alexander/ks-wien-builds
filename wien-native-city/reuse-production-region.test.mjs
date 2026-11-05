import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import * as THREE from "three";
import {encodeNativeTile} from "../wien-native-pilot/build.mjs";
import {currentNativeBuilderRevision} from "./assemble-regions.mjs";
import {reuseProductionRegion} from "./reuse-production-region.mjs";

const KEY="15/17873/11364";
const SHEET="104078";
const FMZK="2026-11-03T11:04:51.669Z";
function sampleTile(){
	const geometry=new THREE.BufferGeometry();
	geometry.setAttribute("position",new THREE.Float32BufferAttribute([
		4096,4096,4,4098,4096,6,4096,4098,6
	],3));
	geometry.setAttribute("normal",new THREE.Float32BufferAttribute([
		0,0,1,0,0,1,0,0,1
	],3));
	geometry.setIndex([0,1,2]);
	geometry.userData.ksGroundRanges=[{start:0,count:3,key:"x",lng:16.362,lat:48.191}];
	try{
		return encodeNativeTile({z:15,x:17873,y:11364},[{source:"lod1",geometry}]).compressed;
	}finally{geometry.dispose();}
}
test("reuse only source-identical checksum-verified original native geometry",async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),"wien-reuse-"));
	try{
		const file=path.join(root,"old.json");
		const content=sampleTile();
		const checksum=createHash("sha256").update(content).digest("hex");
		const state={status:"present",sha256:"a".repeat(64)};
		const original={format:"KSWN0001",fmzkRelease:FMZK,
			buildRevision:await currentNativeBuilderRevision(),
			publishedTileCount:600,dependencyIndex:{tileKeys:Array(600).fill(KEY)},
			sources:{[SHEET]:state},
			tiles:{[KEY]:{sha256:checksum,gzipBytes:content.length,
				buildingParts:1,lod21Parts:0}}};
		await fs.writeFile(path.join(root,"plan.json"),JSON.stringify({
			region:"2234-1420",fmzkRelease:FMZK,sourceSheets:[SHEET],tiles:[KEY]
		}));
		await fs.writeFile(path.join(root,"source-state.json"),JSON.stringify({
			schemaVersion:1,sheetCount:1,sources:{[SHEET]:state}
		}));
		await fs.writeFile(file,JSON.stringify(original));
		let calls=0;
		const fetchImpl=async()=>{
			calls++;
			return {ok:true,arrayBuffer:async()=>content};
		};
		assert.equal(await reuseProductionRegion({
			regionRoot:root,oldReleaseFile:file,allowReuse:true,fetchImpl
		}),true);
		assert.equal(calls,1);
		const output=JSON.parse(await fs.readFile(path.join(root,"NativeRegion","manifest.json"),"utf8"));
		assert.equal(output.tiles[KEY].sha256,checksum);
		assert.equal(output.sourceRelease,FMZK);
		await fs.writeFile(file,JSON.stringify({...original,fmzkRelease:"different"}));
		assert.equal(await reuseProductionRegion({
			regionRoot:root,oldReleaseFile:file,allowReuse:true,fetchImpl
		}),false);
		await fs.writeFile(file,JSON.stringify(original));
		await assert.rejects(()=>reuseProductionRegion({
			regionRoot:root,oldReleaseFile:file,allowReuse:true,
			fetchImpl:async()=>({ok:true,arrayBuffer:async()=>Buffer.from("corrupt")})
		}),/Cannot safely reuse/);
	}finally{await fs.rm(root,{recursive:true,force:true});}
});
