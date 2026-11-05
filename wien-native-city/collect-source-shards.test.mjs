import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {collectRegionSources} from "./collect-source-shards.mjs";
test("latest repaired source shard overrides initial snapshot without duplicating sheets",async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),"wien-shard-merge-"));
	try{
		const region=path.join(root,"region-2234-1420"),inputs=path.join(region,"inputs");
		await fs.mkdir(region,{recursive:true});
		const sheets=["010001","010002","010003"];
		await fs.writeFile(path.join(region,"sources.json"),JSON.stringify({
			schemaVersion:1,buildings:sheets.map(sheet=>({sheet}))
		}));
		await fs.writeFile(path.join(region,"shards.json"),JSON.stringify({
			shards:[{shard:0,sheetCount:2},{shard:1,sheetCount:1}]
		}));
		for(const [stage,shard,files] of [
			[1,0,["010001_lod2_gml.zip","010003_lod2_gml.zip"]],
			[1,1,["010002_lod2_gml.zip"]],
			[2,0,["010001_lod2_gml.zip","010003_lod2_gml.zip"]]
		]){
			const dir=path.join(inputs,"wien-region-2234-1420-pass"+stage+"-"+shard);
			await fs.mkdir(dir,{recursive:true});
			await fs.writeFile(path.join(dir,"__stage-receipt.txt"),"pass"+stage);
			for(const file of files)await fs.writeFile(path.join(dir,file),stage===2?"repaired":"original");
		}
		assert.equal(await collectRegionSources({regionRoot:region,inputsDir:inputs}),3);
		assert.equal(await fs.readFile(path.join(region,"downloads","010003_lod2_gml.zip"),"utf8"),"repaired");
		assert.equal(await fs.readFile(path.join(region,"downloads","010002_lod2_gml.zip"),"utf8"),"original");
	}finally{await fs.rm(root,{recursive:true,force:true});}
});
