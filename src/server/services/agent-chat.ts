import type { ServerWebSocket } from "bun";
import type { ChatAgentKind } from "../../features/agents/agents.ts";
import type { ChatServerMessage } from "../../features/chat/agent-chat-shared.ts";
import { isChatStreamEvent } from "../../features/chat/agent-chat-shared.ts";
import {
	createAgentEnv,
	resolveAgentBinary,
} from "../../features/terminal/terminal-command.ts";
import { getAgentAdapter, resolveAgentModel } from "../agents/registry.ts";
import {
	drainStreamToString,
	flushNdjsonLeftover,
	parseNdjsonLines,
} from "../agents/stream-utils.ts";
import type { AgentRunContext } from "../agents/types.ts";
import { resolveAllowedLocalPath } from "../security.ts";
import {
	CODEX_WORKFLOW_INSTRUCTIONS,
	createGoalContinuationPrompt,
	createGoalPrompt,
	deriveGoalView,
	GOAL_MAX_TURNS,
	goalResultStatus,
	parseGoalCommand,
	stripGoalMarkers,
} from "./chat-goals.ts";
import { type ChatSession, chatRuntime } from "./chat-runtime.ts";
import { readChatTranscript } from "./chat-transcripts.ts";
import { CheckpointService } from "./checkpoint.ts";

interface AgentSessionInfo {
	paneId: string;
	agentKind: ChatAgentKind;
	cwd: string;
	referencePaths: string[];
	sessionId: string | null;
	isRunning: boolean;
	clientCount: number;
	messageCount: number;
}

type SendChatMessageInput = {
	agentKind?: ChatAgentKind;
	clientSessionId?: string | null;
	cwd?: string;
	model?: string;
	paneId: string;
	reasoningLevel?: string;
	referencePaths?: string[];
	text: string;
	ws: ServerWebSocket<any>;
};

type EmitChatMessage = (message: ChatServerMessage) => void;

function normalizeChatReferencePaths(paths?: string[]): string[] {
	if (!Array.isArray(paths)) return [];
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const path of paths) {
		if (typeof path !== "string") continue;
		const trimmed = path.trim();
		if (!trimmed) continue;
		const resolved = resolveAllowedLocalPath(trimmed);
		if (!resolved || seen.has(resolved)) continue;
		seen.add(resolved);
		normalized.push(resolved);
	}
	return normalized;
}

function normalizeChatCwd(cwd?: string): string {
	return (cwd ? resolveAllowedLocalPath(cwd) : null) ?? process.cwd();
}

async function createChatCheckpoint(
	paneId: string,
	cwd: string,
	text: string,
	emit: EmitChatMessage
): Promise<string | null> {
	try {
		const checkpointId = await CheckpointService.createCheckpoint(
			paneId,
			cwd,
			text
		);
		emit({ type: "checkpoint:created", paneId, checkpointId });
		return checkpointId;
	} catch (error) {
		console.error("[Checkpoint] Failed to create:", error);
		return null;
	}
}

async function finalizeChatCheckpoint(
	session: ChatSession,
	paneId: string,
	checkpointId: string | null,
	emit: EmitChatMessage
): Promise<number> {
	if (!checkpointId) return 0;
	try {
		const cpMeta = await CheckpointService.finalizeCheckpoint(checkpointId);
		if (!cpMeta || cpMeta.changedFileCount === 0) return 0;
		emit({
			type: "checkpoint:finalized",
			paneId,
			checkpointId,
			changedFileCount: cpMeta.changedFileCount,
			changedFiles: cpMeta.changedFiles,
		});
		const existingEditPaths = new Set<string>();
		for (const message of session.messageBuffer.getMessages()) {
			if (message.role !== "tool" || message.toolName !== "Edit") continue;
			try {
				const parsed = JSON.parse(message.content) as { file_path?: unknown };
				if (typeof parsed.file_path === "string") {
					existingEditPaths.add(parsed.file_path);
				}
			} catch {}
		}
		for (const diff of await CheckpointService.getInlineDiffs(checkpointId)) {
			if (existingEditPaths.has(diff.path)) continue;
			const startEvent = {
				type: "content_block_start" as const,
				content_block: {
					type: "tool_use" as const,
					name: "Edit",
					input: {
						file_path: diff.path,
						old_string: diff.oldString,
						new_string: diff.newString,
					},
				},
			};
			const stopEvent = { type: "content_block_stop" as const };
			session.messageBuffer.applyEvent(startEvent);
			emit({ type: "chat:event", paneId, event: startEvent });
			session.messageBuffer.applyEvent(stopEvent);
			emit({ type: "chat:event", paneId, event: stopEvent });
		}
		return cpMeta.changedFileCount;
	} catch (error) {
		console.error("[Checkpoint] Failed to finalize:", error);
		return 0;
	}
}

