import type { ServerWebSocket } from "bun";
import type { ChatAgentKind } from "../../features/agents/agents.ts";
import type { ChatServerMessage } from "../../features/chat/agent-chat-shared.ts";
import type { AgentEvent } from "../agents/events.ts";
import type { AgentHandle } from "../agents/types.ts";
import type { GoalState } from "./chat-goals.ts";
import { ChatMessageBuffer } from "./chat-message-buffer.ts";
import { readChatTranscript, writeChatTranscript } from "./chat-transcripts.ts";

const DISCONNECTED_SESSION_TTL_MS = 5 * 60 * 1000;
const TRANSCRIPT_PERSIST_DEBOUNCE_MS = 250;

export interface ChatSession {
	paneId: string;
	agentKind: ChatAgentKind;
	model?: string;
	reasoningLevel?: string;
	sessionId: string | null;
	clients: Set<ServerWebSocket<any>>;
	currentHandle: AgentHandle | null;
	cwd: string;
	referencePaths: string[];
	messageBuffer: ChatMessageBuffer;
	cleanupTimer: ReturnType<typeof setTimeout> | null;
	transcriptPersistTimer: ReturnType<typeof setTimeout> | null;
	cancelled: boolean;
	goal: GoalState | null;
	agentEvents: AgentEvent[];
}

const _g = globalThis as any;
if (!_g.__inferay_chatSessions)
	_g.__inferay_chatSessions = new Map<string, ChatSession>();
const sessions: Map<string, ChatSession> = _g.__inferay_chatSessions;

export const chatRuntime = {
	async ensureSession(
		paneId: string,
		ws: ServerWebSocket<any> | undefined,
		agentKind: ChatAgentKind,
		cwd: string,
		referencePaths: string[],
		sessionId: string | null,
		model?: string,
		reasoningLevel?: string
	): Promise<ChatSession> {
		let session = sessions.get(paneId);
		if (session) {
			this.clearCleanupTimer(session);
			if (ws) session.clients.add(ws);
			return session;
		}

		const messageBuffer = new ChatMessageBuffer();
		const transcript = await readChatTranscript(paneId);
		if (transcript?.length) messageBuffer.replaceMessages(transcript);
		session = {
			paneId,
			agentKind,
			model,
			reasoningLevel,
			sessionId,
			clients: ws ? new Set([ws]) : new Set(),
			currentHandle: null,
			cwd,
			referencePaths,
			messageBuffer,
			cleanupTimer: null,
			transcriptPersistTimer: null,
			cancelled: false,
			goal: null,
			agentEvents: [],
		};
		sessions.set(paneId, session);
		return session;
	},

	getSession(paneId: string): ChatSession | undefined {
		return sessions.get(paneId);
	},

	deleteSession(paneId: string) {
		sessions.delete(paneId);
	},

	values(): IterableIterator<ChatSession> {
		return sessions.values();
	},

	clear() {
		sessions.clear();
	},

	send(
		target: ServerWebSocket<any> | ChatSession,
		msg: ChatServerMessage,
		exclude?: ServerWebSocket<any>
	) {
		const json = JSON.stringify(msg);
		if ("clients" in target) {
			for (const ws of target.clients) {
				if (ws !== exclude && ws.readyState === 1) ws.send(json);
			}
		} else if (target.readyState === 1) {
			target.send(json);
		}
	},

	persistTranscript(session: ChatSession, paneId = session.paneId): void {
		if (session.transcriptPersistTimer) {
			clearTimeout(session.transcriptPersistTimer);
			session.transcriptPersistTimer = null;
		}
		writeChatTranscript(paneId, session.messageBuffer.getMessages()).catch(
			(error) => {
				console.error(
					"[ChatService] Failed to persist chat transcript:",
					error
				);
			}
		);
	},

	scheduleTranscriptPersist(
		session: ChatSession,
		paneId = session.paneId
	): void {
		if (session.transcriptPersistTimer) return;
		session.transcriptPersistTimer = setTimeout(() => {
			session.transcriptPersistTimer = null;
			this.persistTranscript(session, paneId);
		}, TRANSCRIPT_PERSIST_DEBOUNCE_MS);
	},

	clearCleanupTimer(session: ChatSession) {
		if (!session.cleanupTimer) return;
		clearTimeout(session.cleanupTimer);
		session.cleanupTimer = null;
	},

	scheduleCleanup(session: ChatSession) {
		this.clearCleanupTimer(session);
		if (session.currentHandle || session.clients.size > 0) return;
		session.cleanupTimer = setTimeout(() => {
			const current = sessions.get(session.paneId);
			if (!current || current.currentHandle || current.clients.size > 0) return;
			sessions.delete(session.paneId);
		}, DISCONNECTED_SESSION_TTL_MS);
	},

	updateSessionId(session: ChatSession, nextSessionId: string | null) {
		if (!nextSessionId || session.sessionId === nextSessionId) return;
		session.sessionId = nextSessionId;
		this.send(session, {
			type: "chat:session",
			paneId: session.paneId,
			sessionId: nextSessionId,
		});
	},

	finalizeTurn(session: ChatSession) {
		session.messageBuffer.finalize();
		this.persistTranscript(session);
		this.send(session, {
			type: "chat:sync",
			paneId: session.paneId,
			messages: session.messageBuffer.getMessages(),
			isStreaming: false,
		});
		this.send(session, { type: "chat:done", paneId: session.paneId });
		this.scheduleCleanup(session);
	},
};
