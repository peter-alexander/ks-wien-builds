#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = "https://www.wien.gv.at/MA41datenviewer/downloads/geodaten/lod2_gml";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function number(value, name, low, high) {
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n < low || n > high) throw new Error(name + " must be between " + low + " and " + high);
	return n;
}

export function optionsFrom(argv = process.argv.slice(2), env = process.env) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i]?.startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Expected --option value at " + argv[i]);
		args[argv[i].slice(2)] = argv[i + 1];
	}
	const allowed = ["targets", "cache-dir", "summary", "limit", "parallel", "interval-ms", "attempts",
		"threshold", "cooldown-ms", "max-cooldowns", "retry-ms"];
	for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error("Unknown option " + key);
	return {
		targets: path.resolve(args.targets || env.WIEN_LOD21_TARGETS || "wien-lod21/targets.pilot.json"),
		cacheDir: path.resolve(args["cache-dir"] || env.WIEN_LOD21_DOWNLOAD_DIR || "wien-lod21/build/downloads"),
		summary: path.resolve(args.summary || "wien-lod21/build/download-report.json"),
		limit: number(args.limit ?? 100000, "limit", 1, 100000),
		parallel: number(args.parallel ?? env.WIEN_LOD21_DOWNLOAD_PARALLEL ?? 2, "parallel", 1, 8),
		intervalMs: number(args["interval-ms"] ?? env.WIEN_LOD21_INTERVAL_MS ?? 1500, "interval-ms", 0, 60000),
		attempts: number(args.attempts ?? env.WIEN_LOD21_DOWNLOAD_ATTEMPTS ?? 3, "attempts", 1, 10),
		threshold: number(args.threshold ?? env.WIEN_LOD21_FAILURE_THRESHOLD ?? 2, "threshold", 1, 20),
		cooldownMs: number(args["cooldown-ms"] ?? env.WIEN_LOD21_COOLDOWN_MS ?? 90000, "cooldown-ms", 0, 1800000),
		maxCooldowns: number(args["max-cooldowns"] ?? env.WIEN_LOD21_MAX_COOLDOWNS ?? 2, "max-cooldowns", 0, 20),
		retryMs: number(args["retry-ms"] ?? env.WIEN_LOD21_RETRY_MS ?? 3000, "retry-ms", 0, 60000)
	};
}

export function selectedSheets(data, limit = Infinity) {
	if (!Array.isArray(data?.buildings)) throw new Error("Invalid target manifest");
	const sheets = [...new Set(data.buildings.map((item) => String(item.sheet)))].sort();
	if (!sheets.length || sheets.some((id) => !/^[0-9]{6}$/.test(id))) throw new Error("Invalid sheet identifier");
	return sheets.slice(0, limit);
}

function command(bin, args) {
	return new Promise((resolve, reject) => {
		const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		proc.stdout.on("data", (data) => { stdout += data.toString(); });
		proc.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-1000); });
		proc.on("error", reject);
		proc.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

async function validZip(file) {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile() || stat.size === 0) return false;
		return (await command("unzip", ["-tqq", file])).code === 0;
	} catch { return false; }
}

async function downloadZip(sheet, file) {
	const result = await command("curl", [
		"--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
		"--max-redirs", "5", "--connect-timeout", "20", "--max-time", "120",
		"--retry", "0", "--max-filesize", "100000000",
		"--silent", "--show-error", "--user-agent", "ks-wien-builds/wien-lod21",
		"--output", file, "--write-out", "%{http_code}|%{remote_ip}|%{time_total}",
		BASE + "/" + sheet + "_lod2_gml.zip"
	]);
	const [status, ip, seconds] = result.stdout.trim().split("|");
	if (result.code !== 0 || !/^2[0-9][0-9]$/.test(status || "")) {
		const error = new Error("curl=" + result.code + ", HTTP=" + status + ": " + result.stderr);
		error.curlCode = result.code;
		error.httpStatus = Number(status || 0);
		throw error;
	}
	return { httpStatus: Number(status), ip, seconds: Number(seconds) };
}