function ensureVisibleTurnCompletion(
	session: ChatSession,
	paneId: string,
	changedFileCount: number,
	emit: EmitChatMessage
) {
	const messages = session.messageBuffer.getMessages();
	const last = messages[messages.length - 1];
	if (last?.role === "assistant" && last.content.trim()) return;
	if (changedFileCount <= 0 && last?.role !== "tool") return;
	const text =
		changedFileCount > 0
			? `Updated ${changedFileCount} file${changedFileCount === 1 ? "" : "s"}.`
			: "Finished.";
	const event = { type: "result" as const, result: text };
	session.messageBuffer.applyEvent(event);
	emit({ type: "chat:event", paneId, event });
}

async function runBtwChatMessage(
	paneId: string,
	text: string,
	cwd: string | undefined,
	emit: EmitChatMessage
) {
	const effectiveCwd = normalizeChatCwd(cwd);
	const claudeCmd = resolveAgentBinary("claude");
	let fullText = "";

	emit({ type: "chat:btw:start", paneId, question: text });

	try {
		const proc = Bun.spawn(
			[
				claudeCmd,
				"-p",
				text,
				"--dangerously-skip-permissions",
				"--output-format",
				"stream-json",
				"--verbose",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				cwd: effectiveCwd,
				env: createAgentEnv("claude"),
			}
		);
		const stderrPromise = drainStreamToString(
			proc.stderr as ReadableStream<Uint8Array>
		);
		const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let leftover = "";

		const handleBtwEvent = (event: unknown) => {
			if (!isChatStreamEvent(event)) return;
			if (
				event.type === "content_block_delta" &&
				event.delta?.type === "text_delta" &&
				typeof event.delta.text === "string"
			) {
				fullText += event.delta.text;
				emit({ type: "chat:btw:delta", paneId, text: event.delta.text });
			} else if (
				event.type === "content_block_start" &&
				event.content_block?.type === "text" &&
				typeof event.content_block.text === "string" &&
				event.content_block.text
			) {
				fullText += event.content_block.text;
				emit({
					type: "chat:btw:delta",
					paneId,
					text: event.content_block.text,
				});
			} else if (event.type === "result" && event.result && !fullText) {
				fullText = event.result;
			}
		};

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			leftover += decoder.decode(value, { stream: true });
			leftover = parseNdjsonLines(leftover, handleBtwEvent);
		}
		flushNdjsonLeftover(leftover, handleBtwEvent);
		await proc.exited;
		const stderrText = (await stderrPromise).trim();
		if (!fullText && stderrText) fullText = stderrText;
	} catch (err) {
		if (!fullText) fullText = err instanceof Error ? err.message : "(error)";
	}

	emit({
		type: "chat:btw:done",
		paneId,
		answer: fullText || "(no response)",
	});
}

async function runAgent(
	session: ChatSession,
	paneId: string,
	text: string,
	emitDone = true
) {
	const adapter = getAgentAdapter(session.agentKind);
	const prompt =
		session.agentKind === "codex"
			? `${CODEX_WORKFLOW_INSTRUCTIONS}\n\n${text}`
			: text;
	session.agentEvents ??= [];
	const ctx: AgentRunContext = {
		paneId,
		cwd: session.cwd,
		referencePaths: session.referencePaths,
		model: session.model,
		reasoningLevel: session.reasoningLevel,
		getSessionId: () => session.sessionId,
		isCancelled: () => session.cancelled,
		updateSessionId: (nextSessionId) =>
			chatRuntime.updateSessionId(session, nextSessionId),
		emitChatEvent: (event) => {
			chatRuntime.send(session, { type: "chat:event", paneId, event });
			session.messageBuffer.applyEvent(event);
			chatRuntime.scheduleTranscriptPersist(session, paneId);
		},
		emitAgentEvent: (event) => {
			session.agentEvents.push(event);
			if (session.agentEvents.length > 500) {
				session.agentEvents = session.agentEvents.slice(-500);
			}
			chatRuntime.send(session, {
				type: "chat:agent-event",
				paneId,
				event,
			});
		},
		emitStatus: (status, isLoading = true) =>
			sendChatStatus(session, paneId, status, isLoading),
		emitActivity: (activity) =>
			chatRuntime.send(session, {
				type: "chat:activity",
				paneId,
				activity,
			}),
		emitSystemMessage: (message) => {
			emitSystemMessage(session, paneId, message);
			chatRuntime.persistTranscript(session, paneId);
		},
	};
	const state = adapter.createState(ctx);
	const handle = adapter.createHandle(prompt, ctx, state);
	session.currentHandle = handle;

	try {
		return await handle.run();
	} finally {
		session.currentHandle = null;
		if (emitDone) chatRuntime.finalizeTurn(session);
	}
}

