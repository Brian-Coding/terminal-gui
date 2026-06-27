export type GoalSystemStatus =
	| "active"
	| "paused"
	| "complete"
	| "cleared"
	| "empty";

export type GoalSystemMessage = {
	type: "inferay.goal";
	status: GoalSystemStatus;
	objective?: string;
	turns?: number;
	detail?: string;
};

export function serializeGoalSystemMessage(message: GoalSystemMessage): string {
	return JSON.stringify(message);
}

function parseJsonGoalMessage(content: string): GoalSystemMessage | null {
	if (!content.trim().startsWith("{")) return null;
	try {
		const parsed = JSON.parse(content) as Partial<GoalSystemMessage>;
		if (
			parsed?.type !== "inferay.goal" ||
			!["active", "paused", "complete", "cleared", "empty"].includes(
				String(parsed.status)
			)
		) {
			return null;
		}
		return {
			type: "inferay.goal",
			status: parsed.status as GoalSystemStatus,
			objective:
				typeof parsed.objective === "string" ? parsed.objective : undefined,
			turns: typeof parsed.turns === "number" ? parsed.turns : undefined,
			detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
		};
	} catch {
		return null;
	}
}

export function parseGoalSystemMessage(
	content: string
): GoalSystemMessage | null {
	const json = parseJsonGoalMessage(content);
	if (json) return json;

	const started = content.match(/^Goal started: (.+)$/);
	if (started?.[1]) {
		return {
			type: "inferay.goal",
			status: "active",
			objective: started[1],
			detail: "Goal started",
		};
	}

	const status = content.match(/^Goal (active|paused): (.+) \((\d+) turns?\)$/);
	if (status?.[1] && status[2]) {
		return {
			type: "inferay.goal",
			status: status[1] as "active" | "paused",
			objective: status[2],
			turns: Number(status[3] ?? 0),
		};
	}

	const achieved = content.match(/^Goal achieved after (\d+) turns?$/);
	if (achieved?.[1]) {
		return {
			type: "inferay.goal",
			status: "complete",
			turns: Number(achieved[1]),
			detail: "Goal achieved",
		};
	}

	const turnPause = content.match(/^Goal paused after (\d+) turns?$/);
	if (turnPause?.[1]) {
		return {
			type: "inferay.goal",
			status: "paused",
			turns: Number(turnPause[1]),
			detail: "Turn limit reached",
		};
	}

	if (content === "Goal paused") {
		return {
			type: "inferay.goal",
			status: "paused",
			detail: "Goal paused",
		};
	}
	if (content.startsWith("Goal paused because")) {
		return {
			type: "inferay.goal",
			status: "paused",
			detail: content,
		};
	}
	if (content === "Goal cleared") {
		return {
			type: "inferay.goal",
			status: "cleared",
			detail: "Goal cleared",
		};
	}
	if (content === "No active goal" || content === "No goal to resume") {
		return {
			type: "inferay.goal",
			status: "empty",
			detail: content,
		};
	}

	return null;
}
