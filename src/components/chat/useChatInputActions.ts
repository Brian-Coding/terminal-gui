import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import {
	appendTrimmedMessage,
	type ChatLoadingState,
	type ChatMessage,
	nextId,
	type QueuedMessageInfo,
	type SlashCommand,
	trimMessages,
} from "../../features/chat/agent-chat-shared.ts";
import {
	clearAgentChatPaneState,
	clearPendingSend,
	loadPendingSend,
	loadStoredSessionId,
} from "../../features/chat/chat-session-store.ts";
import type { AgentKind } from "../../features/terminal/terminal-utils.ts";
import { noop } from "../../lib/data.ts";
import { wsClient } from "../../lib/websocket.ts";
import { hideMenuState } from "./chat-agent-utils.ts";
import {
	expandInlineCommandPrompts,
	getCommandDisplayText,
	getCommandPrompt,
} from "./chat-command-utils.ts";
import { appendSystemMessage } from "./chat-state-utils.ts";
import type {
	FileMenuState,
	FileSearchResult,
	SlashMenuState,
} from "./useAgentChatMenus.ts";

type MenuState = { show: boolean; selectedIdx: number };
type AttachedImage = { path: string };
type ChatWorkspaceOverride = { cwd?: string; referencePaths?: string[] };

function handleMenuKey<S extends MenuState>(
	e: React.KeyboardEvent,
	count: number,
	setMenu: React.Dispatch<React.SetStateAction<S>>,
	selectIdx: number,
	onSelect: (idx: number) => void
) {
	const delta = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
	if (delta) {
		e.preventDefault();
		setMenu((prev) => ({
			...prev,
			selectedIdx: (prev.selectedIdx + delta + count) % count,
		}));
		return true;
	}
	if (e.key !== "Tab" && (e.key !== "Enter" || e.shiftKey)) {
		if (e.key !== "Escape") return false;
		setMenu(hideMenuState);
	} else {
		onSelect(selectIdx);
	}
	e.preventDefault();
	return true;
}

