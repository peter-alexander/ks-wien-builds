#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";

const host = "www.wien.gv.at";
const base = "https://" + host;
const zipBase = base + "/MA41datenviewer/downloads/geodaten/lod2_gml/";
const target = zipBase + "078085_lod2_gml.zip";
const external = "https://example.com/";
const mode = process.argv[2];
const output = process.env.DIAG_OUTPUT || path.resolve("lod21-connection-block-" + mode + ".json");
const maxSheets = 120;
const startIntervalMs = 1500;
const observerIntervalMs = 45000;
const observerDurationMs = 720000;
const postFailureOffsetsMs = [0, 120000, 300000, 600000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const commandName = process.platform === "win32" ? "curl.exe" : "curl";
const records = [];
const startTime = Date.now();

function record(kind, detail) {
	const value = { at: new Date().toISOString(), elapsedSeconds: Math.round((Date.now() - startTime) / 1000), kind, ...detail };
	records.push(value);
	console.log(JSON.stringify(value));
	return value;
}

function execute(command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", error = null;
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-1200); });
		child.on("error", (e) => { error = String(e); });
		child.on("close", (code) => resolve({ code, stdout, stderr, error }));
	});
}

async function addresses() {
	try {
		return await dns.lookup(host, { all: true });
	} catch (error) {
		return { error: String(error) };
	}
}

async function publicIp() {
	const response = await execute(commandName, ["--silent", "--show-error", "--max-time", "8", "https://api.ipify.org/"]);
	return response.code === 0 ? response.stdout.trim() : null;
}

async function curlProbe(label, url, extraArgs = []) {
	const args = [
		"--head", "--location", "--proto", "=https", "--proto-redir", "=https",
		"--max-redirs", "4", "--connect-timeout", "8", "--max-time", "13",
		"--retry", "0", "--silent", "--show-error", "--output", os.devNull,
		"--write-out", "%{json}", ...extraArgs, url
	];
	const r = await execute(commandName, args);
	let values = {};
	try { values = JSON.parse(r.stdout); } catch { /* a failed transfer can produce no metrics */ }
	return record(label, {
		url, exitCode: r.code, spawnError: r.error,
		httpStatus: Number(values.response_code || values.http_code || 0),
		remoteIp: values.remote_ip || null,
		localIp: values.local_ip || null,
		dnsSeconds: values.time_namelookup ?? null,
		tcpSeconds: values.time_connect ?? null,
		tlsSeconds: values.time_appconnect ?? null,
		firstByteSeconds: values.time_starttransfer ?? null,
		totalSeconds: values.time_total ?? null,
		redirects: values.num_redirects ?? null,
		error: r.stderr.trim().slice(0, 500) || null
	});
}

async function probeSet(phase, pinnedIp = null) {
	record("dns", { phase, addresses: await addresses() });
	await curlProbe("target-head", target, []);
	if (pinnedIp) {
		await curlProbe("target-pinned-ip", target, [
			"--resolve", host + ":443:" + pinnedIp
		]);
	}
	await curlProbe("same-host-home", base + "/", []);
	await curlProbe("external-control", external, []);
}

async function fullZip(sheet) {
	const file = path.join(os.tmpdir(), "lod21-diagnostic-" + process.pid + "-" + sheet + ".zip");
	const args = [
		"--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
		"--max-redirs", "4", "--connect-timeout", "8", "--max-time", "40",
		"--retry", "0", "--max-filesize", "100000000",
		"--silent", "--show-error", "--output", file,
		"--write-out", "%{json}", zipBase + sheet + "_lod2_gml.zip"
	];
	const r = await execute(commandName, args);
	let metrics = {};
	try { metrics = JSON.parse(r.stdout); } catch {}
	let bytes = 0, signature = null;
	try {
		const stat = await fs.stat(file);
		bytes = stat.size;
		const handle = await fs.open(file, "r");
		try {
			const buf = Buffer.alloc(4);
			await handle.read(buf, 0, 4, 0);
			signature = buf.toString("hex");
		} finally { await handle.close(); }
	} catch {}
	finally { await fs.rm(file, { force: true }); }
	const ok = r.code === 0 && Number(metrics.response_code || 0) === 200 && signature === "504b0304";
	return record("full-download", {
		sheet, ok, exitCode: r.code, httpStatus: Number(metrics.response_code || 0),
		bytes, zipSignature: signature, remoteIp: metrics.remote_ip || null,
		dnsSeconds: metrics.time_namelookup ?? null,
		tcpSeconds: metrics.time_connect ?? null,
		tlsSeconds: metrics.time_appconnect ?? null,
		firstByteSeconds: metrics.time_starttransfer ?? null,
		totalSeconds: metrics.time_total ?? null,
		error: r.stderr.trim().slice(0, 500) || null
	});
}

