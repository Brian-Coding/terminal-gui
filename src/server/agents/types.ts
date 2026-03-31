import type { ChatAgentKind } from "../../lib/agents.ts";

export interface AgentRunContext {
	readonly paneId: string;
	readonly cwd: string;
	getSessionId(): string | null;
	updateSessionId(nextSessionId: string): void;
	emitChatEvent(event: unknown): void;
	emitStatus(status: string, isLoading?: boolean): void;
	emitSystemMessage(message: string): void;
}

export interface AgentHandle {
	/** Run the agent turn to completion, emitting events via ctx. */
	run(): Promise<void>;
	/** Gracefully stop the current turn. */
	stop(): void;
	/** Forcefully kill the underlying process. */
	kill(): void;
}

export interface AgentAdapter<State = unknown> {
	readonly kind: ChatAgentKind;
	readonly displayName: string;
	createState(ctx: AgentRunContext): State;
	createHandle(prompt: string, ctx: AgentRunContext, state: State): AgentHandle;
}
