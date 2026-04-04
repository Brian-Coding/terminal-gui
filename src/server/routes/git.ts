import { resolve } from "node:path";
import { badRequest, tryRoute } from "../lib/route-helpers.ts";
import {
	type GitStatusResult,
	commit,
	getBranches,
	getDiff,
	getLog,
	getStatus,
	stageAll,
	stageFile,
	unstageAll,
	unstageFile,
} from "../services/git.ts";

interface DiffLine {
	number: number | null;
	content: string;
	type: "add" | "remove" | "context" | "spacer" | "hunk";
}

interface HunkDiff {
	oldLines: DiffLine[];
	newLines: DiffLine[];
	isBinary: boolean;
	isNew: boolean;
	isImage?: boolean;
	imagePath?: string;
}

const MAX_RENDER_DIFF_CHARS = 80_000;
const MAX_RENDER_DIFF_LINES = 1_500;
const MAX_UNTRACKED_FILE_BYTES = 120_000;
const MAX_RENDER_LINE_LENGTH = 4_000;

const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".ico",
	".bmp",
]);

function isImageFile(filePath: string): boolean {
	const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
	return IMAGE_EXTENSIONS.has(ext);
}

function tooLargeDiff(message: string, isNew = false): HunkDiff {
	return {
		oldLines: [],
		newLines: [{ number: 1, content: message, type: "context" }],
		isBinary: false,
		isNew,
	};
}

