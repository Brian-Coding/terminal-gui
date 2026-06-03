import { readdirSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

interface UpdateLaunchResult {
	ok: boolean;
	logPath?: string;
	error?: string;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function nvmBinDirs(home: string | undefined): string[] {
	if (!home) return [];
	const versionsDir = join(home, ".nvm", "versions", "node");
	try {
		return readdirSync(versionsDir)
			.sort()
			.reverse()
			.map((version) => join(versionsDir, version, "bin"));
	} catch {
		return [];
	}
}

export function createInferayUpdatePath(
	env: Record<string, string | undefined> = process.env
): string {
	const home = env.HOME || env.USERPROFILE || env.HOMEPATH;
	return uniqueStrings([
		...(env.PATH ?? "").split(delimiter),
		env.NVM_BIN,
		home ? join(home, ".bun", "bin") : null,
		home ? join(home, ".local", "bin") : null,
		home ? join(home, ".npm-global", "bin") : null,
		...nvmBinDirs(home),
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	]).join(delimiter);
}

function createUpdateEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value != null) env[key] = value;
	}
	env.PATH = createInferayUpdatePath(process.env);
	return env;
}

export function createInferayUpdateCommand(): string {
	return [
		"if command -v npx >/dev/null 2>&1; then",
		"npx --yes inferay update && exit 0;",
		"fi;",
		"if command -v bunx >/dev/null 2>&1; then",
		"bunx inferay update && exit 0;",
		"fi;",
		"echo 'npx or bunx is required to update Inferay' >&2;",
		"exit 127;",
	].join(" ");
}

export function runInferayUpdate(): UpdateLaunchResult {
	const env = createUpdateEnv();
	const probe = Bun.spawnSync(
		[
			"/bin/zsh",
			"-lc",
			"command -v npx >/dev/null 2>&1 || command -v bunx >/dev/null 2>&1",
		],
		{ env }
	);
	if (probe.exitCode !== 0) {
		return {
			ok: false,
			error: "npx or bunx is required to update Inferay",
		};
	}

	const logPath = join(tmpdir(), `inferay-update-${Date.now()}.log`);
	const updateCommand = createInferayUpdateCommand();
	const command = [
		"nohup",
		"/bin/zsh",
		"-lc",
		shellQuote(updateCommand),
		`>${shellQuote(logPath)}`,
		"2>&1",
		"</dev/null",
		"&",
	].join(" ");
	try {
		Bun.spawn(["/bin/zsh", "-lc", command], {
			env,
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
