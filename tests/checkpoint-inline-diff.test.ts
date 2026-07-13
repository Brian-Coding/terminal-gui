import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CheckpointService } from "../src/server/services/checkpoint.ts";

async function git(cwd: string, args: string[]) {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	return stdout;
}

test("checkpoint inline diffs recover HEAD content for clean tracked files", async () => {
	const root = resolve(
		".test-tmp",
		`checkpoint-inline-diff-${crypto.randomUUID()}`
	);
	const filePath = resolve(root, "src/example.ts");
	try {
		await mkdir(resolve(root, "src"), { recursive: true });
		await git(root, ["init"]);
		await git(root, ["config", "user.email", "test@example.com"]);
		await git(root, ["config", "user.name", "Test User"]);
		await Bun.write(filePath, "export const answer = 41;\n");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-m", "initial"]);

		const checkpointId = await CheckpointService.createCheckpoint(
			"pane-clean-tracked",
			root,
			"edit file"
		);
		await Bun.write(filePath, "export const answer = 42;\n");
		const meta = await CheckpointService.finalizeCheckpoint(checkpointId, [
			filePath,
		]);

		expect(meta?.changedFiles).toEqual([
			{ path: "src/example.ts", action: "modified" },
		]);
		expect(await CheckpointService.getInlineDiffs(checkpointId)).toEqual([
			{
				path: "src/example.ts",
				oldString: "export const answer = 41;\n",
				newString: "export const answer = 42;\n",
			},
		]);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("checkpoint ignores files not explicitly touched by the agent turn", async () => {
	const root = resolve(".test-tmp", `checkpoint-scope-${crypto.randomUUID()}`);
	try {
		await mkdir(root, { recursive: true });
		await git(root, ["init"]);
		await git(root, ["config", "user.email", "test@example.com"]);
		await git(root, ["config", "user.name", "Test User"]);
		await Bun.write(resolve(root, "agent.ts"), "before\n");
		await Bun.write(resolve(root, "unrelated.ts"), "before\n");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-m", "initial"]);

		const checkpointId = await CheckpointService.createCheckpoint(
			"pane-scoped",
			root,
			"edit one file"
		);
		await Bun.write(resolve(root, "agent.ts"), "after\n");
		await Bun.write(resolve(root, "unrelated.ts"), "also after\n");
		const meta = await CheckpointService.finalizeCheckpoint(checkpointId, [
			"agent.ts",
		]);
		expect(meta?.changedFiles).toEqual([
			{ path: "agent.ts", action: "modified" },
		]);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
