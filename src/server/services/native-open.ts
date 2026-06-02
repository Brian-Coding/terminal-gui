import { platform } from "node:os";

export function runInferayUpdate(): boolean {
	const command = [
		"if command -v npx >/dev/null 2>&1; then",
		"npx --yes inferay update;",
		"elif command -v bunx >/dev/null 2>&1; then",
		"bunx inferay update;",
		"else",
		"echo 'npx or bunx is required to update Inferay' >&2;",
		"exit 127;",
		"fi",
	].join(" ");
	try {
		Bun.spawn(["/bin/zsh", "-lc", command], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		return true;
	} catch {
		return false;
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
