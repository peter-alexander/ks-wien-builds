#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.argv[2] || "pages");
const dataset = process.argv[3];
const groups = {
	baumkataster: ["Baumkataster/release.json", "Baumkataster/tilejson.json"],
	buildings: [
		"WienBuildings/LOD1/release.json",
		"WienBuildings/LOD1/tilejson.json",
		"WienBuildings/LOD21/release.json",
		"WienBuildings/LOD21/targets.json"
	],
	stadtplan: ["StadtplanWien/style.json"]
};
if (!Object.hasOwn(groups, dataset)) {
	throw new Error("Unsupported dataset: " + dataset);
}

const manifestPath = path.join(root, "asset-versions.json");
const previous = fs.existsSync(manifestPath)
	? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
	: { schema: 1, files: {} };
if (previous.schema !== 1 || !previous.files || Array.isArray(previous.files)) {
	throw new Error("Invalid existing asset-versions.json");
}
const files = { ...previous.files };
for (const relative of groups[dataset]) {
	const full = path.join(root, ...relative.split("/"));
	const data = fs.readFileSync(full);
	files[relative] = crypto.createHash("sha256").update(data).digest("hex").slice(0, 20);
}
const ordered = Object.fromEntries(
	Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))
);
const output = JSON.stringify({ schema: 1, files: ordered }, null, "\t") + "\n";
if (!fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, "utf8") !== output) {
	fs.writeFileSync(manifestPath, output);
}
console.log("Asset versions:", groups[dataset].join(", "));
