/**
 * Background Diff Worker
 *
 * Precomputes diffs when files are edited, caches results for instant viewing.
 * Uses diff-match-patch for efficient line-level diffing.
 */

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

export interface DiffCacheEntry {
	before: string;
	after: string;
	filePath: string;
	parsedDiff: ParsedDiff;
}

type DiffOperation = -1 | 0 | 1; // DELETE, EQUAL, INSERT

// Simple but fast diff algorithm (similar to diff-match-patch)
function computeLineDiff(oldText: string, newText: string): ParsedDiff {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	// Build LCS table for line-level diff
	const m = oldLines.length;
	const n = newLines.length;

	// Use typed array for better performance with large files
	const dp: Uint16Array[] = [];
	for (let i = 0; i <= m; i++) {
		dp[i] = new Uint16Array(n + 1);
	}

	// Fill LCS table
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i]![j] = dp[i - 1]![j - 1]! + 1;
			} else {
				dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
	}

	// Backtrack to build diff
	const diffOps: { type: DiffOperation; oldIdx?: number; newIdx?: number }[] =
		[];
	let i = m;
	let j = n;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			diffOps.unshift({ type: 0, oldIdx: i - 1, newIdx: j - 1 });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
			diffOps.unshift({ type: 1, newIdx: j - 1 });
			j--;
		} else {
			diffOps.unshift({ type: -1, oldIdx: i - 1 });
			i--;
		}
	}

	// Convert to DiffLines for both sides
	const leftLines: DiffLine[] = [];
	const rightLines: DiffLine[] = [];
	const hunks: DiffHunk[] = [];

	let stats = { added: 0, removed: 0, unchanged: 0 };
	let oldLineNum = 1;
	let newLineNum = 1;

	// Group into hunks with context
	let currentHunk: DiffHunk | null = null;
	let unchangedCount = 0;
	const CONTEXT_LINES = 3;

	for (const op of diffOps) {
		if (op.type === 0) {
			// Unchanged line
			const content = oldLines[op.oldIdx!]!;
			const leftLine: DiffLine = {
				type: "unchanged",
				content,
				oldLineNum: oldLineNum++,
				newLineNum: newLineNum++,
			};
			const rightLine: DiffLine = { ...leftLine };

			leftLines.push(leftLine);
			rightLines.push(rightLine);
			stats.unchanged++;

			if (currentHunk) {
				unchangedCount++;
				currentHunk.lines.push(leftLine);
				// Close hunk if we have enough context
				if (unchangedCount > CONTEXT_LINES * 2) {
					currentHunk.oldCount = currentHunk.lines.filter(
						(l) => l.type !== "added"
					).length;
					currentHunk.newCount = currentHunk.lines.filter(
						(l) => l.type !== "removed"
					).length;
					hunks.push(currentHunk);
					currentHunk = null;
					unchangedCount = 0;
				}
			}
		} else if (op.type === -1) {
			// Removed line
			const content = oldLines[op.oldIdx!]!;
			const leftLine: DiffLine = {
				type: "removed",
				content,
				oldLineNum: oldLineNum++,
			};
			// Add placeholder on right side
			const rightLine: DiffLine = {
				type: "removed",
				content: "",
			};

			leftLines.push(leftLine);
			rightLines.push(rightLine);
			stats.removed++;
			unchangedCount = 0;

			if (!currentHunk) {
				currentHunk = {
					oldStart: leftLine.oldLineNum!,
					oldCount: 0,
					newStart: newLineNum,
					newCount: 0,
					lines: [],
				};
				// Add context from previous unchanged lines
				const contextStart = Math.max(0, leftLines.length - 1 - CONTEXT_LINES);
				for (let c = contextStart; c < leftLines.length - 1; c++) {
					if (leftLines[c]?.type === "unchanged") {
						currentHunk.lines.push(leftLines[c]!);
					}
				}
			}
			currentHunk.lines.push(leftLine);
		} else {
			// Added line
			const content = newLines[op.newIdx!]!;
			// Add placeholder on left side
			const leftLine: DiffLine = {
				type: "added",
				content: "",
			};
			const rightLine: DiffLine = {
				type: "added",
				content,
				newLineNum: newLineNum++,
			};

			leftLines.push(leftLine);
			rightLines.push(rightLine);
			stats.added++;
			unchangedCount = 0;

			if (!currentHunk) {
				currentHunk = {
					oldStart: oldLineNum,
					oldCount: 0,
					newStart: rightLine.newLineNum!,
					newCount: 0,
					lines: [],
				};
			}
			currentHunk.lines.push(rightLine);
		}
	}

	// Close final hunk
	if (currentHunk && currentHunk.lines.length > 0) {
		currentHunk.oldCount = currentHunk.lines.filter(
			(l) => l.type !== "added"
		).length;
		currentHunk.newCount = currentHunk.lines.filter(
			(l) => l.type !== "removed"
		).length;
		hunks.push(currentHunk);
	}

	return {
		hunks,
		oldLines: leftLines,
		newLines: rightLines,
		stats,
		computedAt: Date.now(),
	};
}

// Worker message types
export type DiffWorkerMessage =
	| {
			type: "compute";
			chatId: string;
			filePath: string;
			before: string;
			after: string;
	  }
	| { type: "get"; chatId: string; filePath: string }
	| { type: "clear"; chatId: string }
	| { type: "clearAll" };

export type DiffWorkerResponse =
	| { type: "computed"; chatId: string; filePath: string; diff: ParsedDiff }
	| {
			type: "cached";
			chatId: string;
			filePath: string;
			entry: DiffCacheEntry | null;
	  }
	| { type: "cleared"; chatId: string }
	| { type: "clearedAll" };

// In-worker cache
const cache = new Map<string, Map<string, DiffCacheEntry>>();

function getCacheKey(chatId: string, filePath: string): string {
	return `${chatId}:${filePath}`;
}

function handleMessage(msg: DiffWorkerMessage): DiffWorkerResponse {
	switch (msg.type) {
		case "compute": {
			const { chatId, filePath, before, after } = msg;

			// Compute diff
			const parsedDiff = computeLineDiff(before, after);

			// Cache it
			if (!cache.has(chatId)) {
				cache.set(chatId, new Map());
			}
			cache.get(chatId)!.set(filePath, {
				before,
				after,
				filePath,
				parsedDiff,
			});

			return { type: "computed", chatId, filePath, diff: parsedDiff };
		}

		case "get": {
			const { chatId, filePath } = msg;
			const chatCache = cache.get(chatId);
			const entry = chatCache?.get(filePath) ?? null;
			return { type: "cached", chatId, filePath, entry };
		}

		case "clear": {
			const { chatId } = msg;
			cache.delete(chatId);
			return { type: "cleared", chatId };
		}

		case "clearAll": {
			cache.clear();
			return { type: "clearedAll" };
		}
	}
}

// Web Worker entry point
if (typeof self !== "undefined" && typeof self.onmessage !== "undefined") {
	self.onmessage = (e: MessageEvent<DiffWorkerMessage>) => {
		const response = handleMessage(e.data);
		self.postMessage(response);
	};
}

// Export for direct usage (non-worker mode)
export { computeLineDiff, handleMessage };
