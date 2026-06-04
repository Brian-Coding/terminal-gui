import * as stylex from "@stylexjs/stylex";
import type React from "react";
import {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { getAgentIcon } from "../../features/agents/agent-ui.tsx";
import {
	CODEX_REASONING_LEVELS,
	getAgentDefinition,
	loadDefaultChatSettings,
} from "../../features/agents/agents.ts";
import type {
	AttachedImageInfo,
	ChatLoadingState,
	ChatMessage,
	ChatUiState,
	QueuedMessageInfo,
	ToolActivity,
} from "../../features/chat/agent-chat-shared.ts";
import { trimMessages } from "../../features/chat/agent-chat-shared.ts";
import {
	clearStoredSessionId,
	deriveStoredSummary,
	loadPendingWorkspacePaths,
	loadStoredInput,
	loadStoredMessages,
	loadStoredModel,
	loadStoredReasoningLevel,
	savePendingWorkspacePaths,
	saveStoredInput,
	saveStoredMessages,
	saveStoredModel,
	saveStoredReasoningLevel,
} from "../../features/chat/chat-session-store.ts";
import { useGitStatus } from "../../features/git/useGitStatus.ts";
import {
	type AgentKind,
	changePaneAgentKind,
	dispatchTerminalShellChange,
} from "../../features/terminal/terminal-utils.ts";
import { hasId } from "../../lib/data.ts";
import { measureTextareaHeight } from "../../lib/pretext-utils.ts";
import { listenWindowEvent } from "../../lib/react-events.ts";
import { wsClient } from "../../lib/websocket.ts";
import { InlineDirectoryPicker } from "../../pages/Terminal/InlineDirectoryPicker.tsx";
import { color, controlSize, effectValues } from "../../tokens.stylex.ts";
import { IconArrowDown } from "../ui/Icons.tsx";
import { AgentChatHeader, type AgentChatSession } from "./AgentChatHeader.tsx";
import { AgentChatStatusBar } from "./AgentChatStatusBar.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import {
	ChatMessageList,
	type ChatVirtualizerControls,
} from "./ChatMessageList.tsx";
import { extractToolActivities } from "./chat-agent-utils.ts";
import {
	appendSystemMessage,
	dedupeChatMessagesById,
} from "./chat-state-utils.ts";
import { useAgentChatComposerState } from "./useAgentChatComposerState.ts";
import { useAgentChatMenus } from "./useAgentChatMenus.ts";
import { useChatConnection } from "./useChatConnection.ts";
import { useChatInputActions } from "./useChatInputActions.ts";
import { useSpeechToText } from "./useSpeechToText.ts";

export interface AgentChatHandle {
	sendMessage: (text: string) => void;
	sendMessageWithImages: (text: string, images?: string[]) => void;
	getStatus: () => string;
	focusInput: (atEnd?: boolean) => void;
	getToolActivities: () => ToolActivity[];
	getQueuedCount: () => number;
	getQueuedMessages: () => QueuedMessageInfo[];
	removeQueuedMessage: (id: string) => void;
	updateQueuedMessage: (id: string, text: string) => void;
	stopGeneration: () => void;
	isLoading: () => boolean;
	getAttachedImages: () => AttachedImageInfo[];
	attachImageFile: (file: File) => Promise<void>;
	removeAttachedImage: (path: string) => void;
}

const MESSAGE_SAVE_INTERVAL_MS = 1000;
const EMPTY_CWD_LIST: string[] = [];

function loadDurableChatMessages(paneId: string) {
	return dedupeChatMessagesById(
		loadStoredMessages<ChatMessage>(paneId).map((message) => ({
			...message,
			isStreaming: false,
		}))
	);
}

function prepareMessagesForStorage(messages: ChatMessage[]) {
	return trimMessages(dedupeChatMessagesById(messages)).map((message) =>
		message.isStreaming ? { ...message, isStreaming: false } : message
	);
}

