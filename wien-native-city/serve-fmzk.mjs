#!/usr/bin/env node
/**
 * Local read-only FMZK snapshot service for one GitHub Actions build.
 * Never mixes tiles downloaded from different public source releases.
 * Usage: node serve-fmzk.mjs ./wien-buildings/build/WienBuildings [port]
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

export function serveFmzk({root,port=18765}={}){
	if(!root||!Number.isInteger(port)||port<1024||port>65535)
		throw new Error("Specify a local FMZK source directory and port");
	const directory=path.resolve(root);
	const server=http.createServer((request,response)=>{
		const key=new URL(request.url||"/","http://localhost").pathname;
		if(request.method!=="GET"||
			!/^\/LOD1\/(release\.json|tiles\/(13|14|15)\/[0-9]+\/[0-9]+\.pbf)$/.test(key)){
			response.writeHead(404,{"Cache-Control":"no-store"}).end();
			return;
		}
		const source=path.join(directory,key.slice("/LOD1/".length));
		fs.stat(source,(error,stat)=>{
			if(error||!stat.isFile()){
				response.writeHead(404,{"Cache-Control":"no-store"}).end();
				return;
			}
			response.writeHead(200,{
				"Content-Type":key.endsWith(".json")?"application/json":"application/x-protobuf",
				"Content-Length":String(stat.size),
				"Cache-Control":"no-store"
			});
			const stream=fs.createReadStream(source);
			stream.on("error",()=>response.destroy());
			stream.pipe(response);
		});
	});
	server.listen(port,"127.0.0.1");
	return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
	const [root,port]=process.argv.slice(2);
	const server=serveFmzk({root,port:Number(port||18765)});
	server.on("listening",()=>console.log("FMZK snapshot ready on 127.0.0.1:"+server.address().port));
}
