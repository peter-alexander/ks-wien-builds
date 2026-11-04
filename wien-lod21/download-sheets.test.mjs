import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadBatch, optionsFrom, selectedSheets, parseResponseValidators } from "./download-sheets.mjs";

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

test("HTTP validator parser uses final response after redirects", () => {
	const headers = [
		"HTTP/1.1 302 Found\\r\\nLocation: elsewhere\\r\\nETag: bad\\r\\n",
		"HTTP/2 200\\r\\nETag: \\"version-7\\"\\r\\nLast-Modified: Mon, 02 Nov 2026 11:00:00 GMT\\r\\nContent-Length: 8192\\r\\n"
	].join("\\r\\n");
	assert.deepEqual(parseResponseValidators(headers), {
		etag: '"version-7"',
		lastModified: "Mon, 02 Nov 2026 11:00:00 GMT",
		contentLength: "8192"
	});
});

test("conditional HTTP 304 reuses verified ZIP without downloading body", async () => {
	await temporary(async cacheDir => {
		const sheet = "104078";
		const file = path.join(cacheDir, sheet + "_lod2_gml.zip");
		await fs.writeFile(file, "known-valid");
		await fs.writeFile(file + ".http.json", JSON.stringify({
			schemaVersion: 1, sheet, etag: '"etag1"', sha256: "placeholder"
		}));
		let calls = 0;
		const result = await downloadBatch([sheet], {
			...settings, cacheDir, revalidate: "conditional"
		}, {
			validate: async file => (await fs.readFile(file, "utf8").catch(() => "")) === "known-valid",
			fetch: async (_sheet, _partial, validators) => {
				calls++;
				assert.equal(validators.etag, '"etag1"');
				return { httpStatus: 304 };
			}
		});
		assert.equal(result.success, true);
		assert.equal(result.cached, 1);
		assert.equal(result.notModified, 1);
		assert.equal(result.downloaded, 0);
		assert.equal(calls, 1);
		assert.equal(await fs.readFile(file, "utf8"), "known-valid");
	});
});

test("changed ETag replaces ZIP and saves a new SHA256/validator", async () => {
	await temporary(async cacheDir => {
		const sheet = "104078";
		const file = path.join(cacheDir, sheet + "_lod2_gml.zip");
		await fs.writeFile(file, "old");
		await fs.writeFile(file + ".http.json", JSON.stringify({
			schemaVersion: 1, sheet, etag: '"etag1"'
		}));
		const report = await downloadBatch([sheet], {
			...settings, cacheDir, revalidate: "strict"
		}, {
			validate: async file => ["old", "new"].includes(
				await fs.readFile(file, "utf8").catch(() => "")
			),
			fetch: async (_sheet, partial, validators) => {
				assert.equal(validators.etag, '"etag1"');
				await fs.writeFile(partial, "new");
				return { httpStatus: 200, etag: '"etag2"', contentLength: "3" };
			}
		});
		assert.equal(report.downloaded, 1);
		assert.equal(report.cached, 0);
		assert.equal(await fs.readFile(file, "utf8"), "new");
		const metadata = JSON.parse(await fs.readFile(file + ".http.json"));
		assert.equal(metadata.etag, '"etag2"');
		assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
	});
});

test("missing validator is explicitly marked unverified or strictly redownloaded", async () => {
	await temporary(async cacheDir => {
		const sheet = "104078";
		const file = path.join(cacheDir, sheet + "_lod2_gml.zip");
		await fs.writeFile(file, "good");
		let calls = 0;
		const mocks = {
			validate: async name => (await fs.readFile(name, "utf8").catch(() => "")) === "good",
			fetch: async (_sheet, partial) => {
				calls++;
				await fs.writeFile(partial, "good");
				return { httpStatus: 200 };
			}
		};
		const a = await downloadBatch([sheet], {
			...settings, cacheDir, revalidate: "conditional"
		}, mocks);
		assert.equal(a.cachedUnverified, 1);
		assert.equal(calls, 0);
		const b = await downloadBatch([sheet], {
			...settings, cacheDir, revalidate: "strict"
		}, mocks);
		assert.equal(b.downloaded, 1);
		assert.equal(calls, 1);
	});
});

test("revalidation failure never destroys the last validated source archive", async () => {
	await temporary(async cacheDir => {
		const sheet = "104078";
		const file = path.join(cacheDir, sheet + "_lod2_gml.zip");
		await fs.writeFile(file, "good");
		await fs.writeFile(file + ".http.json", JSON.stringify({
			schemaVersion: 1, sheet, lastModified: "Mon, 02 Nov 2026 11:00:00 GMT"
		}));
		const result = await downloadBatch([sheet], {
			...settings, cacheDir, attempts: 1, revalidate: "conditional"
		}, {
			validate: async name => (await fs.readFile(name, "utf8").catch(() => "")) === "good",
			fetch: async (_sheet, _file, validators) => {
				assert.ok(validators.lastModified);
				throw new Error("upstream offline");
			}
		});
		assert.equal(result.success, false);
		assert.deepEqual(result.failed, [sheet]);
		assert.equal(await fs.readFile(file, "utf8"), "good");
	});
});
