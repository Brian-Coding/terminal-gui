import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../../lib/path-utils.ts";

export interface DiffLine {
	type: "unchanged" | "added" | "removed";
	content: string;
	oldLineNum?: number;
	newLineNum?: number;
}

export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
}

export interface ParsedDiff {
	hunks: DiffHunk[];
	oldLines: DiffLine[];
	newLines: DiffLine[];
	stats: { added: number; removed: number; unchanged: number };
	computedAt: number;
}

interface NativeDiffRequest {
	before: string;
	after: string;
}

const BINARY_NAME = "inferay-native-diff";

function candidatePaths(): string[] {
	return [
		resolve(PROJECT_ROOT, "native/bin", BINARY_NAME),
		resolve(PROJECT_ROOT, "native/diff-engine/target/release", BINARY_NAME),
		resolve(PROJECT_ROOT, "native/diff-engine/target/debug", BINARY_NAME),
	];
}

export function resolveNativeDiffBinary(): string | null {
	for (const path of candidatePaths()) {
		if (existsSync(path)) return path;
	}
	return null;
}

export async function computeNativeDiff(
	before: string,
	after: string
): Promise<ParsedDiff | null> {
	const binary = resolveNativeDiffBinary();
	if (!binary) return null;

	const proc = Bun.spawn([binary], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const payload: NativeDiffRequest = { before, after };

	try {
		proc.stdin.write(JSON.stringify(payload));
		proc.stdin.end();

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		if (exitCode !== 0) {
			console.error("[native-diff] sidecar failed:", stderr.trim());
			return null;
		}

		const parsed = JSON.parse(stdout) as ParsedDiff;
		parsed.computedAt = Date.now();
		return parsed;
	} catch (error) {
		console.error("[native-diff] execution failed:", error);
		return null;
	}
}
