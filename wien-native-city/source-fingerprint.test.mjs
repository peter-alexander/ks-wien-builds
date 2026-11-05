import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fingerprintOfficialFmzk} from "./source-fingerprint.mjs";

test("identical authoritative WFS geometry reuses source version and lowzoom tiles",async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),"wien-fmzk-sha-"));
	try{
		const input=path.join(root,"data.geojsonseq");
		const metadata=path.join(root,"source.json");
		const previous=path.join(root,"previous.json");
		const report=path.join(root,"fingerprint.json");
		const fresh="2026-11-06T07:00:00Z";
		const saved="2026-11-03T11:04:51.669Z";
		await fs.writeFile(input,"{\"type\":\"Feature\"}\n");
		const release={generatedAt:fresh,counts:{output:600000},
			vectorTiles:{layer:"wien_buildings"}};
		await fs.writeFile(metadata,JSON.stringify(release));
		const baseline=await fingerprintOfficialFmzk({
			geojsonFile:input,sourceReleaseFile:metadata,outFile:report
		});
		assert.equal(baseline.fmzkReuse,false);
		assert.equal(baseline.lowZoomReuse,false);
		assert.match(baseline.fmzkSourceSha256,/^[a-f0-9]{64}$/);
		await fs.writeFile(previous,JSON.stringify({
			format:"KSWN0001",fmzkRelease:saved,
			fmzkSourceSha256:baseline.fmzkSourceSha256,
			lowZoomBuilderRevision:baseline.lowZoomBuilderRevision
		}));
		await fs.writeFile(metadata,JSON.stringify(release));
		const second=await fingerprintOfficialFmzk({
			geojsonFile:input,sourceReleaseFile:metadata,
			previousReleaseFile:previous,outFile:report
		});
		assert.equal(second.fmzkReuse,true);
		assert.equal(second.lowZoomReuse,true);
		assert.equal(second.fmzkRelease,saved);
		assert.equal(JSON.parse(await fs.readFile(metadata,"utf8")).generatedAt,saved);
		await fs.writeFile(input,"{\"type\":\"FeatureCollection\"}\n");
		await fs.writeFile(metadata,JSON.stringify(release));
		const changed=await fingerprintOfficialFmzk({
			geojsonFile:input,sourceReleaseFile:metadata,
			previousReleaseFile:previous,outFile:report
		});
		assert.equal(changed.fmzkReuse,false);
		assert.equal(changed.fmzkRelease,fresh);
	}finally{await fs.rm(root,{recursive:true,force:true});}
});
