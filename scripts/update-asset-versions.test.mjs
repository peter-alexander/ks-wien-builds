import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./update-asset-versions.mjs", import.meta.url));

function withPages(callback) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wien-assets-"));
	try {
		const write = (relative, data) => {
			const file = path.join(root, relative);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, data);
		};
		const run = (dataset) => {
			execFileSync(process.execPath, [script, root, dataset], { stdio: "pipe" });
			return JSON.parse(fs.readFileSync(path.join(root, "asset-versions.json"), "utf8"));
		};
		callback({ root, write, run });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("LOD1 updates only LOD1 hashes and retains existing LOD2.1 entries", () => {
	withPages(({ write, run }) => {
		write("asset-versions.json", JSON.stringify({
			schema: 1,
			files: {
				"WienBuildings/LOD21/release.json": "old-lod21-release",
				"WienBuildings/LOD21/targets.json": "old-lod21-targets",
				"StadtplanWien/style.json": "old-style"
			}
		}));
		write("WienBuildings/LOD1/release.json", '{"status":"lod1"}');
		write("WienBuildings/LOD1/tilejson.json", '{"tiles":[]}');
		const result = run("buildings-lod1");
		assert.equal(result.files["WienBuildings/LOD21/release.json"], "old-lod21-release");
		assert.equal(result.files["WienBuildings/LOD21/targets.json"], "old-lod21-targets");
		assert.equal(result.files["StadtplanWien/style.json"], "old-style");
		assert.match(result.files["WienBuildings/LOD1/release.json"], /^[a-f0-9]{20}$/);
		assert.match(result.files["WienBuildings/LOD1/tilejson.json"], /^[a-f0-9]{20}$/);
	});
});

test("LOD2.1 updates only LOD2.1 hashes and retains existing LOD1 entries", () => {
	withPages(({ write, run }) => {
		write("asset-versions.json", JSON.stringify({
			schema: 1,
			files: {
				"WienBuildings/LOD1/release.json": "old-lod1-release",
				"WienBuildings/LOD1/tilejson.json": "old-lod1-tilejson"
			}
		}));
		write("WienBuildings/LOD21/release.json", '{"status":"production"}');
		write("WienBuildings/LOD21/targets.json", '{"targets":[]}');
		const result = run("buildings-lod21");
		assert.equal(result.files["WienBuildings/LOD1/release.json"], "old-lod1-release");
		assert.equal(result.files["WienBuildings/LOD1/tilejson.json"], "old-lod1-tilejson");
		assert.match(result.files["WienBuildings/LOD21/release.json"], /^[a-f0-9]{20}$/);
		assert.match(result.files["WienBuildings/LOD21/targets.json"], /^[a-f0-9]{20}$/);
	});
});
