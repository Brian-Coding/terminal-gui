export interface QueuedMessageInfo {
	id: string;
	text: string;
	displayText: string;
	images?: string[];
}

export interface AttachedImageInfo {
	name: string;
	path: string;
	previewUrl: string;
}

export type ChatMessagePart =
	| { type: "text"; content: string }
	| { type: "thinking"; content: string }
	| {
			type: "tool";
			id: string;
			name: string;
			input?: unknown;
			output?: unknown;
			error?: string;
	  };

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "tool" | "system" | "btw";
	content: string;
	toolName?: string;
	parts?: ChatMessagePart[];
	isStreaming?: boolean;
	btwQuestion?: string;
	images?: string[];
}

export type ChatStreamEventBlock =
	| { type: "text"; text?: string }
	| { type: "tool_use"; name: string; input?: unknown };

export type ChatStreamEvent = (
	| {
			type: "assistant";
			message?: {
				content?: ChatStreamEventBlock[];
				stop_reason?: unknown;
			};
	  }
	| { type: "content_block_start"; content_block?: ChatStreamEventBlock }
	| {
			type: "content_block_delta";
			delta?: {
				type?: "text_delta" | "input_json_delta";
				text?: string;
				partial_json?: string;
			};
	  }
	| { type: "content_block_stop" }
	| { type: "result"; result?: string }
) & { session_id?: string };

export function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
	if (!value || typeof value !== "object") return false;
	const type = (value as { type?: unknown }).type;
	return (
		type === "assistant" ||
		type === "content_block_start" ||
		type === "content_block_delta" ||
		type === "content_block_stop" ||
		type === "result"
	);
}

export function stringifyToolInput(input: unknown): string {
	if (input === undefined || input === null) return "";
	return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

export function getToolBlockInitialContent(block: unknown): string {
	if (!block || typeof block !== "object") return "";
	const input = (block as { input?: unknown }).input;
	return stringifyToolInput(input);
}

export interface CheckpointInfo {
	id: string;
	timestamp: number;
	changedFileCount: number;
	changedFiles: { path: string; action: "created" | "modified" | "deleted" }[];
	reverted: boolean;
	afterMessageId: string | null;
}

export type ChatLoadingState = {
	isLoading: boolean;
	status: string;
	startTime: number | null;
};

export type ToolActivity = {
	id: string;
	toolName: string;
	isStreaming: boolean;
	summary: string;
};

export type ChatUiState = ChatLoadingState & {
	expandedTools: Set<string>;
	liveActivities: ToolActivity[];
};

export interface SlashCommand {
	id?: string;
	name: string;
	description: string;
	action: "local" | "send";
	promptTemplate?: string;
	category?: string;
	isLocalCommand?: boolean;
	isFromLibrary?: boolean;
}

export type ChatServerMessage = {
	paneId: string;
	type: string;
	[key: string]: any;
};

export function isChatServerMessage(
	value: unknown
): value is ChatServerMessage {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.paneId === "string" &&
		typeof message.type === "string" &&
		(message.type.startsWith("chat:") || message.type.startsWith("checkpoint:"))
	);
}

const CHAT_MESSAGE_RETAIN_LIMIT = 75;
const CHAT_MESSAGE_CHAR_LIMIT = 1_000_000;

let msgId = 0;

export function nextId() {
	return `c${++msgId}-${Date.now().toString(36)}`;
}

export function trimMessages<T extends { content: string }>(msgs: T[]): T[] {
	let trimmed =
		msgs.length > CHAT_MESSAGE_RETAIN_LIMIT
			? msgs.slice(-CHAT_MESSAGE_RETAIN_LIMIT)
			: msgs;
	let totalChars = trimmed.reduce(
		(sum, message) => sum + message.content.length,
		0
	);
	while (totalChars > CHAT_MESSAGE_CHAR_LIMIT && trimmed.length > 1) {
		totalChars -= trimmed[0]?.content.length ?? 0;
		trimmed = trimmed.slice(1);
	}

	return trimmed;
}

export function appendTrimmedMessage(
	msg: ChatMessage,
	msgs: ChatMessage[]
): ChatMessage[] {
	return trimMessages([...msgs, msg]);
}

export function prepareTranscriptForStorage<
	T extends { isStreaming?: boolean },
>(messages: T[]): Array<Omit<T, "isStreaming"> & { isStreaming?: boolean }> {
	return messages.map((message) =>
		message.isStreaming ? { ...message, isStreaming: false } : message
	);
}
