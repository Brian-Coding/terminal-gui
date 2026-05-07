import { existsSync, readFileSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
	createAgentEnv,
	resolveAgentBinary,
} from "../../../features/terminal/terminal-command.ts";
import { noop } from "../../../lib/data.ts";
import { basename, trimText as trimSummary } from "../../../lib/format.ts";
import { isWithinDirectory } from "../../security.ts";
import { summarizeToolInput } from "../events.ts";
import {
	drainStreamToString,
	flushNdjsonLeftover,
	parseNdjsonLines,
} from "../stream-utils.ts";
import type { AgentAdapter, AgentHandle, AgentRunContext } from "../types.ts";

interface CodexRunState {
	outputPath: string;
	debugLogPath: string;
	assistantOpen: boolean;
	toolOpen: boolean;
	sawAssistantStream: boolean;
	hasFinalAssistantMessage: boolean;
	lastAssistantMessage: string;
	currentToolId: string | null;
	fileSnapshots: Map<string, string | null>;
	commandOutputs: Map<string, string>;
}

const MAX_INLINE_DIFF_CHARS = 80_000;

function extractText(value: any): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (typeof value.text === "string") return value.text;
	if (typeof value.message === "string") return value.message;
	if (typeof value.content === "string") return value.content;
	if (typeof value.delta === "string") return value.delta;
	if (typeof value.last_agent_message === "string")
		return value.last_agent_message;
	if (typeof value.output_text === "string") return value.output_text;
	if (Array.isArray(value.content)) {
		return value.content
			.map((item: any) => extractText(item))
			.filter(Boolean)
			.join("");
	}
	return "";
}

function safePaneFileStem(paneId: string): string {
	return paneId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "pane";
}

function summarizeToolEvent(toolName: string, payload: any): string {
	if (!payload) return toolName;
	if (typeof payload.command === "string" && payload.command) {
		return trimSummary(payload.command, 48);
	}
	if (typeof payload.cmd === "string" && payload.cmd) {
		return trimSummary(payload.cmd, 48);
	}
	if (typeof payload.query === "string" && payload.query) {
		return trimSummary(payload.query, 48);
	}
	if (typeof payload.path === "string" && payload.path) {
		return basename(payload.path);
	}
	if (typeof payload.file === "string" && payload.file) {
		return basename(payload.file);
	}
	if (Array.isArray(payload.files) && payload.files.length > 0) {
		const first = String(payload.files[0] ?? "");
		return payload.files.length === 1
			? basename(first)
			: `${basename(first)} +${payload.files.length - 1}`;
	}
	if (Array.isArray(payload.changes) && payload.changes.length > 0) {
		const first = payload.changes[0];
		const firstFile =
			typeof first === "string"
				? first
				: (first?.file_path ?? first?.path ?? first?.file ?? "");
		if (firstFile) {
			return payload.changes.length === 1
				? basename(firstFile)
				: `${basename(firstFile)} +${payload.changes.length - 1}`;
		}
		return `${payload.changes.length} changes`;
	}
	return toolName;
}

function resolveChangedPath(cwd: string, value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	const absolutePath = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
	return isWithinDirectory(absolutePath, cwd) ? absolutePath : null;
}

function getDisplayPath(cwd: string, absolutePath: string): string {
	const relativePath = relative(cwd, absolutePath);
	return relativePath &&
		!relativePath.startsWith("..") &&
		!isAbsolute(relativePath)
		? relativePath
		: absolutePath;
}

