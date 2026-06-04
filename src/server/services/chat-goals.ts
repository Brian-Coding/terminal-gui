import type { AgentEvent } from "../agents/events.ts";
import type { ChatMessageBuffer } from "./chat-message-buffer.ts";

export const GOAL_MAX_TURNS = 20;
export const CODEX_WORKFLOW_INSTRUCTIONS = `<inferay-workflow-instructions>
Do not run formatters with write mode as a routine chat-completion step. In this project, do not run \`bunx biome check --write ...\` unless the user explicitly asks for Biome formatting.
Do not run \`bun run build:renderer\` at the end of every chat. Run builds/tests only when the user requests verification or when the change genuinely needs that specific check.
If formatting is needed, prefer the project's intended formatting or commit-hook flow and keep formatting-only churn out of unrelated edits.
</inferay-workflow-instructions>`;

const GOAL_COMPLETE_MARKER = "[[GOAL_COMPLETE]]";
const GOAL_NEEDS_INPUT_MARKER = "[[GOAL_NEEDS_INPUT]]";

type GoalStatus = "active" | "paused";
type GoalResultStatus = GoalStatus | "complete";

export interface GoalState {
	objective: string;
	status: GoalStatus;
	turns: number;
	startedAt: number;
}

export function parseGoalCommand(
	text: string
):
	| { action: "start"; objective: string }
	| { action: "pause" | "resume" | "clear" | "status" }
	| null {
	const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
	if (!match) return null;
	const args = (match[1] ?? "").trim();
	const subcommand = args.toLowerCase();
	if (subcommand === "pause") return { action: "pause" };
	if (subcommand === "resume") return { action: "resume" };
	if (subcommand === "clear" || subcommand === "stop")
		return { action: "clear" };
	if (subcommand === "status" || !args) return { action: "status" };
	return { action: "start", objective: args };
}

export function createGoalPrompt(objective: string) {
	return `Start pursuing this goal until it is genuinely complete:\n\n${objective}\n\nWork autonomously. When the goal is fully achieved, include ${GOAL_COMPLETE_MARKER} in your final response. If you are blocked and need user input, include ${GOAL_NEEDS_INPUT_MARKER}.`;
}

export function createGoalContinuationPrompt(goal: GoalState) {
	return `<goal-continuation>
Objective: ${goal.objective}
Turns used: ${goal.turns}
Elapsed milliseconds: ${Date.now() - goal.startedAt}

Continue working toward the objective. Do not ask for confirmation unless you are blocked. When the goal is fully achieved, include ${GOAL_COMPLETE_MARKER} in your final response. If you need user input to proceed, include ${GOAL_NEEDS_INPUT_MARKER}.
</goal-continuation>`;
}

export function goalResultStatus(text?: string): GoalResultStatus {
	if (!text) return "active";
	if (text.includes(GOAL_COMPLETE_MARKER)) return "complete";
	if (text.includes(GOAL_NEEDS_INPUT_MARKER)) return "paused";
	return "active";
}

export function stripGoalMarkers(text: string): string {
	return text
		.replaceAll(GOAL_COMPLETE_MARKER, "")
		.replaceAll(GOAL_NEEDS_INPUT_MARKER, "")
		.trim();
}

function firstUsefulLine(text: string, max = 140): string {
	const line =
		text
			.split("\n")
			.map((item) => item.trim())
			.find(Boolean) ?? "";
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

export function deriveGoalView(session: {
	goal: GoalState | null;
	currentHandle: unknown;
	agentEvents: AgentEvent[];
	messageBuffer: ChatMessageBuffer;
}) {
	const messages = session.messageBuffer.getMessages();
	const latestSystem = [...messages]
		.reverse()
		.find((message) => message.role === "system" && message.content.trim());
	const activity: Array<Record<string, string | null>> = [];
	const pushActivity = (
		id: string,
		type: string,
		label: string,
		detail: string | null,
		state: string
	) => {
		activity.push({ id, type, label, detail, state });
		if (activity.length > 30) activity.shift();
	};
	for (const [index, event] of session.agentEvents.entries()) {
		if (event.type === "status") {
			pushActivity(
				`status-${index}`,
				"status",
				event.label ?? event.status,
				null,
				event.status === "error"
					? "error"
					: event.status === "idle"
						? "complete"
						: "running"
			);
		} else if (event.type === "tool-call-start") {
			pushActivity(
				event.toolCallId,
				"tool",
				event.toolName,
				event.summary ?? null,
				"running"
			);
		} else if (event.type === "tool-call-end") {
			pushActivity(
				`${event.toolCallId}-end`,
				"tool",
				event.error ? "Tool failed" : "Tool finished",
				event.error ?? null,
				event.error ? "error" : "complete"
			);
		} else if (event.type === "result") {
			pushActivity(
				`result-${index}`,
				"result",
				"Result",
				firstUsefulLine(event.text),
				"complete"
			);
		} else if (event.type === "error") {
			pushActivity(`error-${index}`, "error", "Error", event.message, "error");
		}
	}
	if (latestSystem?.content) {
		pushActivity(
			`system-${activity.length}`,
			"system",
			"System",
			firstUsefulLine(latestSystem.content),
			session.goal?.status === "paused" ? "paused" : "complete"
		);
	}
	return {
		activity,
	};
}
