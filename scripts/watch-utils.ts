import { existsSync } from "node:fs";

export function targetExists(target: { path: string }): boolean {
	return existsSync(target.path);
}

export function resolveExitCode(
	resolve: (code: number) => void,
	code: number | null
): void {
	resolve(code ?? 0);
}
