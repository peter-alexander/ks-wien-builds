import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {sameSourceVersion,assembleCityRelease} from "./assemble-regions.mjs";

test("different CityGML ZIP contents cannot mix across region boundaries",()=>{
	assert.equal(sameSourceVersion({status:"present",sha256:"abc",etag:"A"},
		{status:"present",sha256:"abc",etag:"A"}),true);
	assert.equal(sameSourceVersion({status:"present",sha256:"abc",etag:"A"},
		{status:"present",sha256:"def",etag:"A"}),false);
	assert.equal(sameSourceVersion({status:"missing",httpStatus:404},
		{status:"missing",httpStatus:404}),true);
	assert.equal(sameSourceVersion({status:"missing",httpStatus:404},
		{status:"present",sha256:"abc"}),false);
});
test("cannot publish from missing original roof region artifacts",async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),"wien-native-region-"));
	try {
		const inventory=JSON.parse(await fs.readFile(
			new URL("./roof-inventory.snapshot.json",import.meta.url),"utf8"));
		await assert.rejects(assembleCityRelease({
			inventory,regionsDir:root,outDir:path.join(root,"out"),
			minExpectedLod1Parts:1,minExpectedLod21Parts:1
		}),/ENOENT/);
		await assert.rejects(fs.access(path.join(root,"out","release.json")));
	} finally {await fs.rm(root,{recursive:true,force:true});}
});