function usePersistentChatMessages(paneId: string, enabled = true) {
	const [messages, setMessagesRaw] = useState<ChatMessage[]>(() =>
		enabled ? loadDurableChatMessages(paneId) : []
	);
	const loadedPaneRef = useRef<string | null>(enabled ? paneId : null);
	const messagesRef = useRef(messages);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingMessageSaveRef = useRef<ChatMessage[] | null>(null);
	const summaryRef = useRef<string | null>(null);
	messagesRef.current = messages;

	const saveMessagesNow = useCallback(
		(nextMessages: ChatMessage[]) => {
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
			}
			const storedMessages = prepareMessagesForStorage(nextMessages);
			saveStoredMessages(paneId, storedMessages);
			pendingMessageSaveRef.current = null;
			return storedMessages;
		},
		[paneId]
	);
	const flushPendingMessageSave = useCallback(() => {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		if (pendingMessageSaveRef.current) {
			saveStoredMessages(
				paneId,
				prepareMessagesForStorage(pendingMessageSaveRef.current)
			);
			pendingMessageSaveRef.current = null;
		}
	}, [paneId]);
	const scheduleMessageSave = useCallback(
		(nextMessages: ChatMessage[]) => {
			pendingMessageSaveRef.current = nextMessages;
			summaryRef.current ??= deriveStoredSummary(paneId, nextMessages, () =>
				dispatchTerminalShellChange({
					source: "cache",
					reason: "session-title",
				})
			);
			if (saveTimerRef.current) return;
			saveTimerRef.current = setTimeout(() => {
				flushPendingMessageSave();
			}, MESSAGE_SAVE_INTERVAL_MS);
		},
		[flushPendingMessageSave, paneId]
	);
	const setMessages = useCallback(
		(update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
			setMessagesRaw((prev) => {
				const next =
					typeof update === "function"
						? (update as (prev: ChatMessage[]) => ChatMessage[])(prev)
						: update;
				const deduped = dedupeChatMessagesById(next);
				if (deduped === prev) return prev;
				messagesRef.current = deduped;
				scheduleMessageSave(deduped);
				return deduped;
			});
		},
		[scheduleMessageSave]
	);

	useEffect(() => {
		if (!enabled || loadedPaneRef.current === paneId) return;
		const nextMessages = loadDurableChatMessages(paneId);
		loadedPaneRef.current = paneId;
		messagesRef.current = nextMessages;
		setMessagesRaw(nextMessages);
	}, [enabled, paneId]);
	useEffect(() => () => flushPendingMessageSave(), [flushPendingMessageSave]);
	useEffect(() => {
		if (!enabled) {
			flushPendingMessageSave();
			return;
		}
		const flushCurrentMessages = () => {
			saveMessagesNow(messagesRef.current);
		};
		window.addEventListener("beforeunload", flushCurrentMessages);
		window.addEventListener("pagehide", flushCurrentMessages);
		return () => {
			window.removeEventListener("beforeunload", flushCurrentMessages);
			window.removeEventListener("pagehide", flushCurrentMessages);
		};
	}, [enabled, flushPendingMessageSave, saveMessagesNow]);

	return { messages, messagesRef, saveMessagesNow, setMessages };
}

