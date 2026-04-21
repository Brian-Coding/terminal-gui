import { runNativeCore } from "./native-core.ts";

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

interface NativeDiffResponse {
	op: "diff";
	diff: ParsedDiff;
}

export async function computeNativeDiff(
	before: string,
	after: string
): Promise<ParsedDiff | null> {
	const result = await runNativeCore<
		{ op: "diff"; before: string; after: string },
		NativeDiffResponse
	>({
		op: "diff",
		before,
		after,
	});

	if (!result?.diff) return null;
	result.diff.computedAt = Date.now();
	return result.diff;
}
