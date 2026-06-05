import type { ChatAgentKind } from "../../features/agents/agents.ts";
import type { ChatStreamEvent } from "../../features/chat/agent-chat-shared.ts";
import { basename, trimText as trimSummary } from "../../lib/format.ts";

const MAX_STREAM_CHARS = 64_000;

export type AgentEvent =
	| {
			type: "session";
			providerSessionId: string;
	  }
	| {
			type: "status";
			status: "thinking" | "responding" | "tool" | "idle" | "error";
			label?: string;
	  }
	| {
			type: "text-delta";
			text: string;
			messageId?: string;
	  }
	| {
			type: "thinking-delta";
			text: string;
			messageId?: string;
	  }
	| {
			type: "tool-call-start";
			toolCallId: string;
			toolName: string;
			input?: unknown;
			summary?: string;
	  }
	| {
			type: "tool-call-delta";
			toolCallId: string;
			delta: string;
	  }
	| {
			type: "tool-call-end";
			toolCallId: string;
			output?: unknown;
			error?: string;
	  }
	| {
			type: "result";
			text: string;
	  }
	| {
			type: "error";
			message: string;
	  }
	| {
			type: "finish";
			reason?: string;
	  }
	| {
			type: "raw";
			provider: "claude" | "codex";
			eventType?: string;
			event: unknown;
	  };

export interface AgentActivityEvent {
	toolName: string;
	summary: string;
	isStreaming?: boolean;
}

export interface AgentRunContext {
	readonly paneId: string;
	readonly cwd: string;
	readonly referencePaths?: readonly string[];
	readonly model?: string;
	readonly reasoningLevel?: string;
	getSessionId(): string | null;
	isCancelled(): boolean;
	updateSessionId(nextSessionId: string): void;
	emitChatEvent(event: ChatStreamEvent): void;
	emitAgentEvent(event: AgentEvent): void;
	emitStatus(status: string, isLoading?: boolean): void;
	emitActivity(activity: AgentActivityEvent): void;
	emitSystemMessage(message: string): void;
}

export interface AgentHandle {
	run(): Promise<AgentRunResult | undefined>;
	stop(): void;
	kill(): void;
}

export interface AgentRunResult {
	lastAssistantMessage?: string;
}

export interface AgentAdapter<State = unknown> {
	readonly kind: ChatAgentKind;
	readonly displayName: string;
	createState(ctx: AgentRunContext): State;
	createHandle(prompt: string, ctx: AgentRunContext, state: State): AgentHandle;
}

export function summarizeToolInput(toolName: string, input: unknown): string {
	if (!input || typeof input !== "object") return toolName;
	const payload = input as Record<string, unknown>;
	const command = payload.command ?? payload.cmd;
	if (typeof command === "string" && command) return trimSummary(command, 64);
	const query = payload.query;
	if (typeof query === "string" && query) return trimSummary(query, 64);
	const path = payload.path ?? payload.file ?? payload.file_path;
	if (typeof path === "string" && path) return basename(path);
	const files = payload.files ?? payload.changes;
	if (Array.isArray(files) && files.length > 0) {
		const first = files[0];
		const firstPath =
			typeof first === "string"
				? first
				: typeof first === "object" && first
					? ((first as Record<string, unknown>).path ??
						(first as Record<string, unknown>).file ??
						(first as Record<string, unknown>).file_path)
					: null;
		if (typeof firstPath === "string" && firstPath) {
			return files.length === 1
				? basename(firstPath)
				: `${basename(firstPath)} +${files.length - 1}`;
		}
		return `${files.length} changes`;
	}
	return toolName;
}

export async function drainStreamToString(
	stream: ReadableStream<Uint8Array>,
	maxChars = MAX_STREAM_CHARS
) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
		if (text.length > maxChars) text = text.slice(-maxChars);
	}
	return text + decoder.decode();
}

export function parseNdjsonLines(
	leftover: string,
	handler: (event: unknown) => void
): string {
	const lines = leftover.split("\n");
	const remainder = lines.pop()!;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			handler(JSON.parse(line));
		} catch {}
	}
	return remainder;
}

export function flushNdjsonLeftover(
	leftover: string,
	handler: (event: unknown) => void
) {
	if (!leftover.trim()) return;
	try {
		handler(JSON.parse(leftover));
	} catch {}
}
