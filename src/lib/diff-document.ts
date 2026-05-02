import type { HunkDiff } from "../hooks/useGitDiff.ts";

export type DiffFileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "untracked"
	| "binary";

export interface DiffStats {
	added: number;
	removed: number;
	files: number;
}

export interface InlineSpan {
	start: number;
	length: number;
	type: "added" | "removed" | "changed";
}

export interface DiffDocumentRow {
	id: string;
	kind: "context" | "added" | "removed" | "spacer" | "hunk";
	oldLine?: number;
	newLine?: number;
	oldText?: string;
	newText?: string;
	inlineSpans?: InlineSpan[];
}

export interface DiffDocumentHunk {
	id: string;
	rows: DiffDocumentRow[];
	stats: DiffStats;
}

export interface DiffDocumentFile {
	id: string;
	path: string;
	staged: boolean;
	status: DiffFileStatus;
	isBinary: boolean;
	isImage: boolean;
	hunks: DiffDocumentHunk[];
	stats: DiffStats;
}

export interface DiffDocument {
	id: string;
	cwd: string;
	files: DiffDocumentFile[];
	stats: DiffStats;
	createdAt: string;
}

export function mapGitStatus(status: string, diff: HunkDiff): DiffFileStatus {
	if (diff.isBinary) return "binary";
	if (diff.isNew) return status === "?" ? "untracked" : "added";
	if (status === "D") return "deleted";
	if (status === "R") return "renamed";
	if (status === "C") return "copied";
	if (status === "?") return "untracked";
	return "modified";
}

export function createDiffDocumentFromHunkDiff(input: {
	cwd: string;
	path: string;
	staged: boolean;
	status: string;
	diff: HunkDiff;
}): DiffDocument {
	const rows = toRows(input.diff);
	const stats = rows.reduce<DiffStats>(
		(acc, row) => {
			if (row.kind === "added") acc.added += 1;
			if (row.kind === "removed") acc.removed += 1;
			return acc;
		},
		{ added: 0, removed: 0, files: 1 }
	);
	const file: DiffDocumentFile = {
		id: `${input.cwd}:${input.path}:${input.staged ? "staged" : "unstaged"}`,
		path: input.path,
		staged: input.staged,
		status: mapGitStatus(input.status, input.diff),
		isBinary: input.diff.isBinary,
		isImage: Boolean(input.diff.isImage),
		hunks: [
			{
				id: `${input.path}:hunk:0`,
				rows,
				stats,
			},
		],
		stats,
	};
	return {
		id: `${input.cwd}:${input.path}:${input.staged ? "staged" : "unstaged"}:${Date.now()}`,
		cwd: input.cwd,
		files: [file],
		stats,
		createdAt: new Date().toISOString(),
	};
}

function toRows(diff: HunkDiff): DiffDocumentRow[] {
	const rows: DiffDocumentRow[] = [];
	const max = Math.max(diff.oldLines.length, diff.newLines.length);
	for (let i = 0; i < max; i++) {
		const oldLine = diff.oldLines[i];
		const newLine = diff.newLines[i];
		const kind = rowKind(oldLine?.type, newLine?.type);
		rows.push({
			id: `row:${i}`,
			kind,
			oldLine: oldLine?.number ?? undefined,
			newLine: newLine?.number ?? undefined,
			oldText: oldLine?.content,
			newText: newLine?.content,
		});
	}
	return rows;
}

function rowKind(
	oldType: string | undefined,
	newType: string | undefined
): DiffDocumentRow["kind"] {
	if (oldType === "remove") return "removed";
	if (newType === "add") return "added";
	if (oldType === "hunk" || newType === "hunk") return "hunk";
	if (oldType === "spacer" || newType === "spacer") return "spacer";
	return "context";
}