function useAgentChatSettings(paneId: string, agentKind: AgentKind) {
	const getDefaultModel = useCallback((kind: AgentKind) => {
		const definition = getAgentDefinition(kind);
		const defaults = loadDefaultChatSettings();
		return kind === defaults.agentKind &&
			definition.models.some(hasId.bind(null, defaults.model))
			? defaults.model
			: definition.defaultModel;
	}, []);
	const [selectedModel, setSelectedModel] = useState(() => {
		const stored = loadStoredModel(paneId);
		const definition = getAgentDefinition(agentKind);
		const defaults = loadDefaultChatSettings();
		return definition.models.some(hasId.bind(null, stored))
			? stored!
			: agentKind === defaults.agentKind &&
				  definition.models.some(hasId.bind(null, defaults.model))
				? defaults.model
				: definition.defaultModel;
	});
	const [selectedReasoningLevel, setSelectedReasoningLevel] = useState(() => {
		const stored = loadStoredReasoningLevel(paneId);
		const defaults = loadDefaultChatSettings();
		return CODEX_REASONING_LEVELS.some(hasId.bind(null, stored))
			? stored!
			: defaults.reasoningLevel;
	});
	const agentDefinition = useMemo(
		() => getAgentDefinition(agentKind),
		[agentKind]
	);
	const effectiveSelectedModel = agentDefinition.models.some(
		hasId.bind(null, selectedModel)
	)
		? selectedModel
		: getDefaultModel(agentKind);
	const agentKindOptions = useMemo(
		() => [
			{
				id: "claude" as const,
				label: "Claude",
				icon: getAgentIcon("claude", 11),
			},
			{ id: "codex" as const, label: "Codex", icon: getAgentIcon("codex", 11) },
		],
		[]
	);
	const prevAgentKindRef = useRef(agentKind);

	useEffect(() => {
		if (prevAgentKindRef.current === agentKind) return;
		prevAgentKindRef.current = agentKind;
		clearStoredSessionId(paneId);
	}, [agentKind, paneId]);

	const handleAgentKindChange = useCallback(
		(nextAgentKind: AgentKind) => {
			changePaneAgentKind(paneId, nextAgentKind);
			clearStoredSessionId(paneId);
			const nextModel = getDefaultModel(nextAgentKind);
			if (!nextModel) return;
			setSelectedModel(nextModel);
			saveStoredModel(paneId, nextModel);
		},
		[getDefaultModel, paneId]
	);
	const handleModelChange = useCallback(
		(model: string) => {
			setSelectedModel(model);
			saveStoredModel(paneId, model);
			clearStoredSessionId(paneId);
		},
		[paneId]
	);
	const handleReasoningLevelChange = useCallback(
		(reasoningLevel: string) => {
			setSelectedReasoningLevel(reasoningLevel);
			saveStoredReasoningLevel(paneId, reasoningLevel);
			clearStoredSessionId(paneId);
		},
		[paneId]
	);

	return {
		agentKindOptions,
		effectiveSelectedModel,
		handleAgentKindChange,
		handleModelChange,
		handleReasoningLevelChange,
		selectedReasoningLevel,
	};
}

function useChatViewport(
	input: string,
	isSelected?: boolean,
	isVisible = true
) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const chatVirtualizerRef = useRef<ChatVirtualizerControls | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const highlightOverlayRef = useRef<HTMLDivElement>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		setIsAtBottom(
			chatVirtualizerRef.current?.isAtEnd() ??
				el.scrollHeight - el.scrollTop - el.clientHeight < 48
		);
	}, []);
	const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
		const el = scrollRef.current;
		if (!el) return;
		if (chatVirtualizerRef.current) {
			chatVirtualizerRef.current.scrollToEnd(behavior);
		} else {
			el.scrollTo({ top: el.scrollHeight, behavior });
		}
		setIsAtBottom(true);
	}, []);
	const scheduleScrollToBottom = useCallback(
		(behavior: ScrollBehavior = "auto") => {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => scrollToBottom(behavior));
			});
		},
		[scrollToBottom]
	);
	const handleVirtualizerReady = useCallback(
		(controls: ChatVirtualizerControls | null) => {
			chatVirtualizerRef.current = controls;
			if (controls) setIsAtBottom(controls.isAtEnd());
		},
		[]
	);
	useEffect(() => {
		if (!isSelected || !isVisible) return;
		requestAnimationFrame(() => textareaRef.current?.focus());
	}, [isSelected, isVisible]);
	useEffect(() => {
		if (!isVisible) return;
		const ta = textareaRef.current;
		if (!ta) return;
		const width = ta.clientWidth - 32;
		if (width > 0 && input) {
			const measured =
				input.length > 6000
					? 120
					: measureTextareaHeight(
							input,
							width,
							"13px Geist, -apple-system, system-ui, sans-serif",
							20
						);
			ta.style.height = `${Math.min(Math.max(measured, 20), 120)}px`;
		} else {
			ta.style.height = "20px";
		}
		if (highlightOverlayRef.current) {
			highlightOverlayRef.current.style.transform = `translateY(-${ta.scrollTop}px)`;
		}
	}, [input, isVisible]);
	useEffect(() => {
		if (!isSelected || !isVisible) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "ArrowDown") return;
			const active = document.activeElement;
			if (
				active &&
				(active.tagName === "TEXTAREA" || active.tagName === "INPUT")
			)
				return;
			if (!isAtBottom) {
				e.preventDefault();
				scrollToBottom();
			}
		};
		return listenWindowEvent("keydown", onKeyDown);
	}, [isAtBottom, isSelected, isVisible, scrollToBottom]);

	return {
		handleScroll,
		handleVirtualizerReady,
		highlightOverlayRef,
		isAtBottom,
		scheduleScrollToBottom,
		scrollRef,
		scrollToBottom,
		textareaRef,
	};
}