async function load() {
	const manifest = JSON.parse(await fs.readFile("wien-lod21/targets.production.json", "utf8"));
	const sheets = [...new Set(manifest.buildings.map((b) => String(b.sheet)))].sort().slice(0, maxSheets);
	record("configuration", { mode, sheets: sheets.length, parallel: 2, intervalMs: startIntervalMs, firstSheet: sheets[0] });
	await probeSet("baseline");
	record("startup-grace", { durationSeconds: 25 });
	await sleep(25000);
	let index = 0, consecutiveFailures = 0, blocked = false, nextStart = 0;
	let gate = Promise.resolve();
	async function reserveStart() {
		let release;
		const prev = gate;
		gate = new Promise((resolve) => { release = resolve; });
		await prev;
		try {
			if (blocked) return false;
			await sleep(Math.max(0, nextStart - Date.now()));
			if (blocked) return false;
			nextStart = Date.now() + startIntervalMs;
			return true;
		} finally { release(); }
	}
	async function worker() {
		while (!blocked && index < sheets.length) {
			const sheet = sheets[index++];
			if (!(await reserveStart())) return;
			const r = await fullZip(sheet);
			if (r.ok) {
				consecutiveFailures = 0;
			} else {
				consecutiveFailures++;
				if (consecutiveFailures >= 2) {
					blocked = true;
					record("suspected-block", { afterStarted: index, consecutiveFailures });
				}
			}
		}
	}
	await Promise.all([worker(), worker()]);
	record("load-finished", {
		blocked, sheetsStarted: index, successful: records.filter((r) => r.kind === "full-download" && r.ok).length,
		failures: records.filter((r) => r.kind === "full-download" && !r.ok).length
	});
	if (!blocked) return;
	const resolved = await addresses();
	const pinnedIp = Array.isArray(resolved) ? resolved.find((a) => a.family === 4)?.address : null;
	const failureAt = Date.now();
	for (const offset of postFailureOffsetsMs) {
		await sleep(Math.max(0, failureAt + offset - Date.now()));
		record("recovery-check", { afterFailureSeconds: offset / 1000 });
		await probeSet("after-" + offset / 1000 + "s", pinnedIp);
	}
}

async function observe() {
	record("configuration", { mode, intervalSeconds: observerIntervalMs / 1000,
		durationSeconds: observerDurationMs / 1000 });
	for (let offset = 0; offset <= observerDurationMs; offset += observerIntervalMs) {
		await sleep(Math.max(0, startTime + offset - Date.now()));
		record("observer-check", { scheduledSeconds: offset / 1000 });
		await probeSet("observer-" + offset / 1000 + "s");
	}
}

async function main() {
	if (mode !== "load" && mode !== "observe") throw new Error("Use load or observe");
	const result = { mode, os: process.platform, runnerName: process.env.RUNNER_NAME || "",
		runnerOs: process.env.RUNNER_OS || "", runnerArch: process.env.RUNNER_ARCH || "",
		publicEgressIp: await publicIp(), startedAt: new Date().toISOString() };
	record("environment", result);
	try {
		if (mode === "load") await load();
		else await observe();
	} finally {
		await fs.mkdir(path.dirname(output), { recursive: true });
		const summary = {
			...result, finishedAt: new Date().toISOString(),
			fullDownloadOk: records.filter((r) => r.kind === "full-download" && r.ok).length,
			fullDownloadFailures: records.filter((r) => r.kind === "full-download" && !r.ok).length,
			events: records
		};
		await fs.writeFile(output, JSON.stringify(summary, null, "\t") + "\n");
		console.log("Diagnostic written to " + output);
	}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
