import { runNativeCore } from "./native-core.ts";

export interface NativeGitFileEntry {
	status: string;
	staged: boolean;
	path: string;
	originalPath?: string;
}

export interface NativeGitStatusResult {
	cwd: string;
	name: string;
	branch: string;
	upstream: string | null;
	ahead: number;
	behind: number;
	stagedCount: number;
	unstagedCount: number;
	untrackedCount: number;
	files: NativeGitFileEntry[];
}

export interface NativeGraphCommit {
	hash: string;
	message: string;
	author: string;
	authorEmail: string;
	authorAvatarUrl: string;
	date: string;
	parents: string[];
	refs: string[];
	column: number;
	color: string;
}

export interface NativeGraphRail {
	column: number;
	color: string;
}

export interface NativeGraphTransition {
	fromColumn: number;
	toColumn: number;
	color: string;
}

export interface NativeGraphRow {
	row: number;
	rails: NativeGraphRail[];
	transitions: NativeGraphTransition[];
}

interface NativeGitStatusesResponse {
	op: "git_statuses";
	projects: NativeGitStatusResult[];
}

interface NativeGitGraphResponse {
	op: "git_graph";
	commits: NativeGraphCommit[];
	rows: NativeGraphRow[];
}

export async function getNativeGitStatuses(
	cwds: string[]
): Promise<NativeGitStatusResult[] | null> {
	if (!cwds.length) return [];
	const result = await runNativeCore<
		{ op: "git_statuses"; cwds: string[] },
		NativeGitStatusesResponse
	>({
		op: "git_statuses",
		cwds,
	});
	return result?.projects ?? null;
}

export async function getNativeGitGraph(
	cwd: string,
	limit: number
): Promise<{ commits: NativeGraphCommit[]; rows: NativeGraphRow[] } | null> {
	const result = await runNativeCore<
		{ op: "git_graph"; cwd: string; limit: number },
		NativeGitGraphResponse
	>({
		op: "git_graph",
		cwd,
		limit,
	});
	return result ? { commits: result.commits, rows: result.rows } : null;
}