function readSnapshot(path: string): string | null {
	try {
		if (!existsSync(path)) return "";
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_INLINE_DIFF_CHARS) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function getFileChangePaths(cwd: string, item: any): string[] {
	const changes = Array.isArray(item?.changes) ? item.changes : [];
	const paths = changes
		.map((change: any) =>
			resolveChangedPath(cwd, change?.path ?? change?.file_path ?? change?.file)
		)
		.filter((path: string | null): path is string => Boolean(path));
	if (paths.length > 0) return [...new Set(paths)];
	const singlePath = resolveChangedPath(
		cwd,
		item?.path ?? item?.file_path ?? item?.file
	);
	return singlePath ? [singlePath] : [];
}

function handleCodexEvent(
	ctx: AgentRunContext,
	state: CodexRunState,
	event: any
) {
	const closeTool = () => {
		if (!state.toolOpen) return;
		ctx.emitChatEvent({ type: "content_block_stop" });
		if (state.currentToolId) {
			ctx.emitAgentEvent({
				type: "tool-call-end",
				toolCallId: state.currentToolId,
			});
		}
		state.toolOpen = false;
		state.currentToolId = null;
	};
	const closeAssistant = () => {
		if (!state.assistantOpen) return;
		ctx.emitChatEvent({ type: "content_block_stop" });
		state.assistantOpen = false;
	};
	const startAssistant = () => {
		if (state.assistantOpen) return;
		closeTool();
		ctx.emitChatEvent({
			type: "content_block_start",
			content_block: { type: "text", text: "" },
		});
		state.assistantOpen = true;
		state.sawAssistantStream = true;
	};
	const startTool = (name: string, input: unknown = {}) => {
		closeAssistant();
		closeTool();
		const toolCallId = `${name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		ctx.emitChatEvent({
			type: "content_block_start",
			content_block: { type: "tool_use", name, input },
		});
		ctx.emitAgentEvent({
			type: "tool-call-start",
			toolCallId,
			toolName: name,
			input,
			summary: summarizeToolInput(name, input),
		});
		state.toolOpen = true;
		state.currentToolId = toolCallId;
	};
	const toolDelta = (textDelta: string) => {
		if (!state.toolOpen || !textDelta) return;
		ctx.emitChatEvent({
			type: "content_block_delta",
			delta: { type: "input_json_delta", partial_json: textDelta },
		});
		if (state.currentToolId) {
			ctx.emitAgentEvent({
				type: "tool-call-delta",
				toolCallId: state.currentToolId,
				delta: textDelta,
			});
		}
	};
	const assistantDelta = (textDelta: string) => {
		if (!textDelta) return;
		startAssistant();
		ctx.emitChatEvent({
			type: "content_block_delta",
			delta: { type: "text_delta", text: textDelta },
		});
		ctx.emitAgentEvent({ type: "text-delta", text: textDelta });
	};
	const emitEditDiff = (
		absolutePath: string,
		before: string,
		after: string
	) => {
		if (before === after) return;
		if (before.length + after.length > MAX_INLINE_DIFF_CHARS) return;
		const input = {
			file_path: getDisplayPath(ctx.cwd, absolutePath),
			old_string: before,
			new_string: after,
		};
		startTool("Edit", input);
		closeTool();
	};
	const emitCommandOutputDelta = (item: any) => {
		if (typeof item?.aggregated_output !== "string" || !item.aggregated_output)
			return;
		const itemId = typeof item.id === "string" ? item.id : "latest";
		const previousOutput = state.commandOutputs.get(itemId) ?? "";
		const nextOutput = item.aggregated_output;
		const delta = nextOutput.startsWith(previousOutput)
			? nextOutput.slice(previousOutput.length)
			: nextOutput;
		if (delta) toolDelta(delta);
		state.commandOutputs.set(itemId, nextOutput);
	};

	const eventType = String(event?.type ?? "");
	const eventText = extractText(event);
	const item = event?.item;

	if (event?.type === "thread.started" && event.thread_id) {
		ctx.updateSessionId(event.thread_id);
		ctx.emitAgentEvent({ type: "session", providerSessionId: event.thread_id });
	} else if (event?.type === "turn.started") {
		ctx.emitStatus("thinking", true);
		ctx.emitAgentEvent({ type: "status", status: "thinking" });
	} else if (
		event?.type === "item.started" &&
		item?.type === "command_execution"
	) {
		const payload = {
			command: item.command ?? "",
			cwd: ctx.cwd,
		};
		ctx.emitStatus("tool:exec", true);
		ctx.emitActivity({
			toolName: "exec",
			summary: summarizeToolEvent("exec", payload),
			isStreaming: true,
		});
		if (typeof item.id === "string") {
			state.commandOutputs.set(item.id, item.aggregated_output ?? "");
		}
		startTool("exec", payload);
	} else if (
		event?.type === "item.updated" &&
		item?.type === "command_execution"
	) {
		emitCommandOutputDelta(item);
	} else if (
		event?.type === "item.completed" &&
		item?.type === "command_execution"
	) {
		emitCommandOutputDelta(item);
		if (typeof item.id === "string") {
			state.commandOutputs.delete(item.id);
		}
		closeTool();
	} else if (event?.type === "item.started" && item?.type === "file_change") {
		const paths = getFileChangePaths(ctx.cwd, item);
		for (const path of paths) {
			state.fileSnapshots.set(path, readSnapshot(path));
		}
		const payload = { changes: item.changes ?? paths };
		ctx.emitStatus("tool:patch", true);
		ctx.emitActivity({
			toolName: "patch",
			summary: summarizeToolEvent("patch", payload),
			isStreaming: true,
		});
		startTool("patch", payload);
	} else if (event?.type === "item.completed" && item?.type === "file_change") {
		const paths = getFileChangePaths(ctx.cwd, item);
		closeTool();
		for (const path of paths) {
			const before = state.fileSnapshots.get(path);
			const after = readSnapshot(path);
			state.fileSnapshots.delete(path);
			if (before !== null && before !== undefined && after !== null) {
				emitEditDiff(path, before, after);
			}
		}
	} else if (
		event?.type === "item.completed" &&
		item?.type === "agent_message"
	) {
		const text = typeof item.text === "string" ? item.text : extractText(item);
		if (text) {
			assistantDelta(text);
			closeAssistant();
			state.lastAssistantMessage = text;
			state.hasFinalAssistantMessage = true;
		}
	} else if (event?.type === "agent_message_delta") {
		assistantDelta(event.delta ?? event.text ?? event.content ?? "");
		ctx.emitStatus("responding", true);
		ctx.emitAgentEvent({ type: "status", status: "responding" });
	} else if (event?.type === "agent_message") {
		const content = event.message ?? event.content ?? event.text ?? "";
		if (typeof content === "string" && content) {
			assistantDelta(content);
		}
	} else if (event?.type === "exec_command_begin") {
		const payload = {
			command: event.parsed_cmd ?? event.command ?? event.cmd ?? "",
			cwd: event.cwd ?? ctx.cwd,
		};
		ctx.emitStatus("tool:exec", true);
		ctx.emitActivity({
			toolName: "exec",
			summary: summarizeToolEvent("exec", payload),
			isStreaming: true,
		});
		startTool("exec", payload);
	} else if (event?.type === "exec_command_output_delta") {
		const chunk =
			typeof event.chunk === "string"
				? Buffer.from(event.chunk, "base64").toString("utf8")
				: "";
		toolDelta(chunk);
	} else if (event?.type === "exec_command_end") {
		closeTool();
	} else if (event?.type === "patch_apply_begin") {
		const payload = { changes: event.changes ?? event.files ?? [] };
		ctx.emitStatus("tool:patch", true);
		ctx.emitActivity({
			toolName: "patch",
			summary: summarizeToolEvent("patch", payload),
			isStreaming: true,
		});
		startTool("patch", payload);
	} else if (event?.type === "patch_apply_end") {
		closeTool();
	} else if (event?.type === "web_search_begin") {
		const payload = { query: event.query ?? "" };
		ctx.emitStatus("tool:web_search", true);
		ctx.emitActivity({
			toolName: "web_search",
			summary: summarizeToolEvent("web_search", payload),
			isStreaming: true,
		});
		startTool("web_search", payload);
	} else if (event?.type === "web_search_end") {
		if (event.query) toolDelta(event.query);
		closeTool();
	} else if (event?.type === "mcp_tool_call_begin") {
		const toolName = event.invocation?.tool ?? event.tool ?? "mcp_tool";
		const payload = event.invocation?.arguments ?? event.arguments ?? {};
		ctx.emitStatus(`tool:${toolName}`, true);
		ctx.emitActivity({
			toolName,
			summary: summarizeToolEvent(toolName, payload),
			isStreaming: true,
		});
		startTool(toolName, payload);
	} else if (event?.type === "mcp_tool_call_end") {
		closeTool();
	} else if (
		event?.type === "item.completed" &&
		event.item?.type === "error" &&
		event.item.message
	) {
		ctx.emitAgentEvent({ type: "error", message: event.item.message });
		ctx.emitSystemMessage(event.item.message);
	} else if (
		event?.type === "item.completed" &&
		event.item &&
		extractText(event.item)
	) {
		const itemText = extractText(event.item);
		if (!state.sawAssistantStream && itemText) {
			ctx.emitChatEvent({ type: "result", result: itemText });
			ctx.emitAgentEvent({ type: "result", text: itemText });
			state.hasFinalAssistantMessage = true;
		}
	} else if (event?.type === "error" && event.message) {
		ctx.emitAgentEvent({ type: "error", message: event.message });
		ctx.emitSystemMessage(event.message);
	} else if (
		event?.type === "task_complete" &&
		typeof event.last_agent_message === "string" &&
		event.last_agent_message
	) {
		if (!state.sawAssistantStream) {
			ctx.emitChatEvent({
				type: "result",
				result: event.last_agent_message,
			});
			ctx.emitAgentEvent({ type: "result", text: event.last_agent_message });
			state.hasFinalAssistantMessage = true;
		}
	} else if (
		eventText &&
		/message|assistant|output_text|text_delta/i.test(eventType) &&
		!/error|tool|exec_command|patch|web_search|mcp/i.test(eventType)
	) {
		assistantDelta(eventText);
		ctx.emitStatus("responding", true);
		ctx.emitAgentEvent({ type: "status", status: "responding" });
	}
}

export const codexAdapter: AgentAdapter<CodexRunState> = {
	kind: "codex",
	displayName: "Codex",

	createState(ctx) {
		const paneFileStem = safePaneFileStem(ctx.paneId);
		return {
			outputPath: resolve(
				tmpdir(),
				`inferay-codex-${paneFileStem}-${Date.now()}.txt`
			),
			debugLogPath: "",
			assistantOpen: false,
			toolOpen: false,
			sawAssistantStream: false,
			hasFinalAssistantMessage: false,
			lastAssistantMessage: "",
			currentToolId: null,
			fileSnapshots: new Map(),
			commandOutputs: new Map(),
		};
	},

	createHandle(prompt, ctx, state): AgentHandle {
		let proc: ReturnType<typeof Bun.spawn> | null = null;
		const killProcess = () => {
			try {
				proc?.kill();
			} catch {}
		};

		return {
			async run() {
				const codexCmd = resolveAgentBinary("codex");
				const baseArgs = [
					"--json",
					"--skip-git-repo-check",
					"--output-last-message",
					state.outputPath,
				];
				if (ctx.model) {
					baseArgs.push("--model", ctx.model);
				}
				if (ctx.reasoningLevel) {
					const reasoningEffort =
						ctx.reasoningLevel === "extra_high" ? "xhigh" : ctx.reasoningLevel;
					baseArgs.push("-c", `reasoning_effort="${reasoningEffort}"`);
				}
				const sessionId = ctx.getSessionId();
				const args = sessionId
					? [codexCmd, "exec", "resume", ...baseArgs, sessionId, "--", prompt]
					: [codexCmd, "exec", ...baseArgs, "--", prompt];

				proc = Bun.spawn(args, {
					stdout: "pipe",
					stderr: "pipe",
					cwd: ctx.cwd,
					env: createAgentEnv("codex"),
				});

				const stderrPromise = drainStreamToString(
					proc.stderr as ReadableStream<Uint8Array>
				);
				const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
				const decoder = new TextDecoder();
				let leftover = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					leftover += decoder.decode(value, { stream: true });
					leftover = parseNdjsonLines(
						leftover,
						handleCodexEvent.bind(null, ctx, state)
					);
				}
				flushNdjsonLeftover(leftover, handleCodexEvent.bind(null, ctx, state));

				const exitCode = await proc.exited;
				proc = null;
				const stderrText = (await stderrPromise).trim();

				// Finalize
				if (state.toolOpen || state.assistantOpen) {
					if (state.currentToolId) {
						ctx.emitAgentEvent({
							type: "tool-call-end",
							toolCallId: state.currentToolId,
						});
					}
					ctx.emitChatEvent({ type: "content_block_stop" });
					state.toolOpen = false;
					state.assistantOpen = false;
					state.currentToolId = null;
				}

				let assistantText = "";
				const outputFile = Bun.file(state.outputPath);
				try {
					if (await outputFile.exists()) {
						assistantText = (await outputFile.text()).trim();
						state.lastAssistantMessage = assistantText;
					}
				} finally {
					await unlink(state.outputPath).catch(noop);
				}
				if (
					assistantText &&
					!state.sawAssistantStream &&
					!state.hasFinalAssistantMessage
				) {
					ctx.emitChatEvent({
						type: "result",
						result: assistantText,
					});
					ctx.emitAgentEvent({ type: "result", text: assistantText });
				} else if (exitCode !== 0 && stderrText) {
					ctx.emitAgentEvent({ type: "error", message: stderrText });
					ctx.emitSystemMessage(stderrText);
				}
				ctx.emitAgentEvent({
					type: "finish",
					reason: exitCode === 0 ? "completed" : `exit:${exitCode}`,
				});

				return { lastAssistantMessage: state.lastAssistantMessage };
			},

			stop: killProcess,
			kill: killProcess,
		};
	},
};
