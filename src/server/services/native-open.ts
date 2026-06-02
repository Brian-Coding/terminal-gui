import { platform, tmpdir } from "node:os";
import { join } from "node:path";

interface UpdateLaunchResult {
	ok: boolean;
	logPath?: string;
	error?: string;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function runInferayUpdate(): UpdateLaunchResult {
	const probe = Bun.spawnSync([
		"/bin/zsh",
		"-lc",
		"command -v npx >/dev/null 2>&1 || command -v bunx >/dev/null 2>&1",
	]);
	if (probe.exitCode !== 0) {
		return {
			ok: false,
			error: "npx or bunx is required to update Inferay",
		};
	}

	const logPath = join(tmpdir(), `inferay-update-${Date.now()}.log`);
	const updateCommand = [
		"if command -v npx >/dev/null 2>&1; then",
		"npx --yes inferay update;",
		"elif command -v bunx >/dev/null 2>&1; then",
		"bunx inferay update;",
		"else",
		"echo 'npx or bunx is required to update Inferay' >&2;",
		"exit 127;",
		"fi",
	].join(" ");
	const command = [
		"nohup",
		"/bin/zsh",
		"-lc",
		shellQuote(updateCommand),
		`>${shellQuote(logPath)}`,
		"2>&1",
		"&",
	].join(" ");
	try {
		Bun.spawn(["/bin/zsh", "-lc", command], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		return { ok: true, logPath };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "failed to start update",
		};
	}
}

export async function openNativePath(
	path: string,
	reveal: boolean
): Promise<boolean> {
	const os = platform();
	const command =
		os === "darwin"
			? reveal
				? ["open", "-R", path]
				: ["open", path]
			: os === "win32"
				? reveal
					? ["explorer.exe", `/select,${path}`]
					: ["explorer.exe", path]
				: ["xdg-open", reveal ? path.replace(/\/[^/]*$/, "") || path : path];
	const proc = Bun.spawn(command, {
		stdout: "ignore",
		stderr: "ignore",
	});
	const exitCode = await proc.exited;
	return exitCode === 0;
}
