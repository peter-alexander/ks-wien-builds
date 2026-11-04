import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {collectSourceState} from "./source-state.mjs";

test("confirmed original archive and confirmed missing 404 become compact durable metadata",async()=>{
	const folder=await fs.mkdtemp(path.join(os.tmpdir(),"citygml-state-"));
	try{
		const prefix=path.join(folder,"104078_lod2_gml.zip");
		const zip=Buffer.from("test bytes from a verified source ZIP");
		const sha256=createHash("sha256").update(zip).digest("hex");
		await fs.writeFile(prefix,zip);
		await fs.writeFile(prefix+".http.json",JSON.stringify({
			schemaVersion:1,sheet:"104078",etag:'"v1"',
			lastModified:"Wed, 04 Nov 2026 12:00:00 GMT",contentLength:String(zip.length),sha256
		}));
		await fs.writeFile(path.join(folder,"111081_lod2_gml.zip.missing.json"),
			JSON.stringify({status:"confirmed-missing",httpStatus:404,
				sheet:"111081",checkedAt:"2026-11-04T18:00:00Z"}));
		const state=await collectSourceState({manifest:{buildings:[
			{sheet:"104078"},{sheet:"111081"}
		]},sourceDir:folder});
		assert.equal(state.sheetCount,2);
		assert.equal(state.sources["104078"].etag,'"v1"');
		assert.equal(state.sources["104078"].sha256,sha256);
		assert.equal(state.sources["111081"].status,"missing");
		assert.equal(JSON.stringify(state).includes("test bytes"),false);
		await fs.writeFile(prefix,"incorrect");
		await assert.rejects(collectSourceState({manifest:{buildings:[
			{sheet:"104078"},{sheet:"111081"}
		]},sourceDir:folder}),/changed without version record/);
	}finally{
		await fs.rm(folder,{recursive:true,force:true});
	}
});
