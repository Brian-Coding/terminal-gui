import { describe, expect, test } from "bun:test";
import { extractToolActivities } from "../src/components/chat/chat-agent-utils.ts";
import {
	getToolBlockInitialContent,
	stringifyToolInput,
} from "../src/features/chat/agent-chat-shared.ts";
import {
	handleCodexEvent,
	resolveCompletedCodexAssistantMessage,
} from "../src/server/agents/codex-adapter.ts";

describe("agent stream event normalization", () => {
	/*
	 * This protects parity between Claude and Codex tool streams. Claude often
	 * streams tool input through input_json_delta events, while Codex can emit a
	 * complete synthetic Edit tool input on content_block_start and then stop
	 * immediately. The initial block input must become message content or inline
	 * diff cards render as an empty "Edit" entry.
	 */
	test("preserves tool input included on content_block_start", () => {
		const block = {
			type: "tool_use",
			name: "Edit",
			input: {
				file_path: "src/app.ts",
				old_string: "const value = 1;\n",
				new_string: "const value = 2;\n",
			},
		};

		expect(getToolBlockInitialContent(block)).toBe(
			JSON.stringify(block.input, null, 2)
		);
		expect(
			extractToolActivities([
				{
					id: "tool-1",
					role: "tool",
					toolName: "Edit",
					content: getToolBlockInitialContent(block),
					isStreaming: false,
				},
			])
		).toEqual([
			{
				id: "tool-1",
				toolName: "edit",
				isStreaming: false,
				summary: "app.ts",
			},
		]);
	});

	/*
	 * This protects the other side of the same contract: streamed tools still
	 * start empty when the provider does not include initial input, and string
	 * inputs pass through unchanged so already-serialized provider payloads do
	 * not get double-encoded.
	 */
	test("keeps missing input empty and string input unchanged", () => {
		expect(getToolBlockInitialContent({ type: "tool_use", name: "Bash" })).toBe(
			""
		);
		expect(stringifyToolInput('{"command":"bun test"}')).toBe(
			'{"command":"bun test"}'
		);
		expect(stringifyToolInput(null)).toBe("");
	});

	test("does not replay completed Codex agent messages already streamed", () => {
		expect(resolveCompletedCodexAssistantMessage("done", "done")).toEqual({
			mode: "skip",
		});
		expect(
			resolveCompletedCodexAssistantMessage("partial", "partial answer")
		).toEqual({ mode: "delta", text: " answer" });
		expect(resolveCompletedCodexAssistantMessage("draft", "final")).toEqual({
			mode: "replace",
		});
	});

	test("Codex file_change events do not synthesize filesystem edit diffs", () => {
		const chatEvents: unknown[] = [];
		const agentEvents: unknown[] = [];
		const state = {
			outputPath: "",
			debugLogPath: "",
			assistantOpen: false,
			toolOpen: false,
			sawAssistantStream: false,
			hasFinalAssistantMessage: false,
			completedFromEvent: false,
			lastAssistantMessage: "",
			lastChatBlockRole: null,
			currentToolId: null,
			fileSnapshots: new Map<string, string | null>(),
			fileWatchers: new Map<string, ReturnType<typeof setInterval>>(),
			activePatchPaths: [],
			commandOutputs: new Map<string, string>(),
		};
		const ctx = {
			paneId: "pane-1",
			cwd: process.cwd(),
			getSessionId: () => null,
			isCancelled: () => false,
			updateSessionId: () => {},
			emitChatEvent: (event: unknown) => chatEvents.push(event),
			emitAgentEvent: (event: unknown) => agentEvents.push(event),
			emitStatus: () => {},
			emitActivity: () => {},
			emitSystemMessage: () => {},
		};

		handleCodexEvent(ctx as any, state as any, {
			type: "item.started",
			item: { type: "file_change", changes: ["src/app.ts"] },
		});
		handleCodexEvent(ctx as any, state as any, {
			type: "item.completed",
			item: { type: "file_change", changes: ["src/app.ts"] },
		});

		expect(
			chatEvents.some(
				(event: any) =>
					event?.type === "content_block_start" &&
					event.content_block?.type === "tool_use" &&
					event.content_block.name === "Edit"
			)
		).toBe(false);
		expect(
			chatEvents.some(
				(event: any) =>
					event?.type === "content_block_start" &&
					event.content_block?.type === "tool_use" &&
					event.content_block.name === "patch"
			)
		).toBe(true);
		expect(state.fileSnapshots.size).toBe(0);
		expect(state.fileWatchers.size).toBe(0);
		expect(
			agentEvents.some((event: any) => event?.type === "tool-call-start")
		).toBe(true);
	});
});
