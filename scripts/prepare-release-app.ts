#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGE_JSON = join(ROOT, "packages", "inferay", "package.json");
const APP_NAME = "inferay";
const APP_IDENTIFIER = "com.inferay.app";

function usage(): never {
	console.error("Usage: bun scripts/prepare-release-app.ts <path-to-app>");
	process.exit(1);
}

async function run(cmd: string[]) {
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			`command failed (${exitCode}): ${cmd.join(" ")}\n${stdout}${stderr}`
		);
	}
	return stdout.trim();
}

async function plistSet(plist: string, key: string, value: string) {
	const setResult = Bun.spawnSync([
		"/usr/libexec/PlistBuddy",
		"-c",
		`Set :${key} ${value}`,
		plist,
	]);
	if (setResult.exitCode === 0) return;
	await run([
		"/usr/libexec/PlistBuddy",
		"-c",
		`Add :${key} string ${value}`,
		plist,
	]);
}

function bundleVersion(version: string) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`invalid package version: ${version}`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	return String(major * 1_000_000 + minor * 1_000 + patch);
}

async function assertFile(path: string) {
	if (!existsSync(path)) throw new Error(`missing release app file: ${path}`);
}

async function hashTree(root: string, skip: Set<string>) {
	const hash = createHash("sha256");

	async function visit(path: string) {
		const rel = relative(root, path);
		if (skip.has(rel) || rel.endsWith("/.DS_Store")) return;

		const entries = await readdir(path, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of entries) {
			const child = join(path, entry.name);
			const childRel = relative(root, child);
			if (skip.has(childRel) || entry.name === ".DS_Store") continue;

			if (entry.isDirectory()) {
				hash.update(`dir:${childRel}\0`);
				await visit(child);
				continue;
			}

			if (!entry.isFile()) continue;
			const info = await stat(child);
			hash.update(`file:${childRel}:${info.mode}\0`);
			hash.update(await readFile(child));
		}
	}

	await visit(root);
	return hash.digest("hex").slice(0, 12);
}

async function main() {
	const appPath = process.argv[2] ? resolve(process.argv[2]) : usage();
	if (!appPath.endsWith(".app") || !existsSync(appPath)) usage();

	const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
	const version = pkg.version;
	if (typeof version !== "string") {
		throw new Error("packages/inferay/package.json is missing version");
	}

	const plist = join(appPath, "Contents", "Info.plist");
	const resources = join(appPath, "Contents", "Resources");
	const versionJson = join(resources, "version.json");

	await assertFile(plist);
	await assertFile(join(appPath, "Contents", "MacOS", "launcher"));
	await assertFile(join(resources, "app", "bun", "index.js"));
	await assertFile(join(resources, "app", "views", "index.html"));
	await assertFile(join(resources, "app", "views", "main.js"));

	await plistSet(plist, "CFBundleName", APP_NAME);
	await plistSet(plist, "CFBundleDisplayName", APP_NAME);
	await plistSet(plist, "CFBundleIdentifier", APP_IDENTIFIER);
	await plistSet(plist, "CFBundleShortVersionString", version);
	await plistSet(plist, "CFBundleVersion", bundleVersion(version));

	const contentHash = await hashTree(
		appPath,
		new Set(["Contents/Resources/version.json"])
	);
	const versionInfo = {
		version,
		hash: contentHash,
		channel: "stable",
		baseUrl: "",
		name: APP_NAME,
		identifier: APP_IDENTIFIER,
	};

	await writeFile(versionJson, `${JSON.stringify(versionInfo, null, "\t")}\n`);
	console.log(
		`[release-app] prepared ${APP_NAME}.app ${version} (${contentHash})`
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