export async function downloadBatch(sheets, config, overrides = {}) {
	const fetch = overrides.fetch || downloadZip;
	const validate = overrides.validate || validZip;
	const sleep = overrides.sleep || wait;
	const clock = overrides.clock || Date.now;
	const emit = overrides.emit || (() => {});
	await fs.mkdir(config.cacheDir, { recursive: true });
	const report = { startedAt: new Date().toISOString(), requested: sheets.length,
		downloaded: 0, cached: 0, failed: [], attempts: 0, cooldowns: 0, events: [] };
	let cursor = 0, stop = false, streak = 0, cooldownUntil = 0, nextStart = 0;
	let gate = Promise.resolve();
	const log = (kind, details) => {
		const entry = { at: new Date().toISOString(), kind, ...details };
		report.events.push(entry);
		emit(entry);
	};
	async function throttle() {
		let release;
		const previous = gate;
		gate = new Promise((resolve) => { release = resolve; });
		await previous;
		try {
			while (!stop) {
				const pause = Math.max(cooldownUntil, nextStart) - clock();
				if (pause <= 0) {
					nextStart = clock() + config.intervalMs;
					return true;
				}
				await sleep(pause);
			}
			return false;
		} finally { release(); }
	}
	async function one(sheet) {
		const file = path.join(config.cacheDir, sheet + "_lod2_gml.zip");
		if (await validate(file)) {
			report.cached++;
			log("cached", { sheet });
			return;
		}
		await fs.rm(file, { force: true });
		for (let attempt = 1; attempt <= config.attempts && !stop; attempt++) {
			if (!(await throttle())) break;
			const partial = file + ".partial-" + process.pid + "-" + attempt;
			report.attempts++;
			try {
				const response = await fetch(sheet, partial);
				if (!(await validate(partial))) throw new Error("Invalid downloaded ZIP");
				await fs.rename(partial, file);
				streak = 0;
				report.downloaded++;
				log("downloaded", { sheet, attempt, ...response });
				return;
			} catch (error) {
				streak++;
				log("failure", { sheet, attempt, code: error.curlCode ?? null,
					httpStatus: error.httpStatus ?? null, error: String(error.message).slice(0, 300) });
				if (streak >= config.threshold) {
					streak = 0;
					report.cooldowns++;
					if (report.cooldowns > config.maxCooldowns) {
						stop = true;
						log("stop", { reason: "Maximum cooldowns exceeded" });
					} else {
						cooldownUntil = Math.max(cooldownUntil, clock() + config.cooldownMs);
						log("cooldown", { ms: config.cooldownMs });
					}
				}
			} finally { await fs.rm(partial, { force: true }); }
			if (attempt < config.attempts && !stop) await sleep(config.retryMs * attempt);
		}
		stop = true;
		report.failed.push(sheet);
		log("failed-sheet", { sheet });
	}
	const workers = Array.from({ length: Math.min(config.parallel, sheets.length) }, async () => {
		while (!stop && cursor < sheets.length) await one(sheets[cursor++]);
	});
	await Promise.all(workers);
	report.finishedAt = new Date().toISOString();
	report.skipped = report.requested - report.downloaded - report.cached - report.failed.length;
	report.success = report.failed.length === 0 && report.skipped === 0;
	return report;
}

async function main() {
	const opts = optionsFrom();
	const targets = JSON.parse(await fs.readFile(opts.targets, "utf8"));
	const sheets = selectedSheets(targets, opts.limit);
	await fs.mkdir(path.dirname(opts.summary), { recursive: true });
	console.log("LOD2.1: " + sheets.length + " sheets, parallel=" + opts.parallel + ", interval=" + opts.intervalMs + "ms");
	const report = await downloadBatch(sheets, opts, { emit: (entry) => console.log(JSON.stringify(entry)) });
	await fs.writeFile(opts.summary, JSON.stringify({ options: opts, ...report }, null, "\t") + "\n");
	console.log("Result: " + JSON.stringify({
		success: report.success, requested: report.requested, downloaded: report.downloaded,
		cached: report.cached, failed: report.failed, skipped: report.skipped, cooldowns: report.cooldowns
	}));
	if (!report.success) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error); process.exitCode = 1; });
}
