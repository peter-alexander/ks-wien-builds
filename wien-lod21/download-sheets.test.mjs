import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadBatch, optionsFrom, selectedSheets } from "./download-sheets.mjs";

const settings = { parallel: 1, intervalMs: 0, attempts: 3, threshold: 2,
	cooldownMs: 0, maxCooldowns: 2, retryMs: 0 };

async function temporary(fn) {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "lod21-test-"));
	try { await fn(cacheDir); } finally { await fs.rm(cacheDir, { recursive: true, force: true }); }
}

test("unique sorted sheets, valid sheet IDs and bounded parallelism", () => {
	assert.deepEqual(selectedSheets({ buildings: [{ sheet: "105080" }, { sheet: "104078" },
		{ sheet: "105080" }] }, 2), ["104078", "105080"]);
	assert.deepEqual(selectedSheets({ buildings: [{ sheet: "105080" }, { sheet: "104078" },
		{ sheet: "106082" }] }, 1, 1), ["105080"]);
	assert.throws(() => selectedSheets({ buildings: [{ sheet: "../a" }] }), /Invalid/);
	assert.throws(() => optionsFrom(["--parallel", "0"]), /parallel/);
});

test("verified ZIPs are reused; corrupted ZIPs are replaced atomically", async () => {
	await temporary(async (cacheDir) => {
		await fs.writeFile(path.join(cacheDir, "104078_lod2_gml.zip"), "good");
		await fs.writeFile(path.join(cacheDir, "105080_lod2_gml.zip"), "bad");
		const fetched = [];
		const mock = {
			validate: async (file) => (await fs.readFile(file, "utf8").catch(() => null)) === "good",
			fetch: async (sheet, file) => {
				fetched.push(sheet);
				await fs.writeFile(file, "good");
				return { httpStatus: 200 };
			}
		};
		const a = await downloadBatch(["104078", "105080"], { ...settings, cacheDir }, mock);
		assert.equal(a.success, true);
		assert.equal(a.cached, 1);
		assert.equal(a.downloaded, 1);
		assert.deepEqual(fetched, ["105080"]);
		const b = await downloadBatch(["104078", "105080"], { ...settings, cacheDir }, mock);
		assert.equal(b.cached, 2);
		assert.equal(b.downloaded, 0);
	});
});

test("repeated transient failures cause cooldown, then resume", async () => {
	await temporary(async (cacheDir) => {
		let failures = 0, elapsed = 0;
		const result = await downloadBatch(["104078", "105080"], {
			...settings, cacheDir, cooldownMs: 100
		}, {
			validate: async (file) => (await fs.readFile(file, "utf8").catch(() => null)) === "good",
			fetch: async (_sheet, file) => {
				if (failures++ < 2) throw Object.assign(new Error("timeout"), { curlCode: 28 });
				await fs.writeFile(file, "good");
			},
			sleep: async (ms) => { elapsed += ms; },
			clock: () => elapsed
		});
		assert.equal(result.success, true);
		assert.equal(result.cooldowns, 1);
		assert.equal(result.downloaded, 2);
		assert.equal(result.attempts, 4);
	});
});

test("exhausted attempts stop safely and do not persist partial ZIPs", async () => {
	await temporary(async (cacheDir) => {
		const result = await downloadBatch(["104078", "105080"], {
			...settings, cacheDir, attempts: 2, maxCooldowns: 0
		}, {
			validate: async () => false,
			fetch: async (_sheet, file) => {
				await fs.writeFile(file, "partial");
				throw new Error("connection failed");
			}
		});
		assert.equal(result.success, false);
		assert.equal(result.failed.length, 1);
		assert.equal(result.skipped, 1);
		assert.deepEqual(await fs.readdir(cacheDir), []);
	});
});
