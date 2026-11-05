import assert from "node:assert/strict";
import test from "node:test";
import {validateProductionDelta} from "./validate-production-delta.mjs";

const old={format:"KSWN0001",fmzkRelease:"old-fmzk",publishedTileCount:678,
	buildingParts:621698,lod21Parts:59589};
const current={...old};
test("unchanged and slightly changed verified roof releases pass",()=>{
	assert.equal(validateProductionDelta(old,current).status,"verified");
	assert.equal(validateProductionDelta(old,{...current,lod21Parts:55000}).status,"verified");
});
test("major loss of historical roofs fails closed before publication",()=>{
	assert.throws(()=>validateProductionDelta(old,{...current,lod21Parts:20000}),
		/Large unexplained loss/);
	assert.throws(()=>validateProductionDelta(old,{
		...current,fmzkRelease:"new-fmzk",lod21Parts:35000
	}),/Large unexplained loss/);
});
test("incomplete new building releases fail closed",()=>{
	assert.throws(()=>validateProductionDelta(old,{
		...current,publishedTileCount:50
	}),/Incomplete/);
	assert.equal(validateProductionDelta(null,current).status,"first-native-release");
});