function useChatUiState(
	paneId: string,
	onStatusChange?: (paneId: string, status: string) => void
) {
	const [chatUiState, setChatUiState] = useState<ChatUiState>(() => ({
		isLoading: false,
		status: "idle",
		startTime: null,
		expandedTools: new Set(),
		liveActivities: [],
	}));
	const chatUiStateRef = useRef(chatUiState);
	chatUiStateRef.current = chatUiState;
	const setLoadingState = useCallback(
		(
			value: ChatLoadingState | ((prev: ChatLoadingState) => ChatLoadingState)
		) => {
			const prev = chatUiStateRef.current;
			const patch = typeof value === "function" ? value(prev) : value;
			const next = { ...prev, ...patch };
			if (
				prev.isLoading === next.isLoading &&
				prev.status === next.status &&
				prev.startTime === next.startTime &&
				prev.expandedTools === next.expandedTools &&
				prev.liveActivities === next.liveActivities
			) {
				return;
			}
			chatUiStateRef.current = next;
			setChatUiState(next);
			if (prev.status !== next.status) onStatusChange?.(paneId, next.status);
		},
		[onStatusChange, paneId]
	);
	const setExpandedTools = useCallback(
		(value: Set<string> | ((prev: Set<string>) => Set<string>)) => {
			setChatUiState((prev) => {
				const expandedTools =
					typeof value === "function" ? value(prev.expandedTools) : value;
				if (prev.expandedTools === expandedTools) return prev;
				const next = { ...prev, expandedTools };
				chatUiStateRef.current = next;
				return next;
			});
		},
		[]
	);

	return {
		chatUiState,
		chatUiStateRef,
		setChatUiState,
		setExpandedTools,
		setLoadingState,
	};
}

function usePendingChatWorkspace(
	paneId: string,
	cwd: string | undefined,
	onDirectoryChange:
		| ((paneId: string, cwd: string, referencePaths?: string[]) => void)
		| undefined
) {
	const pendingWorkspacePathsRef = useRef<string[]>([]);
	const [pendingWorkspacePaths, setPendingWorkspacePaths] = useState(() =>
		loadPendingWorkspacePaths(paneId).filter(Boolean)
	);
	const visibleCwd = cwd ?? pendingWorkspacePaths[0];
	const cwdList = useMemo(() => (visibleCwd ? [visibleCwd] : []), [visibleCwd]);
	const clearPendingWorkspacePaths = useCallback(() => {
		pendingWorkspacePathsRef.current = [];
		setPendingWorkspacePaths([]);
		savePendingWorkspacePaths(paneId, []);
	}, [paneId]);
	const consumePendingWorkspace = useCallback(() => {
		const paths = (
			pendingWorkspacePathsRef.current.length > 0
				? pendingWorkspacePathsRef.current
				: loadPendingWorkspacePaths(paneId)
		).filter(Boolean);
		const selectedWorkspace =
			!cwd && paths.length > 0
				? { cwd: paths[0], referencePaths: paths.slice(1) }
				: undefined;
		if (selectedWorkspace?.cwd) {
			onDirectoryChange?.(
				paneId,
				selectedWorkspace.cwd,
				selectedWorkspace.referencePaths
			);
			clearPendingWorkspacePaths();
		}
		return selectedWorkspace;
	}, [clearPendingWorkspacePaths, cwd, onDirectoryChange, paneId]);
	const savePendingWorkspaceSelection = useCallback(
		(paths: string[]) => {
			const nextPaths = paths.filter(Boolean);
			pendingWorkspacePathsRef.current = nextPaths;
			setPendingWorkspacePaths(nextPaths);
			savePendingWorkspacePaths(paneId, nextPaths);
		},
		[paneId]
	);

	return {
		consumePendingWorkspace,
		cwdList,
		savePendingWorkspaceSelection,
		visibleCwd,
	};
}

