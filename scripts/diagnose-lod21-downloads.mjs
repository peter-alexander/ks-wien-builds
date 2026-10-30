#!/usr/bin/env node
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const outputDir = path.resolve(process.argv[2] || "lod21-download-diagnostics");
const host = "www.wien.gv.at";
const baseUrl = "https://" + host + "/MA41datenviewer/downloads/geodaten/lod2_gml/";
const sheets = ["104078", "105080", "105082", "106082"];
const agents = [
	{ name: "old", value: "kartensammlung-overlay-builds/wien-lod21" },
	{ name: "new", value: "ks-wien-builds/wien-lod21" }
];

await fs.mkdir(outputDir, { recursive: true });

function execute(command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let spawnError = null;
		child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
		child.on("error", (error) => { spawnError = error.message; });
		child.on("close", (code, signal) => {
			resolve({ code, signal, stdout, stderr, spawnError });
		});
	});
}

const curlVersion = await execute("curl", ["--version"]);
if (curlVersion.code !== 0) {
	throw new Error("curl unavailable: " + curlVersion.stderr);
}

let addresses;
try {
	addresses = await dns.lookup(host, { all: true });
} catch (error) {
	addresses = { error: String(error) };
}
const environment = {
	createdAt: new Date().toISOString(),
	runnerOs: process.env.RUNNER_OS || os.platform(),
	runnerName: process.env.RUNNER_NAME || "",
	hostname: os.hostname(),
	nodeVersion: process.version,
	curlVersion: curlVersion.stdout.trim(),
	dnsAddresses: addresses,
	host,
	baseUrl,
	sheets,
	agents
};
await fs.writeFile(path.join(outputDir, "environment.json"), JSON.stringify(environment, null, "\t") + "\n");

async function probe(mode, agent, sheet) {
	const name = mode + "-" + agent.name + "-" + sheet;
	const url = baseUrl + sheet + "_lod2_gml.zip";
	const headersFile = path.join(outputDir, name + ".headers.txt");
	const verboseFile = path.join(outputDir, name + ".verbose.txt");
	const args = [
		"--location",
		"--proto", "=https",
		"--proto-redir", "=https",
		"--max-redirs", "5",
		"--connect-timeout", "12",
		"--max-time", "30",
		"--retry", "0",
		"--range", "0-0",
		"--max-filesize", "65536",
		"--user-agent", agent.value,
		"--verbose",
		"--silent",
		"--show-error",
		"--output", os.devNull,
		"--dump-header", headersFile,
		"--write-out", "%{json}",
		url
	];
	const started = new Date().toISOString();
	const command = await execute("curl", args);
	await fs.writeFile(verboseFile, command.stderr);
	let metrics = {};
	let parseError = null;
	try {
		metrics = JSON.parse(command.stdout);
	} catch (error) {
		parseError = String(error);
	}
	const result = {
		mode,
		agent: agent.name,
		userAgent: agent.value,
		sheet,
		started,
		curlExitCode: command.code,
		curlSignal: command.signal,
		spawnError: command.spawnError,
		metricsParseError: parseError,
		httpStatus: Number(metrics.response_code || metrics.http_code || 0),
		httpVersion: metrics.http_version ?? "",
		ip: metrics.remote_ip ?? "",
		redirects: metrics.num_redirects ?? 0,
		effectiveUrl: metrics.url_effective ?? "",
		dnsSeconds: metrics.time_namelookup ?? null,
		tcpSeconds: metrics.time_connect ?? null,
		tlsSeconds: metrics.time_appconnect ?? null,
		firstByteSeconds: metrics.time_starttransfer ?? null,
		totalSeconds: metrics.time_total ?? null,
		bytesDownloaded: metrics.size_download ?? 0,
		contentType: metrics.content_type ?? "",
		headersFile: path.basename(headersFile),
		verboseFile: path.basename(verboseFile)
	};
	await fs.writeFile(path.join(outputDir, name + ".json"), JSON.stringify(result, null, "\t") + "\n");
	console.log(JSON.stringify({
		mode, agent: agent.name, sheet, curlExitCode: result.curlExitCode,
		httpStatus: result.httpStatus, ip: result.ip,
		dnsSeconds: result.dnsSeconds, tcpSeconds: result.tcpSeconds,
		tlsSeconds: result.tlsSeconds, totalSeconds: result.totalSeconds
	}));
	return result;
}

const results = [];
for (let i = 0; i < sheets.length; i++) {
	const order = i % 2 === 0 ? agents : [...agents].reverse();
	for (const agent of order) {
		results.push(await probe("serial", agent, sheets[i]));
	}
}
for (let batch = 0; batch < 2; batch++) {
	const requests = sheets.map((sheet, index) => ({
		sheet,
		agent: agents[(index + batch) % 2]
	}));
	const batchResults = await Promise.all(
		requests.map(({ sheet, agent }) => probe("parallel-" + (batch + 1), agent, sheet))
	);
	results.push(...batchResults);
}

const format = (value) => value == null || value === "" ? "–" : String(value);
const time = (value) => value == null ? "–" : Number(value).toFixed(3);
const summary = [
	"# Wiener LOD2.1: Download-Netzwerkdiagnose",
	"",
	"Vier Produktionsblätter, jeweils mit altem und neuem User-Agent, zuerst seriell und danach in zwei Batches mit vier parallelen Verbindungen.",
	"HTTP-GET mit Range 0–0 und maximal 64 KiB Download; keine vollständigen ZIP-Downloads und keine Retries.",
	"",
	"**Wichtig:** HTTP 200/206 bei curl-Exit 63 kann bedeuten, dass der Server Range ignoriert hat und der Download absichtlich durch das Größenlimit abgebrochen wurde. Das ist kein TCP-/TLS-Verbindungsfehler. Range-GET ist nicht vollständig mit dem produktiven GET vergleichbar.",
	"",
	"| Modus | UA | Blatt | curl | HTTP | IP | DNS s | TCP s | TLS s | First byte s | Gesamt s |",
	"|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|",
	...results.map((r) => "| " + [
		r.mode, r.agent, r.sheet, format(r.curlExitCode),
		r.httpStatus, format(r.ip), time(r.dnsSeconds),
		time(r.tcpSeconds), time(r.tlsSeconds),
		time(r.firstByteSeconds), time(r.totalSeconds)
	].join(" | ") + " |"),
	"",
	"Alle Redirects und HTTP-Header stehen in den *.headers.txt-Dateien; TLS-, Verbindungs- und curl-Fehler in den *.verbose.txt-Dateien. Die Umgebung und DNS-Antworten stehen in environment.json.",
	""
].join("\n");
await fs.writeFile(path.join(outputDir, "summary.md"), summary);
await fs.writeFile(path.join(outputDir, "summary.json"), JSON.stringify({ environment, results }, null, "\t") + "\n");
console.log("\n" + summary);
