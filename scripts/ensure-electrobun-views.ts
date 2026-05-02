#!/usr/bin/env bun

import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;

if (!buildDir) {
	process.exit(0);
}

const sourceIndex = join(process.cwd(), "dist", "index.html");

try {
	const entries = await readdir(buildDir, { withFileTypes: true });
	const apps = entries.filter(
		(entry) => entry.isDirectory() && entry.name.endsWith(".app")
	);

	for (const app of apps) {
		const viewsDir = join(
			buildDir,
			app.name,
			"Contents",
			"Resources",
			"app",
			"views"
		);
		await copyFile(sourceIndex, join(viewsDir, "index.html"));
		console.log(`[views] copied index.html -> ${app.name}`);
	}
} catch (error) {
	console.warn(
		`[views] could not copy renderer index: ${
			error instanceof Error ? error.message : String(error)
		}`
	);
}