interface AgentChatViewProps {
	paneId: string;
	cwd?: string;
	referencePaths?: string[];
	gitBranch?: string | null;
	showInput?: boolean;
	agentKind?: AgentKind;
	onStatusChange?: (paneId: string, status: string) => void;
	hideHeader?: boolean;
	onClose?: (paneId: string) => void;
	isSelected?: boolean;
	isVisible?: boolean;
	draggable?: boolean;
	onDragStart?: (e: React.DragEvent) => void;
	onDragEnd?: () => void;
	sessions?: AgentChatSession[];
	onSelectSession?: (paneId: string) => void;
	composerOnly?: boolean;
	composerOnlyOffsetX?: number;
	onExitComposerOnly?: () => void;
	/** Called when user picks directories from empty state picker */
	onDirectoryChange?: (
		paneId: string,
		cwd: string,
		referencePaths?: string[]
	) => void;
	onDirectoryCancel?: (paneId: string) => void;
	/** Called when user wants to add a new pane of a specific agent kind */
	onAddPane?: (agentKind: AgentKind) => void;
}

export const AgentChatView = memo(
	forwardRef<AgentChatHandle, AgentChatViewProps>(function AgentChatView(
		{
			paneId,
			cwd,
			referencePaths,
			gitBranch: providedGitBranch,
			showInput = true,
			agentKind = loadDefaultChatSettings().agentKind,
			onStatusChange,
			hideHeader,
			onClose,
			isSelected,
			isVisible = true,
			draggable,
			onDragStart,
			onDragEnd,
			sessions,
			onSelectSession,
			composerOnly = false,
			composerOnlyOffsetX = 0,
			onExitComposerOnly,
			onDirectoryChange,
			onDirectoryCancel,
		},
		ref
	) {
		const renderVisibleChat = composerOnly || isVisible;
		const { messages, messagesRef, saveMessagesNow, setMessages } =
			usePersistentChatMessages(paneId, renderVisibleChat);
		const {
			agentKindOptions,
			effectiveSelectedModel,
			handleAgentKindChange,
			handleModelChange,
			handleReasoningLevelChange,
			selectedReasoningLevel,
		} = useAgentChatSettings(paneId, agentKind);
		const {
			consumePendingWorkspace,
			cwdList,
			savePendingWorkspaceSelection,
			visibleCwd,
		} = usePendingChatWorkspace(paneId, cwd, onDirectoryChange);
		const [input, setInputRaw] = useState(() => loadStoredInput(paneId));
		const pendingInputRef = useRef(input);
		const inputSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
			null
		);
		const flushInputSave = useCallback(() => {
			if (inputSaveTimerRef.current) {
				clearTimeout(inputSaveTimerRef.current);
				inputSaveTimerRef.current = null;
			}
			saveStoredInput(paneId, pendingInputRef.current);
		}, [paneId]);
		const setInput = useCallback(
			(val: string) => {
				setInputRaw(val);
				pendingInputRef.current = val;
				if (inputSaveTimerRef.current) return;
				inputSaveTimerRef.current = setTimeout(flushInputSave, 250);
			},
			[flushInputSave]
		);
		useEffect(() => () => flushInputSave(), [flushInputSave]);
		const {
			cancelListening: cancelSpeechListening,
			error: speechError,
			isListening: isSpeechListening,
			isSupported: isSpeechSupported,
			toggleListening: toggleSpeechListening,
		} = useSpeechToText({
			enabled: renderVisibleChat && showInput,
			value: input,
			onChange: setInput,
		});
		const shouldLoadGitBranch =
			providedGitBranch === undefined && renderVisibleChat;
		const { projects: gitProjects } = useGitStatus(
			shouldLoadGitBranch ? cwdList : EMPTY_CWD_LIST,
			{ enabled: shouldLoadGitBranch && cwdList.length > 0 }
		);
		const gitBranch = providedGitBranch ?? gitProjects[0]?.branch ?? null;

		const {
			chatUiState,
			chatUiStateRef,
			setChatUiState,
			setExpandedTools,
			setLoadingState,
		} = useChatUiState(paneId, onStatusChange);
		const { isLoading, status, startTime, expandedTools, liveActivities } =
			chatUiState;
		const inputContainerRef = useRef<HTMLDivElement>(null);
		const containerRef = useRef<HTMLDivElement>(null);
		const {
			handleScroll,
			handleVirtualizerReady,
			isAtBottom,
			highlightOverlayRef,
			scheduleScrollToBottom,
			scrollRef,
			scrollToBottom,
			textareaRef,
		} = useChatViewport(input, isSelected, renderVisibleChat);
		const {
			setIsDragOver,
			attachedImages,
			queuedMessages,
			queueMessage,
			shiftQueuedMessage,
			removeQueuedMessage,
			updateQueuedMessage,
			editingQueueId,
			editingQueueText,
			setEditingQueueText,
			startQueuedMessageEdit,
			cancelQueuedMessageEdit,
			saveQueuedMessageEdit,
			mdPreview,
			setMdPreview,
			handleMdFileClick,
			attachImage,
			removeAttachedImage,
			clearAttachedImages,
			handleDrop,
			handlePaste,
		} = useAgentChatComposerState(paneId, renderVisibleChat);
		const {
			allCommands,
			fileMenu,
			setFileMenu,
			fileResults,
			slashMenu,
			setSlashMenu,
			filteredCommands,
			showCommands,
			incrementUsage,
			slashCommandNames,
			handleInputForFileMenu,
			handleInputForSlashMenu,
			selectCommand,
			selectFile,
		} = useAgentChatMenus({
			agentKind,
			cwd,
			enabled: renderVisibleChat,
			input,
			setInput,
			textareaRef,
			inputContainerRef,
			containerRef,
		});
		const sendNextQueuedMessageRef = useRef<() => void>(() => {});
		const {
			checkpoints,
			clearCheckpoints,
			resetStreamState,
			revertCheckpoint,
		} = useChatConnection({
			chatUiStateRef,
			enabled: renderVisibleChat,
			messagesRef,
			paneId,
			saveMessagesNow,
			sendNextQueuedMessage: () => sendNextQueuedMessageRef.current(),
			setChatUiState,
			setLoadingState,
			setMessages,
		});
		const { handleKeyDown, sendNextQueuedMessage, sendUserMessage } =
			useChatInputActions({
				agentKind,
				allCommands,
				attachedImages,
				cancelSpeechListening,
				clearAttachedImages,
				clearCheckpoints,
				composerOnly,
				consumePendingWorkspace,
				cwd,
				effectiveSelectedModel,
				enabled: renderVisibleChat,
				fileMenu,
				fileResults,
				filteredCommands,
				incrementUsage,
				input,
				isLoading,
				onSendStart: () => {
					resetStreamState();
					scheduleScrollToBottom("auto");
				},
				onExitComposerOnly,
				paneId,
				queueMessage,
				referencePaths,
				selectCommand,
				selectFile,
				selectedReasoningLevel,
				setFileMenu,
				setInput,
				setLoadingState,
				setMessages,
				setSlashMenu,
				showCommands,
				slashMenu,
				shiftQueuedMessage,
				textareaRef,
			});
		sendNextQueuedMessageRef.current = sendNextQueuedMessage;
		const handleSendMessage = useCallback(
			(text: string) =>
				sendUserMessage({ text, workspaceOverride: consumePendingWorkspace() }),
			[consumePendingWorkspace, sendUserMessage]
		);
		const stopGeneration = useCallback(() => {
			wsClient.send({ type: "chat:stop", paneId });
			setLoadingState({ isLoading: false, status: "idle", startTime: null });
			setMessages((prev) => appendSystemMessage(prev, "Generation stopped"));
		}, [paneId, setLoadingState, setMessages]);
		useImperativeHandle(
			ref,
			() => ({
				sendMessage: (text: string) => {
					const trimmed = text.trim();
					if (!trimmed) return;
					sendUserMessage({ text: trimmed });
				},
				sendMessageWithImages: (text: string, images?: string[]) => {
					const trimmed = text.trim();
					if (!trimmed) return;
					sendUserMessage({ images, text: trimmed });
				},
				getStatus: () => status,
				focusInput: (atEnd?: boolean) => {
					const ta = textareaRef.current;
					if (!ta) return;
					ta.focus();
					if (atEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
				},
				getToolActivities: () => extractToolActivities(messagesRef.current),
				getQueuedCount: () => queuedMessages.length,
				getQueuedMessages: () =>
					queuedMessages.map((queued) => ({
						id: queued.id,
						text: queued.text,
						displayText: queued.displayText,
						images: queued.images,
					})),
				removeQueuedMessage,
				updateQueuedMessage,
				stopGeneration,
				isLoading: () => isLoading,
				getAttachedImages: () => [...attachedImages],
				attachImageFile: attachImage,
				removeAttachedImage,
			}),
			[
				attachImage,
				attachedImages,
				isLoading,
				messagesRef,
				queuedMessages,
				removeAttachedImage,
				removeQueuedMessage,
				sendUserMessage,
				status,
				stopGeneration,
				textareaRef,
				updateQueuedMessage,
			]
		);

		const toggleTool = useCallback(
			(id: string) => {
				setExpandedTools((prev) => {
					const next = new Set(prev);
					next.has(id) ? next.delete(id) : next.add(id);
					return next;
				});
			},
			[setExpandedTools]
		);
		const voiceInput = useMemo(
			() => ({
				error: speechError,
				isListening: isSpeechListening,
				isSupported: isSpeechSupported,
				onToggleListening: toggleSpeechListening,
			}),
			[isSpeechListening, isSpeechSupported, speechError, toggleSpeechListening]
		);

		return (
			<div
				ref={containerRef}
				{...stylex.props(styles.root, composerOnly && styles.composerOnlyRoot)}
				style={
					composerOnly
						? {
								left: `calc(50% + ${composerOnlyOffsetX}px)`,
							}
						: undefined
				}
				onDragOver={(e) => {
					e.preventDefault();
					setIsDragOver(true);
				}}
				onDragLeave={() => setIsDragOver(false)}
				onDrop={handleDrop}
			>
				{renderVisibleChat && !hideHeader && !composerOnly && (
					<AgentChatHeader
						paneId={paneId}
						cwd={visibleCwd}
						gitBranch={gitBranch}
						draggable={draggable}
						onDragStart={onDragStart}
						onDragEnd={onDragEnd}
						onClose={onClose}
						sessions={sessions}
						onSelectSession={onSelectSession}
					/>
				)}
				{renderVisibleChat && !composerOnly && (
					<div {...stylex.props(styles.messageRegion)}>
						<div
							ref={scrollRef}
							{...stylex.props(styles.scrollArea)}
							onScroll={handleScroll}
						>
							{messages.length === 0 &&
								!isLoading &&
								!cwd &&
								onDirectoryChange && (
									<div {...stylex.props(styles.directoryPickerWrap)}>
										<div {...stylex.props(styles.directoryPickerInner)}>
											<InlineDirectoryPicker
												onSelect={(path) => {
													if (path) onDirectoryChange(paneId, path);
													else onDirectoryCancel?.(paneId);
												}}
												onCancel={onDirectoryCancel?.bind(null, paneId)}
												multiSelect
												showStartButton={false}
												onSelectionChange={(paths) => {
													savePendingWorkspaceSelection(paths);
												}}
												onMultiSelect={(paths) => {
													if (paths.length > 0) {
														onDirectoryChange(
															paneId,
															paths[0]!,
															paths.slice(1)
														);
													}
												}}
											/>
										</div>
									</div>
								)}
							<ChatMessageList
								messages={messages}
								scrollElementRef={scrollRef}
								onVirtualizerReady={handleVirtualizerReady}
								expandedTools={expandedTools}
								toggleTool={toggleTool}
								checkpoints={checkpoints}
								revertCheckpoint={revertCheckpoint}
								isLoading={isLoading}
								startTime={startTime}
								handleSendMessage={handleSendMessage}
								onMdFileClick={handleMdFileClick}
								slashCommandNames={slashCommandNames}
							/>
						</div>
						{!isAtBottom && (
							<button
								type="button"
								onClick={() => scrollToBottom()}
								{...stylex.props(styles.scrollButton)}
							>
								<IconArrowDown size={12} {...stylex.props(styles.scrollIcon)} />
							</button>
						)}
					</div>
				)}

				{renderVisibleChat && (
					<div {...stylex.props(styles.composerRegion)}>
						{!composerOnly && (
							<>
								<div
									{...stylex.props(styles.composerBackdrop)}
									style={{ backgroundImage: effectValues.composerBackdrop }}
								/>
								<div
									{...stylex.props(styles.composerFade)}
									style={{ backgroundImage: effectValues.composerFade }}
								/>
							</>
						)}
						<div {...stylex.props(styles.composerContent)}>
							<AgentChatStatusBar
								liveActivities={liveActivities}
								isLoading={isLoading}
								status={status}
								onStop={stopGeneration}
							/>
							<ChatComposer
								showInput={showInput}
								agentKind={agentKind}
								agentKindOptions={agentKindOptions}
								model={effectiveSelectedModel}
								reasoningLevel={selectedReasoningLevel}
								onAgentKindChange={handleAgentKindChange}
								onModelChange={handleModelChange}
								onReasoningLevelChange={handleReasoningLevelChange}
								input={input}
								setInput={setInput}
								isLoading={isLoading}
								attachedImages={attachedImages}
								removeAttachedImage={removeAttachedImage}
								attachImage={attachImage}
								queuedMessages={queuedMessages}
								editingQueueId={editingQueueId}
								editingQueueText={editingQueueText}
								setEditingQueueText={setEditingQueueText}
								startQueuedMessageEdit={startQueuedMessageEdit}
								cancelQueuedMessageEdit={cancelQueuedMessageEdit}
								saveQueuedMessageEdit={saveQueuedMessageEdit}
								removeQueuedMessage={removeQueuedMessage}
								fileMenu={fileMenu}
								setFileMenu={setFileMenu}
								fileResults={fileResults}
								selectFile={selectFile}
								slashMenu={slashMenu}
								setSlashMenu={setSlashMenu}
								showCommands={showCommands}
								filteredCommands={filteredCommands}
								slashCommandNames={slashCommandNames}
								selectCommand={selectCommand}
								handleInputForFileMenu={handleInputForFileMenu}
								handleInputForSlashMenu={handleInputForSlashMenu}
								handleKeyDown={handleKeyDown}
								handlePaste={handlePaste}
								textareaRef={textareaRef}
								highlightOverlayRef={highlightOverlayRef}
								inputContainerRef={inputContainerRef}
								mdPreview={mdPreview}
								setMdPreview={setMdPreview}
								onMdFileClick={handleMdFileClick}
								voiceInput={voiceInput}
							/>
						</div>
					</div>
				)}
			</div>
		);
	})
);

