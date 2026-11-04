import assert from "node:assert/strict";
import test from "node:test";
import proj4 from "proj4";
import {
	sheetFromProjected, sheetsForProjectedBounds,
	sheetCoverageForMvtBBox, regionKeyOf
} from "./roof-inventory.mjs";

const known = [
	[16.3627195,48.1917944,"104078"],
	[16.3691059,48.1921324,"105078"],
	[16.3535786,48.1919446,"103078"],
	[16.3624232,48.1942288,"104079"]
];

test("official Vienna 500 m CityGML sheet grid",()=>{
	for (const [lng,lat,expected] of known) {
		const p=proj4("EPSG:4326","EPSG:31256",[lng,lat]);
		assert.equal(sheetFromProjected(...p),expected);
		const n=2**15,wx=(lng+180)/360*n;
		const wy=(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n;
		const tile={z:15,x:Math.floor(wx),y:Math.floor(wy)};
		const u=(wx-tile.x)*4096,v=(wy-tile.y)*4096;
		assert.ok(sheetCoverageForMvtBBox(tile,[u-2,v-2,u+2,v+2]).includes(expected));
	}
});

test("sheet boundaries and 8x8 planning",()=>{
	assert.deepEqual(sheetsForProjectedBounds([2010,339010,2020,339020]),["104078"]);
	assert.deepEqual(sheetsForProjectedBounds([2498.5,339498.5,2501.5,339501.5]).sort(),
		["104078","104079","105078","105079"]);
	assert.equal(regionKeyOf({z:15,x:17873,y:11364}),
		regionKeyOf({z:15,x:17874,y:11364}));
	assert.throws(()=>sheetsForProjectedBounds([0,0,20000,1000]),/too many/);
});
