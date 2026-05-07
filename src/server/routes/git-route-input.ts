import { isSafeRelativePath, resolveAllowedLocalPath } from "../security.ts";
import { getStatus } from "../services/git.ts";

export interface GitDiffRequestParams {
	cwd: string;
	file: string;
	staged: boolean;
}

export function forbidden(message = "Path is outside allowed local roots") {
	return Response.json({ error: message }, { status: 403 });
}

export function getDiffParams(req: Request): GitDiffRequestParams | null {
	const url = new URL(req.url);
	const cwd = safeCwd(url.searchParams.get("cwd"));
	const file = url.searchParams.get("file");
	if (!cwd || !safeFilePath(file)) return null;
	return {
		cwd,
		file,
		staged: url.searchParams.get("staged") === "true",
	};
}

export function safeCwd(value: string | null | undefined): string | null {
	return typeof value === "string" && value.trim()
		? resolveAllowedLocalPath(value)
		: null;
}

export function safeFilePath(
	value: string | null | undefined
): value is string {
	return typeof value === "string" && isSafeRelativePath(value);
}

export function safeHash(value: string | null | undefined): value is string {
	return typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value);
}

export function safeLimit(
	value: string | null,
	fallback: number,
	max: number
): number {
	const parsed = Number(value ?? fallback);
	return Number.isFinite(parsed)
		? Math.min(Math.max(Math.trunc(parsed), 1), max)
		: fallback;
}

export async function isChangedGitFile(
	cwd: string,
	filePath: string
): Promise<boolean> {
	const status = await getStatus(cwd);
	return Boolean(status?.files.some((file) => file.path === filePath));
}