const styles = stylex.create({
	root: {
		display: "flex",
		height: "100%",
		flexDirection: "column",
		transitionProperty: "box-shadow",
		transitionDuration: "120ms",
	},
	composerOnlyRoot: {
		position: "absolute",
		zIndex: 50,
		left: "50%",
		bottom: controlSize._6,
		width: "min(36rem, calc(100% - 2rem))",
		height: "auto",
		transform: "translateX(-50%)",
	},
	messageRegion: {
		position: "relative",
		flex: 1,
		overflow: "hidden",
	},
	scrollArea: {
		height: "100%",
		overflowX: "hidden",
		overflowY: "auto",
		overscrollBehavior: "contain",
		scrollbarWidth: "none",
		"::-webkit-scrollbar": {
			display: "none",
		},
	},
	directoryPickerWrap: {
		position: "absolute",
		zIndex: 10,
		left: 0,
		right: 0,
		bottom: 0,
		pointerEvents: "none",
		paddingInline: controlSize._3,
		paddingBottom: controlSize._2,
	},
	directoryPickerInner: {
		maxWidth: "42rem",
		marginInline: "auto",
		pointerEvents: "auto",
	},
	scrollButton: {
		position: "absolute",
		zIndex: 10,
		right: controlSize._2,
		bottom: controlSize._2,
		display: "flex",
		width: controlSize._6,
		height: controlSize._6,
		alignItems: "center",
		justifyContent: "center",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.border,
		borderRadius: "999px",
		backgroundColor: {
			default: color.backgroundRaised,
			":hover": color.controlHover,
		},
		boxShadow: "0 1px 2px rgba(0, 0, 0, 0.24)",
		transitionProperty: "background-color, opacity",
		transitionDuration: "120ms",
	},
	scrollIcon: {
		color: color.textSoft,
	},
	composerRegion: {
		position: "relative",
		flexShrink: 0,
	},
	composerBackdrop: {
		position: "absolute",
		pointerEvents: "none",
		left: 0,
		right: 0,
		bottom: 0,
		top: "-36px",
	},
	composerFade: {
		position: "absolute",
		pointerEvents: "none",
		left: 0,
		right: 0,
		bottom: "100%",
		height: "36px",
	},
	composerContent: {
		position: "relative",
		zIndex: 10,
	},
});
