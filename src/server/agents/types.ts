import type { ChatAgentKind } from "../../lib/agents.ts";

export interface AgentActivityEvent {
	toolName: string;
	summary: string;
	isStreaming?: boolean;
}

export interface AgentRunContext {
	readonly paneId: string;
	readonly cwd: string;
	readonly model?: string;
	readonly reasoningLevel?: string;
	getSessionId(): string | null;
	updateSessionId(nextSessionId: string): void;
	emitChatEvent(event: unknown): void;
	emitStatus(status: string, isLoading?: boolean): void;
	emitActivity(activity: AgentActivityEvent): void;
	emitSystemMessage(message: string): void;
}

export interface AgentHandle {
	run(): Promise<AgentRunResult | void>;
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
