#!/usr/bin/env node
import fs from "node:fs";
const base = "https://data.wien.gv.at/daten/geo";
const ids = ["4005738567", "4005738573", "4007653867", "4001892559", "4007121901"];
const cases = [
	{ layer: "FMZKBKMOGD", filter: "FMZK_ID IN (" + ids.slice(0, 3).map(id => "'" + id + "'").join(",") + ")" },
	...ids.map(id => ({layer:"FMZKBKMOGD",filter:"FMZK_ID='" + id + "'"})),
	...ids.slice(0,3).map(id => ({layer:"FMZKBKMOGD",filter:"FMZK_ID=" + id})),
	...ids.map(id => ({layer:"FMZKGEBOGD",filter:"FMZK_ID='" + id + "'"})),
	...["5436256","5411794"].flatMap(id => [
		{layer:"FMZKBKMOGD",filter:"BW_GEB_ID=" + id},
		{layer:"FMZKGEBOGD",filter:"BW_GEB_ID=" + id}
	])
];
cases.push({layer:"FMZKBKMOGD",bbox:"-3352,342796,-3252,342896,EPSG:31256"});
cases.push({layer:"FMZKGEBOGD",bbox:"-3352,342796,-3252,342896,EPSG:31256"});
cases.push({layer:"FMZKBKMOGD",bbox:"-2934,341052,-2894,341092,EPSG:31256"});
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
		if (c.bbox) { u.searchParams.delete("CQL_FILTER"); u.searchParams.set("bbox",c.bbox); }
		const response = await fetch(u,{signal:controller.signal});
		const body = await response.text();
		let json;
		try { json = JSON.parse(body); } catch {}
		const result = { ...c, http:response.status, length:body.length,
			featureCount:Array.isArray(json?.features)?json.features.length:null,
			ids:(json?.features||[]).slice(0,100).map(f=>String(f?.properties?.FMZK_ID)),
			featureProperties:(json?.features||[]).slice(0,1).map(f=>Object.keys(f.properties||{})),
			geometryTypes:[...new Set((json?.features||[]).map(f=>f.geometry?.type))],
			recordDetails:(json?.features||[]).slice(0,100).map(f=>({
				id:f.properties?.FMZK_ID,bwGebId:f.properties?.BW_GEB_ID,
				height:f.properties?.O_KOTE,base:f.properties?.T_KOTE,
				fKlasse:f.properties?.F_KLASSE
			})),
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