async function getHunkDiff(
	cwd: string,
	filePath: string,
	staged: boolean
): Promise<HunkDiff> {
	const fullPath = resolve(cwd, filePath);

	// Check if it's an image file first
	if (isImageFile(filePath)) {
		return {
			oldLines: [],
			newLines: [],
			isBinary: true,
			isNew: true,
			isImage: true,
			imagePath: fullPath,
		};
	}

	// Get the current file content from disk
	let currentContent = "";
	try {
		const f = Bun.file(fullPath);
		if (f.size > MAX_UNTRACKED_FILE_BYTES) {
			return tooLargeDiff("File too large to render safely", true);
		}
		currentContent = await f.text();
		if (currentContent.includes("\0")) {
			return { oldLines: [], newLines: [], isBinary: true, isNew: false };
		}
	} catch {
		return {
			oldLines: [],
			newLines: [{ number: 1, content: "Cannot read file", type: "context" }],
			isBinary: false,
			isNew: true,
		};
	}

	// Get the old version from git
	// For staged: compare index to HEAD (git show HEAD:file)
	// For unstaged: compare working tree to index (git show :file)
	let oldContent = "";
	let isNew = false;
	try {
		const ref = staged ? `HEAD:${filePath}` : `:${filePath}`;
		const proc = Bun.spawn(["git", "show", ref], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [text, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		if (exitCode === 0) {
			oldContent = text;
		} else {
			// File doesn't exist in git yet - it's new
			isNew = true;
		}
	} catch {
		isNew = true;
	}

	// If it's a new file, show all lines as additions
	if (isNew) {
		const lines = currentContent.split("\n");
		return {
			oldLines: [],
			newLines: lines.map((c, i) => ({
				number: i + 1,
				content: c,
				type: "add" as const,
			})),
			isBinary: false,
			isNew: true,
		};
	}

	// Build aligned view by reading both files and parsing minimal diff
	const oldFileLines = oldContent.split("\n");
	const newFileLines = currentContent.split("\n");

	// Get diff with NO context (-U0) to just get the change ranges
	interface DiffHunk {
		oldStart: number;
		oldCount: number;
		newStart: number;
		newCount: number;
		oldLines: string[];
		newLines: string[];
	}
	const hunks: DiffHunk[] = [];

	try {
		const args = staged
			? ["git", "diff", "--cached", "-U0", "--", filePath]
			: ["git", "diff", "-U0", "--", filePath];
		const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
		const diffText = await new Response(proc.stdout).text();

		let currentHunk: DiffHunk | null = null;
		for (const line of diffText.split("\n")) {
			if (line.startsWith("@@")) {
				if (currentHunk) hunks.push(currentHunk);
				const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
				if (m) {
					currentHunk = {
						oldStart: Number.parseInt(m[1]!, 10),
						oldCount: m[2] ? Number.parseInt(m[2], 10) : 1,
						newStart: Number.parseInt(m[3]!, 10),
						newCount: m[4] ? Number.parseInt(m[4], 10) : 1,
						oldLines: [],
						newLines: [],
					};
				}
			} else if (currentHunk) {
				if (line.startsWith("-") && !line.startsWith("---")) {
					currentHunk.oldLines.push(line.slice(1));
				} else if (line.startsWith("+") && !line.startsWith("+++")) {
					currentHunk.newLines.push(line.slice(1));
				}
			}
		}
		if (currentHunk) hunks.push(currentHunk);
	} catch {}

	// Build aligned output by merging hunks with file content
	const oldLines: DiffLine[] = [];
	const newLines: DiffLine[] = [];

	let oldIdx = 0;
	let newIdx = 0;

	for (const hunk of hunks) {
		// Add context lines before this hunk
		while (oldIdx < hunk.oldStart - 1 && newIdx < hunk.newStart - 1) {
			oldLines.push({
				number: oldIdx + 1,
				content: oldFileLines[oldIdx] ?? "",
				type: "context",
			});
			newLines.push({
				number: newIdx + 1,
				content: newFileLines[newIdx] ?? "",
				type: "context",
			});
			oldIdx++;
			newIdx++;
		}

		// Add removed lines with spacers on new side
		for (const content of hunk.oldLines) {
			oldLines.push({ number: oldIdx + 1, content, type: "remove" });
			newLines.push({ number: null, content: "", type: "spacer" });
			oldIdx++;
		}

		// Add added lines with spacers on old side
		for (const content of hunk.newLines) {
			oldLines.push({ number: null, content: "", type: "spacer" });
			newLines.push({ number: newIdx + 1, content, type: "add" });
			newIdx++;
		}
	}

	// Add remaining context lines after last hunk
	while (oldIdx < oldFileLines.length || newIdx < newFileLines.length) {
		if (oldIdx < oldFileLines.length && newIdx < newFileLines.length) {
			oldLines.push({
				number: oldIdx + 1,
				content: oldFileLines[oldIdx] ?? "",
				type: "context",
			});
			newLines.push({
				number: newIdx + 1,
				content: newFileLines[newIdx] ?? "",
				type: "context",
			});
			oldIdx++;
			newIdx++;
		} else if (oldIdx < oldFileLines.length) {
			oldLines.push({
				number: oldIdx + 1,
				content: oldFileLines[oldIdx] ?? "",
				type: "context",
			});
			newLines.push({ number: null, content: "", type: "spacer" });
			oldIdx++;
		} else {
			oldLines.push({ number: null, content: "", type: "spacer" });
			newLines.push({
				number: newIdx + 1,
				content: newFileLines[newIdx] ?? "",
				type: "context",
			});
			newIdx++;
		}
	}

	return { oldLines, newLines, isBinary: false, isNew: false };
}

export function gitRoutes() {
	return {
		"/api/git/status": {
			GET: tryRoute(async (req) => {
				const url = new URL(req.url);
				const cwd = url.searchParams.get("cwd");
				if (!cwd) return badRequest("Missing cwd parameter");
				const status = await getStatus(cwd);
				if (!status)
					return Response.json(
						{ error: "Not a git repository" },
						{ status: 404 }
					);
				return Response.json(status);
			}),
		},

		"/api/git/statuses": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as { cwds: string[] };
				if (!body.cwds?.length) return Response.json([]);
				const seen = new Set<string>();
				const unique: string[] = [];
				for (const cwd of body.cwds) {
					if (!seen.has(cwd)) {
						seen.add(cwd);
						unique.push(cwd);
					}
				}
				const results = await Promise.all(unique.map((cwd) => getStatus(cwd)));
				return Response.json(results.filter(Boolean) as GitStatusResult[]);
			}),
		},

		"/api/git/diff": {
			GET: tryRoute(async (req) => {
				const url = new URL(req.url);
				const cwd = url.searchParams.get("cwd");
				const file = url.searchParams.get("file");
				const staged = url.searchParams.get("staged") === "true";
				if (!cwd || !file) return badRequest("Missing cwd or file parameter");
				const diff = await getDiff(cwd, file, staged);
				return Response.json({ diff });
			}),
		},

		"/api/git/full-diff": {
			GET: tryRoute(async (req) => {
				const url = new URL(req.url);
				const cwd = url.searchParams.get("cwd");
				const file = url.searchParams.get("file");
				const staged = url.searchParams.get("staged") === "true";
				if (!cwd || !file) return badRequest("Missing cwd or file parameter");
				// Simple approach: just read the file from disk + get diff markers
				const result = await getHunkDiff(cwd, file, staged);
				return Response.json(result);
			}),
		},

		"/api/git/file-with-diff": {
			GET: tryRoute(async (req) => {
				const url = new URL(req.url);
				const cwd = url.searchParams.get("cwd");
				const file = url.searchParams.get("file");
				const staged = url.searchParams.get("staged") === "true";
				if (!cwd || !file) return badRequest("Missing cwd or file parameter");

				const fullPath = resolve(cwd, file);

				// Check if image
				if (isImageFile(file)) {
					return Response.json({
						isImage: true,
						imagePath: fullPath,
						lines: [],
					});
				}

				// Read file content
				let content: string;
				try {
					const f = Bun.file(fullPath);
					if (f.size > 500_000) {
						return Response.json({ error: "File too large", lines: [] });
					}
					content = await f.text();
					if (content.includes("\0")) {
						return Response.json({ error: "Binary file", lines: [] });
					}
				} catch {
					return Response.json({ error: "Cannot read file", lines: [] });
				}

				// Get changed line numbers from git diff
				const addedLines = new Set<number>();
				try {
					const args = staged
						? ["git", "diff", "--cached", "-U0", "--", file]
						: ["git", "diff", "-U0", "--", file];
					const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
					const diffText = await new Response(proc.stdout).text();

					let lineNum = 0;
					for (const line of diffText.split("\n")) {
						if (line.startsWith("@@")) {
							const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
							if (m) lineNum = Number.parseInt(m[1]!, 10);
							continue;
						}
						if (line.startsWith("+") && !line.startsWith("+++")) {
							addedLines.add(lineNum++);
						} else if (line.startsWith("-") && !line.startsWith("---")) {
							// Deleted line, don't increment
						} else if (!line.startsWith("\\")) {
							lineNum++;
						}
					}
				} catch {}

				// Build response
				const fileLines = content.split("\n");
				const lines = fileLines.map((text, i) => ({
					number: i + 1,
					content: text,
					type: addedLines.has(i + 1) ? "add" : "context",
				}));

				return Response.json({ lines });
			}),
		},

		"/api/git/branches": {
			GET: tryRoute(async (req) => {
				const url = new URL(req.url);
				const cwd = url.searchParams.get("cwd");
				if (!cwd) return badRequest("Missing cwd parameter");
				const branches = await getBranches(cwd);
				return Response.json({ branches });
			}),
		},

		"/api/git/log": {
			GET: tryRoute(async (req) => {
				const url = new URL(req.url);
				const cwd = url.searchParams.get("cwd");
				const limit = Number(url.searchParams.get("limit") || 20);
				if (!cwd) return badRequest("Missing cwd parameter");
				const log = await getLog(cwd, limit);
				return Response.json({ log });
			}),
		},

		"/api/git/stage": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as { cwd: string; file?: string };
				if (!body.cwd) return badRequest("Missing cwd parameter");
				const success = body.file
					? await stageFile(body.cwd, body.file)
					: await stageAll(body.cwd);
				return Response.json({ success });
			}),
		},

		"/api/git/unstage": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as { cwd: string; file?: string };
				if (!body.cwd) return badRequest("Missing cwd parameter");
				const success = body.file
					? await unstageFile(body.cwd, body.file)
					: await unstageAll(body.cwd);
				return Response.json({ success });
			}),
		},

		"/api/git/commit": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as { cwd: string; message: string };
				if (!body.cwd) return badRequest("Missing cwd parameter");
				if (!body.message) return badRequest("Missing message parameter");
				const result = await commit(body.cwd, body.message);
				return Response.json(result);
			}),
		},
	};
}
