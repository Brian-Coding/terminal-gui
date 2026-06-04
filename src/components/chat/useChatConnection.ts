import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	appendTrimmedMessage,
	type ChatLoadingState,
	type ChatMessage,
	type ChatStreamEvent,
	type ChatUiState,
	type CheckpointInfo,
	isChatServerMessage,
	nextId,
	type QueuedMessageInfo,
	type ToolActivity,
	trimMessages,
} from "../../features/chat/agent-chat-shared.ts";
import {
	loadStoredCheckpoints,
	saveStoredCheckpoints,
	saveStoredSessionId,
} from "../../features/chat/chat-session-store.ts";
import { getToolBlockInitialContent } from "../../features/chat/chat-stream-events.ts";
import { wsClient } from "../../lib/websocket.ts";
import {
	clearLiveActivities,
	markRespondingState,
	markToolState,
} from "./chat-agent-utils.ts";
import {
	appendMessageContent,
	appendSystemMessage,
	dedupeChatMessagesById,
	mergeSyncedMessages,
	patchMessageById,
} from "./chat-state-utils.ts";

function scheduleFrame(callback: () => void): number {
	if (typeof window !== "undefined" && window.requestAnimationFrame) {
		return window.requestAnimationFrame(callback);
	}
	return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(id: number) {
	if (typeof window !== "undefined" && window.cancelAnimationFrame) {
		window.cancelAnimationFrame(id);
		return;
	}
	clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

export function useChatConnection({
	enabled = true,
	messagesRef,
	paneId,
	replaceQueuedMessages,
	saveMessagesNow,
	setChatUiState,
	setLoadingState,
	setMessages,
}: {
	enabled?: boolean;
	messagesRef: MutableRefObject<ChatMessage[]>;
	paneId: string;
	replaceQueuedMessages: (messages: QueuedMessageInfo[]) => void;
	saveMessagesNow: (messages: ChatMessage[]) => ChatMessage[];
	setChatUiState: Dispatch<SetStateAction<ChatUiState>>;
	setLoadingState: (
		value: ChatLoadingState | ((prev: ChatLoadingState) => ChatLoadingState)
	) => void;
	setMessages: (
		update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])
	) => void;
}) {
	const currentAssistantRef = useRef<string | null>(null);
	const currentBtwRef = useRef<string | null>(null);
	const currentToolRef = useRef<string | null>(null);
	const hasStreamedRef = useRef(false);
	const pendingContentRef = useRef<Map<string, string>>(new Map());
	const flushFrameRef = useRef<number | null>(null);
	const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>(() =>
		loadStoredCheckpoints<CheckpointInfo>(paneId)
	);
	const applyPendingContent = useCallback(
		(messages: ChatMessage[], pending: Map<string, string>) => {
			let next: ChatMessage[] = messages;
			for (const [targetId, content] of pending) {
				next = appendMessageContent(next, targetId, content) as ChatMessage[];
			}
			return next;
		},
		[]
	);
	const flushPendingContent = useCallback(() => {
		if (flushFrameRef.current !== null) {
			cancelFrame(flushFrameRef.current);
			flushFrameRef.current = null;
		}
		const pending = pendingContentRef.current;
		if (pending.size === 0) return messagesRef.current;
		pendingContentRef.current = new Map();
		const next = applyPendingContent(messagesRef.current, pending);
		messagesRef.current = next;
		setMessages(next);
		return next;
	}, [applyPendingContent, messagesRef, setMessages]);
	const clearPendingContent = useCallback(() => {
		if (flushFrameRef.current !== null) {
			cancelFrame(flushFrameRef.current);
			flushFrameRef.current = null;
		}
		pendingContentRef.current = new Map();
	}, []);
	const queueMessageContent = useCallback(
		(targetId: string, content: string) => {
			if (!content) return;
			const pending = pendingContentRef.current;
			pending.set(targetId, (pending.get(targetId) ?? "") + content);
			if (flushFrameRef.current !== null) return;
			flushFrameRef.current = scheduleFrame(() => {
				flushFrameRef.current = null;
				const queued = pendingContentRef.current;
				if (queued.size === 0) return;
				pendingContentRef.current = new Map();
				setMessages((prev) => applyPendingContent(prev, queued));
			});
		},
		[applyPendingContent, setMessages]
	);
	const resetStreamState = useCallback(() => {
		flushPendingContent();
		currentAssistantRef.current = null;
		currentToolRef.current = null;
		hasStreamedRef.current = false;
	}, [flushPendingContent]);
	const clearCheckpoints = useCallback(() => {
		setCheckpoints([]);
		saveStoredCheckpoints(paneId, []);
	}, [paneId]);
	const revertCheckpoint = useCallback(
		(checkpointId: string) => {
			wsClient.send({ type: "checkpoint:revert", paneId, checkpointId });
		},
		[paneId]
	);
	function appendAssistant(content: string, isStreaming: boolean) {
		const id = nextId();
		currentAssistantRef.current = id;
		setLoadingState(markRespondingState);
		setMessages(
			appendTrimmedMessage.bind(null, {
				id,
				role: "assistant",
				content,
				isStreaming,
			})
		);
	}
	function appendTool(toolName: string, content: string) {
		const id = nextId();
		currentAssistantRef.current = null;
		currentToolRef.current = id;
		setLoadingState(markToolState.bind(null, toolName));
		setMessages(
			appendTrimmedMessage.bind(null, {
				id,
				role: "tool",
				content,
				toolName,
				isStreaming: true,
			})
		);
	}
	function handleChatEvent(event: ChatStreamEvent) {
		if (event.type === "assistant") {
			const msg = event.message;
			if (!msg?.content || hasStreamedRef.current) return;
			for (const block of msg.content) {
				if (block.type === "text" && block.text) {
					setLoadingState(markRespondingState);
					if (currentAssistantRef.current) {
						const targetId = currentAssistantRef.current;
						setMessages((prev) =>
							patchMessageById(
								prev,
								targetId,
								{
									content: block.text,
									isStreaming: !msg.stop_reason,
								},
								false
							)
						);
					} else {
						appendAssistant(block.text, !msg.stop_reason);
					}
				} else if (block.type === "tool_use") {
					appendTool(
						block.name,
						typeof block.input === "string"
							? block.input
							: JSON.stringify(block.input, null, 2)
					);
				}
			}
		} else if (event.type === "content_block_start") {
			hasStreamedRef.current = true;
			const block = event.content_block;
			if (block?.type === "text") {
				appendAssistant(block.text || "", true);
			} else if (block?.type === "tool_use") {
				appendTool(block.name, getToolBlockInitialContent(block));
			}
		} else if (event.type === "content_block_delta") {
			const delta = event.delta;
			if (
				delta?.type === "text_delta" &&
				delta.text &&
				currentAssistantRef.current
			) {
				const targetId = currentAssistantRef.current;
				const text = delta.text;
				queueMessageContent(targetId, text);
			} else if (
				delta?.type === "input_json_delta" &&
				delta.partial_json &&
				currentToolRef.current
			) {
				const targetId = currentToolRef.current;
				const partialJson = delta.partial_json;
				queueMessageContent(targetId, partialJson);
			}
		} else if (event.type === "content_block_stop") {
			flushPendingContent();
			setMessages((prev) => {
				let updated = prev.slice();
				let changed = false;
				if (currentAssistantRef.current) {
					const next = patchMessageById(updated, currentAssistantRef.current, {
						isStreaming: false,
					});
					changed = next !== updated || changed;
					updated = next;
				}
				if (currentToolRef.current) {
					const next = patchMessageById(updated, currentToolRef.current, {
						isStreaming: false,
					});
					changed = next !== updated || changed;
					updated = next;
				}
				resetStreamState();
				return changed ? trimMessages(updated) : prev;
			});
		} else if (event.type === "result" && event.result) {
			flushPendingContent();
			const result = event.result;
			setLoadingState(markRespondingState);
			if (currentAssistantRef.current) {
				const targetId = currentAssistantRef.current;
				setMessages((prev) => {
					const updated = patchMessageById(
						prev,
						targetId,
						{ content: result, isStreaming: false },
						false
					);
					if (updated !== prev) return updated;
					return trimMessages([
						...prev,
						{ id: nextId(), role: "assistant", content: result },
					]);
				});
				currentAssistantRef.current = null;
			} else {
				setMessages((prev) => {
					const last = prev[prev.length - 1];
					if (last?.role === "assistant" && last.content === result)
						return prev;
					return trimMessages([
						...prev,
						{ id: nextId(), role: "assistant", content: result },
					]);
				});
			}
		}
	}
	const handleChatEventRef = useRef(handleChatEvent);
	handleChatEventRef.current = handleChatEvent;

	useEffect(() => {
		if (!enabled) {
			clearPendingContent();
			return;
		}
		const cleanup = wsClient.subscribe(paneId, (rawMessage) => {
			if (!isChatServerMessage(rawMessage)) return;
			const msg = rawMessage;
			if (msg.type === "chat:event") {
				handleChatEventRef.current(msg.event);
				if (msg.event?.session_id)
					saveStoredSessionId(paneId, msg.event.session_id);
			} else if (msg.type === "chat:session") {
				if (msg.sessionId) saveStoredSessionId(paneId, msg.sessionId);
			} else if (msg.type === "chat:done") {
				const flushedMessages = flushPendingContent();
				const updated = saveMessagesNow(flushedMessages);
				setMessages(updated);
				const ids = new Set(updated.map((message) => message.id));
				setLoadingState({ isLoading: false, status: "idle", startTime: null });
				setChatUiState((prev) => {
					const pruned = new Set<string>();
					for (const id of prev.expandedTools) if (ids.has(id)) pruned.add(id);
					return {
						...prev,
						expandedTools:
							pruned.size === prev.expandedTools.size
								? prev.expandedTools
								: pruned,
						liveActivities: [],
					};
				});
				resetStreamState();
				wsClient.send({ type: "chat:reconnect", paneId });
			} else if (msg.type === "chat:user_message") {
				setChatUiState(clearLiveActivities);
				setLoadingState((prev) => ({
					isLoading: true,
					status: "thinking",
					startTime: prev.startTime ?? Date.now(),
				}));
				resetStreamState();
			} else if (msg.type === "chat:error") {
				flushPendingContent();
				setMessages((prev) => appendSystemMessage(prev, msg.error));
				setLoadingState({ isLoading: false, status: "error", startTime: null });
			} else if (msg.type === "chat:system") {
				setMessages((prev) => appendSystemMessage(prev, msg.message));
			} else if (msg.type === "chat:status") {
				setLoadingState((prev) => ({
					isLoading: msg.isLoading ?? prev.isLoading,
					status: msg.status ?? prev.status,
					startTime:
						msg.isLoading === false ? null : (prev.startTime ?? Date.now()),
				}));
			} else if (msg.type === "chat:activity" && msg.activity) {
				const activity = msg.activity;
				setChatUiState((prev) => {
					const nextActivity: ToolActivity = {
						id: `${activity.toolName}-${prev.liveActivities.length}`,
						toolName: activity.toolName,
						summary: activity.summary,
						isStreaming: activity.isStreaming ?? true,
					};
					const last = prev.liveActivities[prev.liveActivities.length - 1];
					if (
						last &&
						last.toolName === nextActivity.toolName &&
						last.summary === nextActivity.summary
					)
						return prev;
					return {
						...prev,
						liveActivities: [...prev.liveActivities, nextActivity].slice(-12),
					};
				});
			} else if (msg.type === "chat:sync") {
				flushPendingContent();
				const serverMessages: ChatMessage[] = dedupeChatMessagesById(
					msg.messages
				);
				const currentMessages = messagesRef.current;
				if (serverMessages.length < currentMessages.length && !msg.isStreaming)
					return;
				if (serverMessages.length > 0) {
					setMessages((prev) =>
						trimMessages(mergeSyncedMessages(prev, serverMessages))
					);
					saveMessagesNow(serverMessages);
				}
				if (msg.isStreaming) {
					setLoadingState((prev) => ({
						isLoading: true,
						status: "responding",
						startTime: prev.startTime ?? Date.now(),
					}));
					const lastAssistant = serverMessages.findLast?.(
						(message: ChatMessage) =>
							message.isStreaming && message.role === "assistant"
					);
					if (lastAssistant) currentAssistantRef.current = lastAssistant.id;
					const lastTool = serverMessages.findLast?.(
						(message: ChatMessage) =>
							message.isStreaming && message.role === "tool"
					);
					if (lastTool) currentToolRef.current = lastTool.id;
				} else {
					setLoadingState({
						isLoading: false,
						status: "idle",
						startTime: null,
					});
					setChatUiState(clearLiveActivities);
					resetStreamState();
				}
			} else if (msg.type === "chat:queue" && Array.isArray(msg.queue)) {
				replaceQueuedMessages(msg.queue);
			} else if (msg.type === "chat:btw:start") {
				const id = nextId();
				currentBtwRef.current = id;
				setMessages(
					appendTrimmedMessage.bind(null, {
						id,
						role: "btw",
						content: "",
						isStreaming: true,
						btwQuestion: msg.question,
					})
				);
			} else if (msg.type === "chat:btw:delta") {
				const targetId = currentBtwRef.current;
				if (targetId) {
					queueMessageContent(targetId, msg.text);
				}
			} else if (msg.type === "chat:btw:done") {
				flushPendingContent();
				const targetId = currentBtwRef.current;
				currentBtwRef.current = null;
				if (targetId) {
					setMessages((prev) =>
						patchMessageById(prev, targetId, {
							content: msg.answer,
							isStreaming: false,
						})
					);
				}
			} else if (msg.type === "checkpoint:finalized") {
				if (msg.changedFileCount <= 0) return;
				setCheckpoints((prev) => {
					const lastMsg =
						messagesRef.current.findLast?.(
							(message) => message.role === "assistant" && !message.isStreaming
						) ??
						messagesRef.current.findLast?.(
							(message) => message.role === "assistant"
						);
					if (!lastMsg || prev.some((c) => c.afterMessageId === lastMsg.id))
						return prev;
					const updated = [
						...prev,
						{
							id: msg.checkpointId,
							timestamp: Date.now(),
							changedFileCount: msg.changedFileCount,
							changedFiles: msg.changedFiles,
							reverted: false,
							afterMessageId: lastMsg.id,
						},
					];
					saveStoredCheckpoints(paneId, updated);
					return updated;
				});
			} else if (msg.type === "checkpoint:reverted") {
				setCheckpoints((prev) => {
					const updated = prev.map((checkpoint) =>
						checkpoint.id === msg.checkpointId
							? { ...checkpoint, reverted: true }
							: checkpoint
					);
					saveStoredCheckpoints(paneId, updated);
					return updated;
				});
				setMessages((prev) =>
					appendSystemMessage(
						prev,
						`Reverted ${msg.restoredFiles?.length ?? 0} file(s) to checkpoint`
					)
				);
			} else if (msg.type === "checkpoint:error") {
				setMessages((prev) =>
					appendSystemMessage(prev, `Revert failed: ${msg.error}`)
				);
			}
		});
		const reconnectChat = () => {
			wsClient.send({ type: "chat:reconnect", paneId });
		};
		reconnectChat();
		const cleanupReconnect = wsClient.onReconnect(reconnectChat);
		return () => {
			clearPendingContent();
			cleanupReconnect();
			cleanup();
		};
	}, [
		clearPendingContent,
		enabled,
		messagesRef,
		paneId,
		flushPendingContent,
		queueMessageContent,
		replaceQueuedMessages,
		resetStreamState,
		saveMessagesNow,
		setChatUiState,
		setLoadingState,
		setMessages,
	]);

	return { checkpoints, clearCheckpoints, resetStreamState, revertCheckpoint };
}