export function useChatInputActions({
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
	enabled = true,
	fileMenu,
	fileResults,
	filteredCommands,
	incrementUsage,
	input,
	isLoading,
	onSendStart,
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
}: {
	agentKind: AgentKind;
	allCommands: SlashCommand[];
	attachedImages: AttachedImage[];
	cancelSpeechListening: () => void;
	clearAttachedImages: () => void;
	clearCheckpoints: () => void;
	composerOnly: boolean;
	consumePendingWorkspace: () => ChatWorkspaceOverride | undefined;
	cwd?: string;
	effectiveSelectedModel: string;
	enabled?: boolean;
	fileMenu: FileMenuState;
	fileResults: FileSearchResult[];
	filteredCommands: SlashCommand[];
	incrementUsage: (id: string) => Promise<unknown>;
	input: string;
	isLoading: boolean;
	onSendStart?: () => void;
	onExitComposerOnly?: () => void;
	paneId: string;
	queueMessage: (text: string, displayText: string, images?: string[]) => void;
	referencePaths?: string[];
	selectCommand: (idx: number) => void;
	selectFile: (idx: number) => void;
	selectedReasoningLevel: string;
	setFileMenu: React.Dispatch<React.SetStateAction<FileMenuState>>;
	setInput: (value: string) => void;
	setLoadingState: (
		state: ChatLoadingState | ((prev: ChatLoadingState) => ChatLoadingState)
	) => void;
	setMessages: (
		update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])
	) => void;
	setSlashMenu: React.Dispatch<React.SetStateAction<SlashMenuState>>;
	showCommands: boolean;
	slashMenu: SlashMenuState;
	shiftQueuedMessage: () => QueuedMessageInfo | null;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const pendingSendConsumedRef = useRef(false);
	const latestRef = useRef({
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
		fileMenu,
		fileResults,
		filteredCommands,
		incrementUsage,
		input,
		isLoading,
		onSendStart,
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
	latestRef.current = {
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
		fileMenu,
		fileResults,
		filteredCommands,
		incrementUsage,
		input,
		isLoading,
		onSendStart,
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
	};

	const appendLocalMessage = useCallback(
		(message: Pick<ChatMessage, "role" | "content" | "images">) => {
			latestRef.current.setMessages((prev) =>
				trimMessages([
					...prev,
					{
						id: nextId(),
						role: message.role,
						content: message.content,
						images: message.images,
					},
				])
			);
		},
		[]
	);

	const sendToServer = useCallback(
		(text: string, workspaceOverride?: ChatWorkspaceOverride) => {
			const latest = latestRef.current;
			latest.onSendStart?.();
			latest.setLoadingState({
				isLoading: true,
				status: "thinking",
				startTime: Date.now(),
			});

			wsClient.send({
				type: "chat:send",
				paneId: latest.paneId,
				text,
				cwd: workspaceOverride?.cwd ?? latest.cwd,
				referencePaths:
					workspaceOverride?.referencePaths ?? latest.referencePaths,
				sessionId: loadStoredSessionId(latest.paneId),
				agentKind: latest.agentKind,
				model: latest.effectiveSelectedModel,
				reasoningLevel:
					latest.agentKind === "codex"
						? latest.selectedReasoningLevel
						: undefined,
			});
		},
		[]
	);

	const sendToServerRef = useRef<(text: string) => void>(sendToServer);
	sendToServerRef.current = sendToServer;

	const sendUserMessage = useCallback(
		({
			displayText,
			images,
			systemMessage,
			text,
			workspaceOverride,
		}: {
			displayText?: string;
			images?: string[];
			systemMessage?: string;
			text: string;
			workspaceOverride?: ChatWorkspaceOverride;
		}) => {
			const latest = latestRef.current;
			const trimmed = text.trim();
			if (!trimmed) return;
			const visibleText = displayText ?? trimmed;
			if (latest.isLoading) {
				latest.queueMessage(trimmed, visibleText, images);
				return;
			}
			appendLocalMessage({ role: "user", content: visibleText, images });
			if (systemMessage)
				latest.setMessages((prev) => appendSystemMessage(prev, systemMessage));
			sendToServer(trimmed, workspaceOverride);
		},
		[appendLocalMessage, sendToServer]
	);

	const sendNextQueuedMessage = useCallback(() => {
		const next = latestRef.current.shiftQueuedMessage();
		if (!next) return;
		appendLocalMessage({
			role: "user",
			content: next.displayText,
			images: next.images,
		});
		sendToServer(next.text);
	}, [appendLocalMessage, sendToServer]);

	const executeCommand = useCallback(
		(cmd: SlashCommand, args?: string) => {
			const latest = latestRef.current;
			latest.setInput("");
			if (cmd.name === "btw") {
				const question = (args || "").trim();
				latest.setMessages(
					question
						? appendTrimmedMessage.bind(null, {
								id: nextId(),
								role: "user",
								content: `/btw ${question}`,
							})
						: (prev) => appendSystemMessage(prev, "Usage: /btw <question>")
				);
				if (question)
					wsClient.send({
						type: "chat:btw",
						paneId: latest.paneId,
						text: question,
						cwd: latest.cwd,
					});
				return;
			}

			if (cmd.action === "local") {
				if (cmd.name === "clear") {
					latest.setMessages([]);
					clearAgentChatPaneState(latest.paneId);
					latest.clearCheckpoints();
					latest.setMessages((prev) =>
						appendSystemMessage(prev, "Chat cleared")
					);
				} else if (cmd.name === "help") {
					latest.setMessages((prev) =>
						appendSystemMessage(
							prev,
							latest.allCommands
								.map((command) => `/${command.name} - ${command.description}`)
								.join("\n")
						)
					);
				}
				return;
			}

			const prompt = getCommandPrompt(cmd, args);
			const displayText = getCommandDisplayText(cmd, args);
			if (cmd.id) latest.incrementUsage(cmd.id).catch(noop);
			sendUserMessage({
				displayText,
				systemMessage: `Running /${cmd.name}...`,
				text: prompt,
			});
		},
		[sendUserMessage]
	);

	const sendMessage = useCallback(() => {
		const latest = latestRef.current;
		const rawInput = latest.textareaRef.current?.value ?? latest.input;
		const text = rawInput.trim();
		if (!text && latest.attachedImages.length === 0) return;
		latest.cancelSpeechListening();
		if (text.startsWith("/") && !text.includes(" ")) {
			const cmd = latest.allCommands.find(
				(command) => command.name.toLowerCase() === text.slice(1).toLowerCase()
			);
			if (cmd) {
				executeCommand(cmd);
				return;
			}
		}

		const imagePaths = latest.attachedImages.map((image) => image.path);
		const { expandedText, usedCommandIds } = expandInlineCommandPrompts(
			text,
			latest.allCommands
		);
		usedCommandIds.forEach((id) => {
			latest.incrementUsage(id).catch(noop);
		});
		const displayText =
			text || `Attached image${latest.attachedImages.length > 1 ? "s" : ""}`;
		const fullText =
			imagePaths.length > 0
				? `${expandedText}${expandedText ? "\n\n" : ""}Here are the images at these paths:\n${imagePaths.join("\n")}`
				: expandedText;

		latest.setInput("");
		latest.setSlashMenu(hideMenuState);
		latest.setFileMenu(hideMenuState);
		latest.clearAttachedImages();
		if (latest.textareaRef.current)
			latest.textareaRef.current.style.height = "20px";
		sendUserMessage({
			displayText,
			images: imagePaths.length > 0 ? imagePaths : undefined,
			text: fullText,
			workspaceOverride: latest.consumePendingWorkspace(),
		});
	}, [executeCommand, sendUserMessage]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const latest = latestRef.current;
			if (
				latest.fileMenu.show &&
				latest.fileResults.length > 0 &&
				handleMenuKey(
					e,
					latest.fileResults.length,
					latest.setFileMenu,
					latest.fileMenu.selectedIdx,
					latest.selectFile
				)
			)
				return;
			if (
				latest.showCommands &&
				latest.filteredCommands.length > 0 &&
				handleMenuKey(
					e,
					latest.filteredCommands.length,
					latest.setSlashMenu,
					latest.slashMenu.selectedIdx,
					latest.selectCommand
				)
			)
				return;
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			} else if (latest.composerOnly && e.key === "Escape") {
				e.preventDefault();
				latest.onExitComposerOnly?.();
			}
		},
		[sendMessage]
	);

	useEffect(() => {
		if (!enabled || pendingSendConsumedRef.current || isLoading) return;
		const pending = loadPendingSend(paneId).trim();
		if (!pending) return;
		pendingSendConsumedRef.current = true;
		clearPendingSend(paneId);
		setInput("");
		setMessages((prev) =>
			trimMessages([...prev, { id: nextId(), role: "user", content: pending }])
		);
		sendToServerRef.current(pending);
	}, [enabled, isLoading, paneId, setInput, setMessages]);

	return {
		handleKeyDown,
		sendNextQueuedMessage,
		sendUserMessage,
	};
}
