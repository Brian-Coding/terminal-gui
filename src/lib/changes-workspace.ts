import type { GitFileEntry, GitProjectStatus } from "../hooks/useGitStatus.ts";

export interface ChangeCheckpoint {
	id: string;
	cwd: string;
	timestamp: number;
	signature: string;
}

export interface DiffTextEntry {
	file: GitFileEntry;
	diff: string;
}

export function checkpointKey(cwd: string) {
	return `git-change-checkpoint:${cwd}`;
}

export function createChangeSignature(files: GitFileEntry[]) {
	return files
		.map((file) =>
			[file.staged ? "staged" : "unstaged", file.status, file.path].join(":")
		)
		.sort()
		.join("|");
}

export function formatShortTime(timestamp: number) {
	return new Date(timestamp).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

export function buildReviewPrompt(
	project: GitProjectStatus,
	diffs: DiffTextEntry[]
) {
	return [
		`Review the current changes in ${project.name}.`,
		"Focus on correctness, regressions, missing tests, and risky implementation choices.",
		"Return prioritized findings with file paths and concrete fixes.",
		"",
		diffs
			.map(({ file, diff }) =>
				[
					`# ${file.staged ? "Staged" : "Unstaged"} ${file.status} ${file.path}`,
					diff.trim(),
				]
					.filter(Boolean)
					.join("\n")
			)
			.join("\n\n"),
	].join("\n");
}

export function buildSummaryPrompt(
	project: GitProjectStatus,
	reviewPrompt: string
) {
	return [
		`Summarize the current worktree changes in ${project.name}.`,
		"Keep it short: 4-6 bullets, grouped by intent. Mention risk or missing tests only if obvious.",
		"",
		reviewPrompt,
	].join("\n");
}

export function buildFilePrompt(
	project: GitProjectStatus,
	file: GitFileEntry,
	diff: string,
	intent: "explain" | "fix"
) {
	const instruction =
		intent === "fix"
			? "Find and fix issues in this changed file. Keep the change scoped to this file unless another file is required."
			: "Explain this changed file. Focus on what changed, why it matters, and any risks.";
	return [
		instruction,
		"",
		`Repository: ${project.name}`,
		`File: ${file.path}`,
		`Status: ${file.status}`,
		file.staged ? "Area: staged changes" : "Area: unstaged changes",
		"",
		diff.trim(),
	]
		.filter(Boolean)
		.join("\n");
}

export function buildRepoExplainPrompt(project: GitProjectStatus) {
	return [
		`Explain the repository ${project.name}.`,
		"Start by inspecting the project structure and key package files.",
		"Then summarize what this repo does, the main architecture, and the highest-value next improvements.",
	].join("\n");
}

export function buildCommitMessage(project: GitProjectStatus) {
	const staged = project.files.filter((file) => file.staged);
	const modified = project.files.filter(
		(file) => !file.staged && file.status !== "?"
	);
	const untracked = project.files.filter((file) => file.status === "?");
	const parts = [
		staged.length ? `${staged.length} staged` : null,
		modified.length ? `${modified.length} modified` : null,
		untracked.length ? `${untracked.length} new` : null,
	].filter(Boolean);
	const mainFile = project.files[0]?.path;
	const name = mainFile?.split("/").pop() || mainFile;
	return project.files.length === 1 && name
		? `chore: update ${name}`
		: `chore: update ${project.name}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
