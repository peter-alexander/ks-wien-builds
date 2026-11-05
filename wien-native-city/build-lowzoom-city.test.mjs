import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {listExistingLowZoomKeys} from "./build-lowzoom-city.mjs";

test("discover actual published Z14 tile keys rather than assuming Z15 parent coverage",async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),"wien-z14-"));
	try{
		for(const key of ["14/8936/5680","14/8937/5680","14/8937/5681"]){
			const file=path.join(root,"tiles",key+".pbf");
			await fs.mkdir(path.dirname(file),{recursive:true});
			await fs.writeFile(file,Buffer.from([1]));
		}
		assert.deepEqual(await listExistingLowZoomKeys(root,14),
			["14/8936/5680","14/8937/5680","14/8937/5681"]);
	}finally{await fs.rm(root,{recursive:true,force:true});}
});
test("reject malformed source tile directory",async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),"wien-bad-z14-"));
	try{
		const dir=path.join(root,"tiles","14","8936");
		await fs.mkdir(dir,{recursive:true});
		await fs.writeFile(path.join(dir,"readme.txt"),"invalid");
		await assert.rejects(()=>listExistingLowZoomKeys(root,14),/Unexpected/);
	}finally{await fs.rm(root,{recursive:true,force:true});}
});