function getLastAssistantMessage(result: Awaited<ReturnType<typeof runAgent>>) {
	return result && typeof result === "object"
		? result.lastAssistantMessage
		: undefined;
}

function emitSystemMessage(
	session: ChatSession,
	paneId: string,
	message: string
) {
	session.messageBuffer.pushSystem(message);
	chatRuntime.send(session, { type: "chat:system", paneId, message });
}

function sendChatStatus(
	target: ServerWebSocket<any> | ChatSession,
	paneId: string,
	status: string,
	isLoading: boolean
) {
	chatRuntime.send(target, { type: "chat:status", paneId, status, isLoading });
}

function createSystemPrefix(
	session: ChatSession,
	includeWorkspace: boolean,
	includePriorContext: boolean
) {
	const workspace =
		includeWorkspace && !session.sessionId
			? `<workspace-context>\n${[
					"You are working in a multi-directory workspace.",
					session.cwd
						? `Primary working directory (use this as the execution root unless the user says otherwise): ${session.cwd}`
						: null,
					session.referencePaths.length
						? `Additional reference directories available in this workspace:\n${session.referencePaths.map((path) => `- ${path}`).join("\n")}`
						: null,
					session.referencePaths.length
						? "The additional directories are supporting context. Read and reference them when relevant, but treat the primary working directory as the default root."
						: null,
				]
					.filter(Boolean)
					.join("\n\n")}\n</workspace-context>`
			: "";
	const contextLines = includePriorContext
		? session.messageBuffer
				.getMessages()
				.slice(-20)
				.flatMap((message) =>
					message.role === "user"
						? [`User: ${message.content.slice(0, 500)}`]
						: message.role === "assistant" && message.content
							? [`Assistant: ${message.content.slice(0, 500)}`]
							: []
				)
		: [];
	const prior = contextLines.length
		? `<prior-conversation-context>\nThe following is a summary of the prior conversation in this chat session (from a different model). Use it as context for the request below.\n\n${contextLines.join("\n\n")}\n</prior-conversation-context>`
		: "";
	return [workspace, prior].filter(Boolean).join("\n\n");
}

async function handleGoalCommand(
	session: ChatSession,
	paneId: string,
	command: NonNullable<ReturnType<typeof parseGoalCommand>>
) {
	if (command.action === "start") {
		session.goal = {
			objective: command.objective,
			status: "active",
			turns: 0,
			startedAt: Date.now(),
		};
		emitSystemMessage(session, paneId, `Goal started: ${command.objective}`);
		return createGoalPrompt(command.objective);
	}

	if (command.action === "pause") {
		if (session.goal) session.goal.status = "paused";
		const message = session.goal ? "Goal paused" : "No active goal";
		emitSystemMessage(session, paneId, message);
		return null;
	}

	if (command.action === "resume") {
		if (!session.goal) {
			emitSystemMessage(session, paneId, "No goal to resume");
			return null;
		}
		session.goal.status = "active";
		return createGoalContinuationPrompt(session.goal);
	}

	if (command.action === "clear") {
		session.goal = null;
		emitSystemMessage(session, paneId, "Goal cleared");
		return null;
	}

	const message = session.goal
		? `Goal ${session.goal.status}: ${session.goal.objective} (${session.goal.turns} turns)`
		: "No active goal";
	emitSystemMessage(session, paneId, message);
	return null;
}

