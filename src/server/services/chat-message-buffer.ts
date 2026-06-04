import {
	isChatStreamEvent,
	trimMessages,
} from "../../features/chat/agent-chat-shared.ts";
import { getToolBlockInitialContent } from "../../features/chat/chat-stream-events.ts";
import type { ChatTranscriptMessage } from "./chat-transcripts.ts";

let serverMsgId = 0;

export class ChatMessageBuffer {
	private messages: ChatTranscriptMessage[] = [];
	private currentAssistantIdx = -1;
	private currentToolIdx = -1;
	private hasStreamed = false;

	private push(
		role: ChatTranscriptMessage["role"],
		content: string,
		extra?: Partial<ChatTranscriptMessage>
	) {
		this.messages.push({ id: `s${++serverMsgId}`, role, content, ...extra });
		this.trim();
	}

	pushUser(text: string) {
		this.push("user", text);
	}

	pushSystem(text: string) {
		this.push("system", text);
	}

	private appendAssistant(content: string, isStreaming: boolean) {
		this.currentAssistantIdx = this.messages.length;
		this.push("assistant", content, { isStreaming });
	}

	private appendTool(name: string, content: string) {
		this.currentAssistantIdx = -1;
		this.currentToolIdx = this.messages.length;
		this.push("tool", content, { toolName: name, isStreaming: true });
	}

	private patchCurrent(
		key: "currentAssistantIdx" | "currentToolIdx",
		patch: Partial<ChatTranscriptMessage>
	) {
		const idx = this[key];
		if (idx < 0 || idx >= this.messages.length) return false;
		this.messages[idx] = { ...this.messages[idx]!, ...patch };
		return true;
	}

	applyEvent(event: unknown) {
		if (!isChatStreamEvent(event)) return;
		if (event.type === "assistant") {
			const msg = event.message;
			if (!msg?.content || this.hasStreamed) return;
			for (const block of msg.content) {
				if (block.type === "text" && block.text) {
					if (
						!this.patchCurrent("currentAssistantIdx", {
							content: block.text,
							isStreaming: !msg.stop_reason,
						})
					)
						this.appendAssistant(block.text, !msg.stop_reason);
				} else if (block.type === "tool_use") {
					this.appendTool(
						block.name,
						typeof block.input === "string"
							? block.input
							: JSON.stringify(block.input, null, 2)
					);
				}
			}
		} else if (event.type === "content_block_start") {
			this.hasStreamed = true;
			const block = event.content_block;
			if (block?.type === "text") {
				this.appendAssistant(block.text || "", true);
			} else if (block?.type === "tool_use") {
				this.appendTool(block.name, getToolBlockInitialContent(block));
			}
		} else if (event.type === "content_block_delta") {
			const delta = event.delta;
			if (
				delta?.type === "text_delta" &&
				delta.text &&
				this.currentAssistantIdx >= 0
			) {
				this.messages[this.currentAssistantIdx]!.content += delta.text;
			} else if (
				delta?.type === "input_json_delta" &&
				delta.partial_json &&
				this.currentToolIdx >= 0
			) {
				this.messages[this.currentToolIdx]!.content += delta.partial_json;
			}
		} else if (event.type === "content_block_stop") {
			this.patchCurrent("currentAssistantIdx", { isStreaming: false });
			this.patchCurrent("currentToolIdx", { isStreaming: false });
			this.currentAssistantIdx = -1;
			this.currentToolIdx = -1;
		} else if (event.type === "result" && event.result) {
			if (
				this.patchCurrent("currentAssistantIdx", {
					content: event.result,
					isStreaming: false,
				})
			) {
				this.currentAssistantIdx = -1;
			} else {
				this.push("assistant", event.result);
			}
		}
	}

	finalize() {
		for (const message of this.messages) message.isStreaming = false;
		this.currentAssistantIdx = -1;
		this.currentToolIdx = -1;
		this.hasStreamed = false;
		this.trim();
	}

	replaceInAssistantMessages(replacer: (content: string) => string) {
		for (const message of this.messages) {
			if (message.role !== "assistant") continue;
			message.content = replacer(message.content);
		}
	}

	getMessages(): ChatTranscriptMessage[] {
		return this.messages;
	}

	get streaming(): boolean {
		return this.currentAssistantIdx >= 0 || this.currentToolIdx >= 0;
	}

	replaceMessages(messages: ChatTranscriptMessage[]) {
		this.messages = messages.map((message) => ({
			...message,
			isStreaming: false,
		}));
		this.currentAssistantIdx = -1;
		this.currentToolIdx = -1;
		this.hasStreamed = false;
		this.trim();
	}

	private trim() {
		const previous = this.messages;
		this.messages = trimMessages(this.messages);
		const drop = previous.length - this.messages.length;
		if (drop <= 0) return;
		this.currentAssistantIdx =
			this.currentAssistantIdx >= drop ? this.currentAssistantIdx - drop : -1;
		this.currentToolIdx =
			this.currentToolIdx >= drop ? this.currentToolIdx - drop : -1;
	}
}
