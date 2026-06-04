import {
	type ChatMessage,
	nextId,
	trimMessages,
} from "../../features/chat/agent-chat-shared.ts";
import { hasRole } from "../../lib/data.ts";

type ChatStateMessage = Pick<
	ChatMessage,
	"id" | "role" | "content" | "parts" | "isStreaming"
>;

export function dedupeChatMessagesById<T extends { id: string }>(
	messages: T[]
): T[] {
	let hasDuplicate = false;
	const seen = new Set<string>();
	for (const message of messages) {
		if (seen.has(message.id)) {
			hasDuplicate = true;
			break;
		}
		seen.add(message.id);
	}
	if (!hasDuplicate) return messages;

	const byId = new Map<string, T>();
	for (const message of messages) {
		if (byId.has(message.id)) byId.delete(message.id);
		byId.set(message.id, message);
	}
	return [...byId.values()];
}

export function patchMessageById(
	messages: ChatStateMessage[],
	id: string,
	patch:
		| Partial<ChatStateMessage>
		| ((message: ChatStateMessage) => Partial<ChatStateMessage>),
	searchFromEnd = true
): ChatStateMessage[] {
	const updated = messages.slice();
	const start = searchFromEnd ? updated.length - 1 : 0;
	const end = searchFromEnd ? -1 : updated.length;
	const step = searchFromEnd ? -1 : 1;

	for (let i = start; i !== end; i += step) {
		if (updated[i]?.id !== id) continue;
		const nextPatch = typeof patch === "function" ? patch(updated[i]!) : patch;
		updated[i] = { ...updated[i]!, ...nextPatch };
		return updated;
	}

	return messages;
}

export function appendMessageContent(
	messages: ChatStateMessage[],
	id: string,
	content: string
): ChatStateMessage[] {
	return patchMessageById(messages, id, (message) => ({
		content: message.content + content,
	}));
}

export function appendSystemMessage(
	messages: ChatStateMessage[],
	content: string
): ChatStateMessage[] {
	return trimMessages([...messages, { id: nextId(), role: "system", content }]);
}

export function mergeSyncedMessages(
	localMessages: ChatStateMessage[],
	serverMessages: ChatStateMessage[]
): ChatStateMessage[] {
	const localUserMsgs = localMessages.filter(hasRole.bind(null, "user"));
	const uniqueServerMessages = dedupeChatMessagesById(serverMessages);
	const serverUserMsgs = uniqueServerMessages.filter(
		hasRole.bind(null, "user")
	);
	const displayTextMap = new Map<number, string>();

	for (let i = 0; i < serverUserMsgs.length && i < localUserMsgs.length; i++) {
		if (localUserMsgs[i]!.content.length < serverUserMsgs[i]!.content.length) {
			displayTextMap.set(i, localUserMsgs[i]!.content);
		}
	}

	let userIdx = 0;
	const merged = uniqueServerMessages.map((message) => {
		if (message.role !== "user") return message;
		const displayText = displayTextMap.get(userIdx);
		userIdx++;
		return displayText ? { ...message, content: displayText } : message;
	});
	return merged;
}
