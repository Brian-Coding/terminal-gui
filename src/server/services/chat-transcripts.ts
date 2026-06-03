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

export async function readChatTranscript(
	paneId: string
): Promise<ChatTranscriptMessage[] | null> {
	const transcript = await readJson<unknown>(
		userDataPath(CHAT_TRANSCRIPTS_DIR, `${paneId}.json`),
		null
	);
	return isChatTranscript(transcript) ? transcript : null;
}

export async function writeChatTranscript(
	paneId: string,
	messages: ChatTranscriptMessage[]
): Promise<void> {
	await writeJson(
		userDataPath(CHAT_TRANSCRIPTS_DIR, `${paneId}.json`),
		prepareTranscriptForStorage(messages)
	);
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
