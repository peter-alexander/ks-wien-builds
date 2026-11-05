/**
 * Split large Z13 building tiles into independently decodable KSWN0001
 * bundles without touching the original FMZK geometry or feature identity.
 * The standard native decoder's 16 MiB raw limit stays unchanged.
 */
import {writeNativeTile} from "./native-tile-patch.mjs";
const LIMIT=16*1024*1024;
const DEFAULT_TARGET=9*1024*1024;
function bound(part){
	if(!part?.info || !Buffer.isBuffer(part.vertices) || !Buffer.isBuffer(part.indices))
		throw new Error("Invalid input native part");
	// Upper bound includes JSON for per-part metadata + conservative padding
	return part.vertices.length+part.indices.length+
		Buffer.byteLength(JSON.stringify(part.info))+256;
}
export function chunkNativeParts(parts,{targetBytes=DEFAULT_TARGET}={}){
	if(!Array.isArray(parts)||!parts.length||
		!Number.isSafeInteger(targetBytes)||targetBytes<1024||targetBytes>12*1024*1024)
		throw new Error("Unsupported native chunk capacity");
	const batches=[];
	let current=[],estimated=64;
	for(const part of parts){
		const size=bound(part);
		if(size>targetBytes-64)throw new Error("A single native building part exceeds target chunk capacity");
		if(current.length && estimated+size>targetBytes){
			batches.push(current);
			current=[];estimated=64;
		}
		current.push(part);estimated+=size;
	}
	if(current.length)batches.push(current);
	const chunks=batches.map((batch,index)=>{
		const packed=writeNativeTile(batch);
		if(packed.raw.length>=LIMIT)throw new Error("Native chunk exceeds 16 MiB decompression limit");
		return {index,parts:batch.length,rawBytes:packed.raw.length,
			gzipBytes:packed.compressed.length,compressed:packed.compressed,
			vertices:packed.stats.vertices,triangles:packed.stats.triangles};
	});
	if(chunks.reduce((sum,c)=>sum+c.parts,0)!==parts.length)
		throw new Error("Native chunk split dropped a building part");
	return chunks;
}
