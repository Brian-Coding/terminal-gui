import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { badRequest, tryRoute } from "../../lib/route-helpers.ts";
import { resolveAllowedLocalPath } from "../security.ts";
import { runAgentOnce } from "../services/agent-once.ts";

const execFileAsync = promisify(execFile);

async function generateTitle(userMessage: string): Promise<string> {
	const fallback = () => {
		const line = userMessage.trim().split("\n")[0] ?? "";
		return line.length > 60 ? `${line.slice(0, 57)}...` : line;
	};

	const result = await runAgentOnce({
		agentKind: "claude",
		cwd: process.cwd(),
		model: "claude-haiku-4-5",
		timeoutMs: 20_000,
		prompt: `Generate a concise title (max 6 words) that summarizes what this chat is about. Output ONLY the title, nothing else.\n\nUser message:\n${userMessage.slice(0, 500)}`,
	});

	if (!result) return fallback();
	return result.replace(/^["']|["']$/g, "");
}

async function getStagedDiff(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["diff", "--cached", "--stat"],
			{ cwd, encoding: "utf-8", timeout: 10000, maxBuffer: 512 * 1024 }
		);
		const stat = stdout.trim();
		if (!stat) return "";

		// Get the actual diff content (truncated for the AI prompt)
		const { stdout: diff } = await execFileAsync("git", ["diff", "--cached"], {
			cwd,
			encoding: "utf-8",
			timeout: 10000,
			maxBuffer: 512 * 1024,
		});
		return diff;
	} catch {
		return "";
	}
}

async function generateCommitMessage(cwd: string): Promise<string | null> {
	const diff = await getStagedDiff(cwd);
	if (!diff) return null;

	const truncatedDiff =
		diff.length > 8000 ? `${diff.slice(0, 8000)}\n\n[diff truncated...]` : diff;

	const result = await runAgentOnce({
		agentKind: "claude",
		cwd,
		model: "claude-haiku-4-5",
		timeoutMs: 30_000,
		prompt: `You are a git commit message generator. Based on the following staged diff, write a concise commit message.

Rules:
- First line: imperative summary, max 72 chars (e.g. "Add user auth flow", "Fix sidebar overflow bug")
- If needed, add a blank line then 1-3 bullet points explaining key changes
- Focus on WHAT changed and WHY, not HOW
- Be specific but brief
- Output ONLY the commit message, no quotes or prefixes

Staged diff:
${truncatedDiff}`,
	});

	return result;
}

export function titleRoutes() {
	return {
		"/api/generate-title": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as { message?: string };
				if (typeof body.message !== "string" || !body.message.trim()) {
					return badRequest("Missing message");
				}
				const title = await generateTitle(body.message);
				return Response.json({ title });
			}),
		},
		"/api/git/generate-commit-message": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as { cwd?: string };
				if (typeof body.cwd !== "string" || !body.cwd.trim()) {
					return badRequest("Missing cwd");
				}
				const cwd = resolveAllowedLocalPath(body.cwd);
				if (!cwd) {
					return Response.json(
						{ error: "Path is outside allowed local roots" },
						{ status: 403 }
					);
				}
				const message = await generateCommitMessage(cwd);
				if (!message) {
					return Response.json(
						{
							error: "No staged changes or Claude is unavailable",
						},
						{ status: 400 }
					);
				}
				return Response.json({ message });
			}),
		},
	};
}