export const ChatService = {
	async sendMessage({
		agentKind = "claude",
		clientSessionId,
		cwd,
		model,
		paneId,
		reasoningLevel,
		referencePaths,
		text,
		ws,
	}: SendChatMessageInput) {
		const nextReferencePaths = normalizeChatReferencePaths(referencePaths);
		const nextCwd = normalizeChatCwd(cwd);
		const session = await chatRuntime.ensureSession(
			paneId,
			ws,
			agentKind,
			nextCwd,
			nextReferencePaths,
			clientSessionId || null,
			model,
			reasoningLevel
		);
		session.referencePaths ??= [];
		const agentKindChanged = session.agentKind !== agentKind;
		if (agentKindChanged) {
			session.sessionId = null; // clear when switching agent kinds
		}
		session.agentKind = agentKind;
		session.model = resolveAgentModel(agentKind, model);
		if (reasoningLevel !== undefined) session.reasoningLevel = reasoningLevel;
		session.clients.add(ws);
		if (cwd) session.cwd = nextCwd;
		if (referencePaths) session.referencePaths = nextReferencePaths;
		if (!session.sessionId && clientSessionId)
			chatRuntime.updateSessionId(session, clientSessionId);
		const systemPrefix = createSystemPrefix(
			session,
			!!cwd || nextReferencePaths.length > 0,
			agentKindChanged
		);

		session.messageBuffer.pushUser(text);
		chatRuntime.persistTranscript(session, paneId);
		chatRuntime.send(
			session,
			{
				type: "chat:user_message",
				paneId,
				text,
			},
			ws
		);

		if (session.currentHandle) {
			chatRuntime.send(ws, {
				type: "chat:error",
				paneId,
				error: `${getAgentAdapter(session.agentKind).displayName} is still responding`,
			});
			return;
		}
		session.cancelled = false;

		const goalCommand = agentKind === "codex" ? parseGoalCommand(text) : null;
		let prompt = text;
		if (goalCommand) {
			const goalPrompt = await handleGoalCommand(session, paneId, goalCommand);
			if (!goalPrompt) {
				chatRuntime.finalizeTurn(session);
				return;
			}
			prompt = goalPrompt;
		}
		if (systemPrefix) {
			prompt = `${systemPrefix}\n\n${prompt}`;
		}

		const emit = chatRuntime.send.bind(chatRuntime, session);
		const checkpointId = await createChatCheckpoint(
			paneId,
			session.cwd,
			text,
			emit
		);

		try {
			const isGoalRun = session.goal?.status === "active";
			let result = await runAgent(session, paneId, prompt, false);
			if (isGoalRun && session.goal?.status === "active") {
				session.goal.turns += 1;
				let resultStatus = goalResultStatus(getLastAssistantMessage(result));
				while (
					!session.cancelled &&
					session.goal?.status === "active" &&
					resultStatus === "active" &&
					session.goal.turns < GOAL_MAX_TURNS
				) {
					const nextPrompt = createGoalContinuationPrompt(session.goal);
					result = await runAgent(session, paneId, nextPrompt, false);
					session.goal.turns += 1;
					resultStatus = goalResultStatus(getLastAssistantMessage(result));
				}

				if (session.goal && resultStatus === "complete") {
					session.messageBuffer.replaceInAssistantMessages(stripGoalMarkers);
					const message = `Goal achieved after ${session.goal.turns} turns`;
					session.goal = null;
					emitSystemMessage(session, paneId, message);
				} else if (session.goal && resultStatus === "paused") {
					session.messageBuffer.replaceInAssistantMessages(stripGoalMarkers);
					session.goal.status = "paused";
					const message =
						"Goal paused because Codex needs input. Reply with the missing detail or use /goal resume.";
					emitSystemMessage(session, paneId, message);
				} else if (session.goal && session.goal.turns >= GOAL_MAX_TURNS) {
					session.goal.status = "paused";
					emitSystemMessage(
						session,
						paneId,
						`Goal paused after ${GOAL_MAX_TURNS} turns`
					);
				}
			}
			const changedFileCount = await finalizeChatCheckpoint(
				session,
				paneId,
				checkpointId,
				emit
			);
			ensureVisibleTurnCompletion(session, paneId, changedFileCount, emit);
			chatRuntime.finalizeTurn(session);
		} catch (e) {
			session.currentHandle = null;
			const errMsg =
				e instanceof Error ? e.message : `Failed to run ${session.agentKind}`;
			emitSystemMessage(session, paneId, errMsg);
			session.messageBuffer.finalize();
			chatRuntime.persistTranscript(session, paneId);
			chatRuntime.send(session, {
				type: "chat:error",
				paneId,
				error: errMsg,
			});
			await finalizeChatCheckpoint(session, paneId, checkpointId, emit);
			chatRuntime.scheduleCleanup(session);
		}
	},

	async sendBtwMessage(
		paneId: string,
		text: string,
		ws: ServerWebSocket<any>,
		cwd?: string
	) {
		await runBtwChatMessage(paneId, text, cwd, (message) =>
			chatRuntime.send(ws, message)
		);
	},

	stopGeneration(paneId: string) {
		const session = chatRuntime.getSession(paneId);
		if (session) {
			session.cancelled = true;
			session.goal = null;
		}
		if (session?.currentHandle) {
			try {
				session.currentHandle.stop();
			} catch {}
		}
		if (session) {
			session.currentHandle = null;
			chatRuntime.finalizeTurn(session);
			sendChatStatus(session, paneId, "idle", false);
		}
	},

	destroySession(paneId: string) {
		const session = chatRuntime.getSession(paneId);
		if (session) {
			session.cancelled = true;
			session.goal = null;
		}
		if (session?.currentHandle) {
			try {
				session.currentHandle.kill();
			} catch {}
		}
		if (session) {
			chatRuntime.clearCleanupTimer(session);
			chatRuntime.persistTranscript(session, paneId);
		}
		chatRuntime.deleteSession(paneId);
	},

	cleanupWs(ws: ServerWebSocket<any>) {
		for (const session of chatRuntime.values()) {
			session.clients.delete(ws);
			chatRuntime.scheduleCleanup(session);
		}
	},

	async reassignWs(paneId: string, ws: ServerWebSocket<any>) {
		const session = chatRuntime.getSession(paneId);
		if (!session) {
			const transcript = await readChatTranscript(paneId);
			chatRuntime.send(ws, {
				type: "chat:sync",
				paneId,
				messages: transcript ?? [],
				isStreaming: false,
			});
			sendChatStatus(ws, paneId, "idle", false);
			return;
		}
		chatRuntime.clearCleanupTimer(session);
		session.clients.add(ws);
		if (session.sessionId)
			chatRuntime.send(ws, {
				type: "chat:session",
				paneId,
				sessionId: session.sessionId,
			});
		const messages = session.messageBuffer.getMessages();
		chatRuntime.send(ws, {
			type: "chat:sync",
			paneId,
			messages,
			isStreaming: session.messageBuffer.streaming,
		});
		sendChatStatus(
			ws,
			paneId,
			session.currentHandle
				? session.messageBuffer.streaming
					? "responding"
					: "thinking"
				: "idle",
			!!session.currentHandle
		);
	},

	listSessions(): AgentSessionInfo[] {
		return Array.from(chatRuntime.values())
			.filter((s) => s.currentHandle || s.clients.size > 0)
			.map((s) => ({
				paneId: s.paneId,
				agentKind: s.agentKind,
				cwd: s.cwd,
				referencePaths: s.referencePaths,
				sessionId: s.sessionId,
				isRunning: !!s.currentHandle,
				clientCount: s.clients.size,
				messageCount: s.messageBuffer.getMessages().length,
			}));
	},

	listGoals() {
		const now = Date.now();
		return Array.from(chatRuntime.values())
			.filter((session) => !!session.goal)
			.map((session) => {
				const view = deriveGoalView(session);
				return {
					paneId: session.paneId,
					agentKind: session.agentKind,
					cwd: session.cwd,
					sessionId: session.sessionId,
					isRunning: !!session.currentHandle,
					clientCount: session.clients.size,
					objective: session.goal!.objective,
					status: session.goal!.status,
					turns: session.goal!.turns,
					startedAt: session.goal!.startedAt,
					elapsedMs: now - session.goal!.startedAt,
					...view,
				};
			});
	},

	destroyAll() {
		for (const session of chatRuntime.values()) {
			session.cancelled = true;
			session.goal = null;
			if (session.currentHandle) {
				try {
					session.currentHandle.kill();
				} catch {}
			}
			chatRuntime.clearCleanupTimer(session);
		}
		chatRuntime.clear();
	},
};
