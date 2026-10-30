#!/usr/bin/env node
import fs from "node:fs";
const base = "https://data.wien.gv.at/daten/geo";
const ids = ["4005738567", "4005738573", "4007653867", "4001892559", "4007121901"];
const cases = [
	{ layer: "FMZKBKMOGD", filter: "FMZK_ID IN (" + ids.slice(0, 3).map(id => "'" + id + "'").join(",") + ")" },
	...ids.map(id => ({layer:"FMZKBKMOGD",filter:"FMZK_ID='" + id + "'"})),
	...ids.slice(0,3).map(id => ({layer:"FMZKBKMOGD",filter:"FMZK_ID=" + id})),
	...ids.map(id => ({layer:"FMZKGEBOGD",filter:"FMZK_ID='" + id + "'"}))
];
const res = [];
for (const c of cases) {
	const u = new URL(base);
	for (const [key,value] of Object.entries({
		service:"WFS",request:"GetFeature",version:"1.1.0",
		typeName:"ogdwien:" + c.layer,outputFormat:"json",srsName:"EPSG:31256",CQL_FILTER:c.filter
	})) u.searchParams.set(key,value);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20000);
	try {
		const response = await fetch(u,{signal:controller.signal});
		const body = await response.text();
		let json;
		try { json = JSON.parse(body); } catch {}
		const result = { ...c, http:response.status, length:body.length,
			featureCount:Array.isArray(json?.features)?json.features.length:null,
			ids:(json?.features||[]).map(f=>String(f?.properties?.FMZK_ID)),
			featureProperties:(json?.features||[]).slice(0,1).map(f=>Object.keys(f.properties||{})),
			geometryTypes:[...new Set((json?.features||[]).map(f=>f.geometry?.type))],
			numberMatched:json?.numberMatched??null,
			error:response.ok?null:body.slice(0,400) };
		res.push(result);
		console.log(JSON.stringify(result));
	} catch (error) {
		const result={ ...c,error:String(error) };res.push(result);console.log(JSON.stringify(result));
	} finally {clearTimeout(timer);}
}
const output=process.env.GITHUB_STEP_SUMMARY;
if(output) fs.appendFileSync(output,"\n### WFS targeted source check\n\n" + res.map(r=>
	"- " + r.layer + " `" + r.filter + "`: HTTP " + r.http + ", features="+r.featureCount+", IDs="+r.ids+", error="+r.error
).join("\n")+"\n");
