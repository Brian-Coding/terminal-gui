import { readJson, writeJson } from "../../lib/route-helpers.ts";
import { userDataPath } from "../../lib/user-data.ts";

const CHAT_TRANSCRIPTS_DIR = "chat-transcripts";

export interface ChatTranscriptMessage {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	content: string;
	toolName?: string;
	isStreaming?: boolean;
}

const transcriptCache = new Map<string, ChatTranscriptMessage[] | null>();

function cloneTranscript(
	messages: ChatTranscriptMessage[] | null
): ChatTranscriptMessage[] | null {
	return messages?.map((message) => ({ ...message })) ?? null;
}

export async function readChatTranscript(
	paneId: string
): Promise<ChatTranscriptMessage[] | null> {
	if (transcriptCache.has(paneId)) {
		return cloneTranscript(transcriptCache.get(paneId) ?? null);
	}
	const transcript = await readJson<unknown>(
		userDataPath(CHAT_TRANSCRIPTS_DIR, `${paneId}.json`),
		null
	);
	const messages = isChatTranscript(transcript) ? transcript : null;
	transcriptCache.set(paneId, cloneTranscript(messages));
	return cloneTranscript(messages);
}

export async function writeChatTranscript(
	paneId: string,
	messages: ChatTranscriptMessage[]
): Promise<void> {
	const stored = prepareTranscriptForStorage(messages);
	transcriptCache.set(paneId, cloneTranscript(stored));
	await writeJson(userDataPath(CHAT_TRANSCRIPTS_DIR, `${paneId}.json`), stored);
}

export function prepareTranscriptForStorage(
	messages: ChatTranscriptMessage[]
): ChatTranscriptMessage[] {
	return messages.map((message) =>
		message.isStreaming ? { ...message, isStreaming: false } : message
	);
}

function isChatTranscript(value: unknown): value is ChatTranscriptMessage[] {
	return (
		Array.isArray(value) &&
		value.every((message) => {
			if (typeof message !== "object" || message === null) return false;
			const candidate = message as Partial<ChatTranscriptMessage>;
			return (
				typeof candidate.id === "string" &&
				isChatRole(candidate.role) &&
				typeof candidate.content === "string"
			);
		})
	);
}

function isChatRole(value: unknown): value is ChatTranscriptMessage["role"] {
	return (
		value === "user" ||
		value === "assistant" ||
		value === "tool" ||
		value === "system"
	);
}
