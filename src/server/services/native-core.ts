import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../../lib/path-utils.ts";

const BINARY_NAME = "inferay-native-diff";

function candidatePaths(): string[] {
	return [
		resolve(PROJECT_ROOT, "native/bin", BINARY_NAME),
		resolve(PROJECT_ROOT, "native/diff-engine/target/release", BINARY_NAME),
		resolve(PROJECT_ROOT, "native/diff-engine/target/debug", BINARY_NAME),
	];
}

export function resolveNativeCoreBinary(): string | null {
	for (const path of candidatePaths()) {
		if (existsSync(path)) return path;
	}
	return null;
}

export async function runNativeCore<TRequest, TResponse>(
	payload: TRequest
): Promise<TResponse | null> {
	const binary = resolveNativeCoreBinary();
	if (!binary) return null;

	try {
		const proc = Bun.spawn([binary], {
			stdin: new Blob([JSON.stringify(payload)]),
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		if (exitCode !== 0) {
			console.error("[native-core] sidecar failed:", stderr.trim());
			return null;
		}

		return JSON.parse(stdout) as TResponse;
	} catch (error) {
		console.error("[native-core] execution failed:", error);
		return null;
	}
}
