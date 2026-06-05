import { expect, test } from "bun:test";
import { reconcileChatSync } from "../src/components/chat/chat-state-utils.ts";
import type { ChatMessage } from "../src/features/chat/agent-chat-shared.ts";

test("chat sync reconciler skips duplicate completed revisions", () => {
	const currentMessages: ChatMessage[] = [
		{ id: "m1", role: "user", content: "hello" },
	];

	const result = reconcileChatSync({
		currentMessages,
		isStreaming: false,
		previousRevision: 9,
		revision: 9,
		serverMessages: [{ id: "m2", role: "assistant", content: "duplicate" }],
	});

	expect(result).toMatchObject({
		mergedMessages: currentMessages,
		nextRevision: 9,
		shouldPersist: false,
		shouldSkip: true,
		shouldUpdateMessages: false,
	});
});

test("chat sync reconciler preserves shorter local user display text", () => {
	const result = reconcileChatSync({
		currentMessages: [{ id: "u1", role: "user", content: "short prompt" }],
		isStreaming: false,
		previousRevision: 1,
		revision: 2,
		serverMessages: [
			{
				id: "u1-server",
				role: "user",
				content: "short prompt plus expanded context",
			},
			{ id: "a1", role: "assistant", content: "done" },
		],
	});

	expect(result).toMatchObject({
		nextRevision: 2,
		shouldPersist: true,
		shouldSkip: false,
		shouldUpdateMessages: true,
	});
	expect(result.mergedMessages).toEqual([
		{ id: "u1-server", role: "user", content: "short prompt" },
		{ id: "a1", role: "assistant", content: "done" },
	]);
});

test("chat sync reconciler exposes streaming assistant and tool ids", () => {
	const result = reconcileChatSync({
		currentMessages: [],
		isStreaming: true,
		previousRevision: null,
		revision: 3,
		serverMessages: [
			{ id: "a1", role: "assistant", content: "partial", isStreaming: true },
			{
				id: "t1",
				role: "tool",
				content: "{",
				isStreaming: true,
				toolName: "Read",
			},
		],
	});

	expect(result).toMatchObject({
		nextRevision: 3,
		shouldPersist: false,
		shouldSkip: false,
		shouldUpdateMessages: true,
		streamingAssistantId: "a1",
		streamingToolId: "t1",
	});
});
