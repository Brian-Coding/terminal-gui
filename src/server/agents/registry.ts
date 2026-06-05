import { existsSync, readFileSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ChatAgentKind } from "../../features/agents/agents.ts";
import { getAgentDefinition } from "../../features/agents/agents.ts";
import { isChatStreamEvent } from "../../features/chat/agent-chat-shared.ts";
import {
	createAgentEnv,
	resolveAgentBinary,
} from "../../features/terminal/terminal-command.ts";
import { hasId, noop } from "../../lib/data.ts";
import { basename, trimText as trimSummary } from "../../lib/format.ts";
import { isWithinDirectory } from "../security.ts";
import { PidTracker } from "../services/pid-tracker.ts";
import {
	type AgentAdapter,
	type AgentEvent,
	type AgentHandle,
	type AgentRunContext,
	drainStreamToString,
	flushNdjsonLeftover,
	parseNdjsonLines,
	summarizeToolInput,
} from "./events.ts";

function emitClaudeAgentEvent(event: unknown, ctx: AgentRunContext) {
	const normalized = normalizeClaudeEvent(event);
	if (normalized) ctx.emitAgentEvent(normalized);
}

function normalizeClaudeEvent(event: unknown): AgentEvent | null {
	if (!event || typeof event !== "object") return null;
	const data = event as Record<string, any>;
	if (!data.type) return null;
	if (data.type === "content_block_start") {
		const block = data.content_block;
		if (
			block?.type === "text" &&
			typeof block.text === "string" &&
			block.text
		) {
			return { type: "text-delta", text: block.text };
		}
		if (block?.type === "tool_use") {
			const toolName = String(block.name ?? "tool");
			const input = block.input ?? {};
			return {
				type: "tool-call-start",
				toolCallId: String(data.index ?? block.id ?? `${toolName}:latest`),
				toolName,
				input,
				summary: summarizeToolInput(toolName, input),
			};
		}
	}
	if (data.type === "content_block_delta") {
		const delta = data.delta;
		if (delta?.type === "text_delta" && typeof delta.text === "string") {
			return { type: "text-delta", text: delta.text };
		}
		if (
			delta?.type === "thinking_delta" &&
			typeof delta.thinking === "string"
		) {
			return { type: "thinking-delta", text: delta.thinking };
		}
		if (
			delta?.type === "input_json_delta" &&
			typeof delta.partial_json === "string"
		) {
			return {
				type: "tool-call-delta",
				toolCallId: String(data.index ?? "latest"),
				delta: delta.partial_json,
			};
		}
	}
	if (data.type === "result" && typeof data.result === "string") {
		return { type: "result", text: data.result };
	}
	if (data.type === "error" && typeof data.message === "string") {
		return { type: "error", message: data.message };
	}
	if (data.type === "system" && data.subtype === "init") {
		return {
			type: "raw",
			provider: "claude",
			eventType: data.type,
			event,
		};
	}
	return null;
}

const claudeAdapter: AgentAdapter<undefined> = {
	kind: "claude",
	displayName: "Claude",

	createState() {
		return undefined;
	},

	createHandle(prompt, ctx): AgentHandle {
		const sessionId = ctx.getSessionId();
		let proc: ReturnType<typeof Bun.spawn> | null = null;

		return {
			async run() {
				try {
					let lastAssistantMessage = "";
					const handleEvent = (event: unknown) => {
						const sessionId =
							event && typeof event === "object"
								? (event as { session_id?: unknown }).session_id
								: undefined;
						if (typeof sessionId === "string") {
							const isNewSession = ctx.getSessionId() !== sessionId;
							ctx.updateSessionId(sessionId);
							if (isNewSession) {
								ctx.emitAgentEvent({
									type: "session",
									providerSessionId: sessionId,
								});
							}
						}
						if (
							event &&
							typeof event === "object" &&
							(event as { type?: unknown }).type === "result" &&
							typeof (event as { result?: unknown }).result === "string"
						) {
							lastAssistantMessage = (event as { result: string }).result;
						}
						emitClaudeAgentEvent(event, ctx);
						if (isChatStreamEvent(event)) ctx.emitChatEvent(event);
					};
					const args = [
						resolveAgentBinary("claude"),
						"-p",
						prompt,
						"--dangerously-skip-permissions",
						"--output-format",
						"stream-json",
						"--verbose",
					];
					if (ctx.model) {
						args.push("--model", ctx.model);
					}
					if (sessionId) {
						args.push("--resume", sessionId);
					}
					proc = Bun.spawn(args, {
						stdout: "pipe",
						stderr: "pipe",
						cwd: ctx.cwd,
						env: createAgentEnv("claude"),
					});

					const stderrPromise = drainStreamToString(
						proc.stderr as ReadableStream<Uint8Array>
					);
					const reader = (
						proc.stdout as ReadableStream<Uint8Array>
					).getReader();
					const decoder = new TextDecoder();
					let leftover = "";

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						leftover += decoder.decode(value, { stream: true });
						leftover = parseNdjsonLines(leftover, handleEvent);
					}

					flushNdjsonLeftover(leftover, handleEvent);

					const exitCode = await proc.exited;
					proc = null;
					const stderrText = (await stderrPromise).trim();
					if (exitCode !== 0 && stderrText && !ctx.isCancelled()) {
						ctx.emitAgentEvent({ type: "error", message: stderrText });
						ctx.emitSystemMessage(stderrText);
					}
					const finishReason = ctx.isCancelled()
						? "cancelled"
						: exitCode === 0
							? "completed"
							: `exit:${exitCode}`;
					ctx.emitAgentEvent({ type: "finish", reason: finishReason });
					return lastAssistantMessage ? { lastAssistantMessage } : undefined;
				} catch (err: any) {
					if (ctx.isCancelled()) return undefined;
					const msg = err.message || "Claude encountered an error";
					ctx.emitAgentEvent({ type: "error", message: msg });
					ctx.emitSystemMessage(msg);
					return undefined;
				}
			},

			stop() {
				try {
					proc?.kill("SIGINT");
					setTimeout(() => {
						try {
							proc?.kill("SIGINT");
						} catch {}
					}, 150);
				} catch {}
			},

			kill() {
				try {
					proc?.kill();
				} catch {}
			},
		};
	},
};

interface CodexRunState {
	outputPath: string;
	debugLogPath: string;
	assistantOpen: boolean;
	toolOpen: boolean;
	sawAssistantStream: boolean;
	hasFinalAssistantMessage: boolean;
	completedFromEvent: boolean;
	lastAssistantMessage: string;
	lastChatBlockRole: "assistant" | "tool" | null;
	currentToolId: string | null;
	fileSnapshots: Map<string, string | null>;
	fileWatchers: Map<string, ReturnType<typeof setInterval>>;
	activePatchPaths: string[];
	commandOutputs: Map<string, string>;
}

const MAX_INLINE_DIFF_CHARS = 80_000;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function stringField(
	record: Record<string, unknown> | null,
	key: string
): string {
	const value = record?.[key];
	return typeof value === "string" ? value : "";
}

function firstString(record: Record<string, unknown> | null, keys: string[]) {
	for (const key of keys) {
		const value = stringField(record, key);
		if (value) return value;
	}
	return "";
}

function arrayField(
	record: Record<string, unknown> | null,
	key: string
): unknown[] {
	const value = record?.[key];
	return Array.isArray(value) ? value : [];
}

function extractText(value: unknown): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	const record = asRecord(value);
	if (!record) return "";
	const text = firstString(record, [
		"text",
		"message",
		"content",
		"delta",
		"last_agent_message",
		"output_text",
	]);
	if (text) return text;
	const content = record.content;
	if (Array.isArray(content)) {
		return content
			.map((item) => extractText(item))
			.filter(Boolean)
			.join("");
	}
	return "";
}

function summarizeToolEvent(toolName: string, payload: unknown): string {
	const record = asRecord(payload);
	if (!record) return toolName;
	for (const key of ["command", "cmd", "query"]) {
		const value = stringField(record, key);
		if (value) return trimSummary(value, 48);
	}
	for (const key of ["path", "file"]) {
		const value = stringField(record, key);
		if (value) return basename(value);
	}
	const files = arrayField(record, "files");
	if (files.length > 0) {
		const first = String(files[0] ?? "");
		return files.length === 1
			? basename(first)
			: `${basename(first)} +${files.length - 1}`;
	}
	const changes = arrayField(record, "changes");
	if (changes.length > 0) {
		const first = changes[0];
		const firstRecord = asRecord(first);
		const firstFile =
			typeof first === "string"
				? first
				: firstString(firstRecord, ["file_path", "path", "file"]);
		if (firstFile) {
			return changes.length === 1
				? basename(firstFile)
				: `${basename(firstFile)} +${changes.length - 1}`;
		}
		return `${changes.length} changes`;
	}
	return toolName;
}

function getReferenceWorkspaceDir(path: string): string | null {
	const resolved = resolve(path);
	try {
		const stat = statSync(resolved);
		if (stat.isDirectory()) return resolved;
		if (stat.isFile()) return dirname(resolved);
		return null;
	} catch {
		return null;
	}
}

function getWorkspaceRoots(
	cwd: string,
	referencePaths?: readonly string[]
): string[] {
	const cwdRoot = resolve(cwd);
	const roots: string[] = [cwdRoot];
	for (const path of referencePaths ?? []) {
		if (typeof path !== "string" || !path.trim()) continue;
		const root = getReferenceWorkspaceDir(path.trim());
		if (!root || isWithinDirectory(root, cwdRoot)) continue;
		if (roots.some((existingRoot) => isWithinDirectory(root, existingRoot)))
			continue;
		roots.push(root);
	}
	return roots;
}

function getCodexWorkspaceArgs(ctx: AgentRunContext): string[] {
	const args = ["--cd", ctx.cwd];
	for (const root of getWorkspaceRoots(ctx.cwd, ctx.referencePaths).slice(1)) {
		args.push("--add-dir", root);
	}
	return args;
}

function isRelativeChild(pathname: string): boolean {
	return !!pathname && !pathname.startsWith("..") && !isAbsolute(pathname);
}

function resolveChangedPath(
	ctx: AgentRunContext,
	value: unknown
): string | null {
	if (typeof value !== "string" || !value) return null;
	const absolutePath = isAbsolute(value)
		? resolve(value)
		: resolve(ctx.cwd, value);
	return getWorkspaceRoots(ctx.cwd, ctx.referencePaths).some((root) =>
		isWithinDirectory(absolutePath, root)
	)
		? absolutePath
		: null;
}

function getDisplayPath(ctx: AgentRunContext, absolutePath: string): string {
	for (const root of getWorkspaceRoots(ctx.cwd, ctx.referencePaths)) {
		const relativePath = relative(root, absolutePath);
		if (!isRelativeChild(relativePath)) continue;
		return root === resolve(ctx.cwd)
			? relativePath
			: `${basename(root)}/${relativePath}`;
	}
	return absolutePath;
}

function readSnapshot(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_INLINE_DIFF_CHARS) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function getFileChangePaths(ctx: AgentRunContext, item: unknown): string[] {
	const record = asRecord(item);
	const candidates: unknown[] = [];
	for (const change of arrayField(record, "changes")) {
		if (typeof change === "string") {
			candidates.push(change);
		} else {
			const changeRecord = asRecord(change);
			candidates.push(firstString(changeRecord, ["path", "file_path", "file"]));
		}
	}
	for (const file of arrayField(record, "files")) {
		if (typeof file === "string") {
			candidates.push(file);
		} else {
			const fileRecord = asRecord(file);
			candidates.push(firstString(fileRecord, ["path", "file_path", "file"]));
		}
	}
	candidates.push(firstString(record, ["path", "file_path", "file"]));
	const paths = candidates
		.map((candidate) => resolveChangedPath(ctx, candidate))
		.filter((path: string | null): path is string => Boolean(path));
	return Array.from(new Set<string>(paths));
}

function handleCodexEvent(
	ctx: AgentRunContext,
	state: CodexRunState,
	event: unknown
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
		state.lastChatBlockRole = "assistant";
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
		state.lastChatBlockRole = "tool";
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
		state.lastAssistantMessage += textDelta;
		state.hasFinalAssistantMessage = true;
	};
	const emitEditDiff = (
		absolutePath: string,
		before: string,
		after: string
	) => {
		if (before === after) return;
		if (before.length + after.length > MAX_INLINE_DIFF_CHARS) return;
		const input = {
			file_path: getDisplayPath(ctx, absolutePath),
			old_string: before,
			new_string: after,
		};
		startTool("Edit", input);
		closeTool();
	};
	const emitLiveDiffForPath = (path: string, keepWatching: boolean) => {
		const before = state.fileSnapshots.get(path);
		const after = readSnapshot(path);
		if (before !== null && before !== undefined && after !== null) {
			if (before !== after) {
				emitEditDiff(path, before, after);
				state.fileSnapshots.set(path, after);
			}
		}
		if (!keepWatching) {
			const watcher = state.fileWatchers.get(path);
			if (watcher) clearInterval(watcher);
			state.fileWatchers.delete(path);
			state.fileSnapshots.delete(path);
		}
	};
	const watchPaths = (paths: readonly string[]) => {
		for (const path of paths) {
			if (state.fileWatchers.has(path)) continue;
			const watcher = setInterval(() => {
				emitLiveDiffForPath(path, true);
			}, 250);
			state.fileWatchers.set(path, watcher);
		}
	};
	const snapshotPaths = (paths: readonly string[]) => {
		for (const path of paths) {
			state.fileSnapshots.set(path, readSnapshot(path));
		}
		watchPaths(paths);
	};
	const emitDiffsForPaths = (paths: readonly string[]) => {
		for (const path of paths) {
			emitLiveDiffForPath(path, false);
		}
	};
	const emitCommandOutputDelta = (item: unknown) => {
		const itemRecord = asRecord(item);
		const nextOutput = stringField(itemRecord, "aggregated_output");
		if (!nextOutput) return;
		const itemId = stringField(itemRecord, "id") || "latest";
		const previousOutput = state.commandOutputs.get(itemId) ?? "";
		const delta = nextOutput.startsWith(previousOutput)
			? nextOutput.slice(previousOutput.length)
			: nextOutput;
		if (delta) toolDelta(delta);
		state.commandOutputs.set(itemId, nextOutput);
	};

	const data = asRecord(event);
	if (!data) return;
	const eventType = stringField(data, "type");
	const eventText = extractText(event);
	const item = data.item;
	const itemRecord = asRecord(item);

	if (eventType === "thread.started" && stringField(data, "thread_id")) {
		const threadId = stringField(data, "thread_id");
		ctx.updateSessionId(threadId);
		ctx.emitAgentEvent({ type: "session", providerSessionId: threadId });
	} else if (eventType === "turn.started") {
		ctx.emitStatus("thinking", true);
		ctx.emitAgentEvent({ type: "status", status: "thinking" });
	} else if (
		eventType === "item.started" &&
		itemRecord?.type === "command_execution"
	) {
		const payload = {
			command: stringField(itemRecord, "command"),
			cwd: ctx.cwd,
		};
		ctx.emitStatus("tool:exec", true);
		ctx.emitActivity({
			toolName: "exec",
			summary: summarizeToolEvent("exec", payload),
			isStreaming: true,
		});
		const itemId = stringField(itemRecord, "id");
		if (itemId) {
			state.commandOutputs.set(
				itemId,
				stringField(itemRecord, "aggregated_output")
			);
		}
		startTool("exec", payload);
	} else if (
		eventType === "item.updated" &&
		itemRecord?.type === "command_execution"
	) {
		emitCommandOutputDelta(item);
	} else if (
		eventType === "item.completed" &&
		itemRecord?.type === "command_execution"
	) {
		emitCommandOutputDelta(item);
		const itemId = stringField(itemRecord, "id");
		if (itemId) state.commandOutputs.delete(itemId);
		closeTool();
	} else if (
		eventType === "item.started" &&
		itemRecord?.type === "file_change"
	) {
		const paths = getFileChangePaths(ctx, item);
		snapshotPaths(paths);
		const payload = { changes: itemRecord.changes ?? paths };
		ctx.emitStatus("tool:patch", true);
		ctx.emitActivity({
			toolName: "patch",
			summary: summarizeToolEvent("patch", payload),
			isStreaming: true,
		});
		startTool("patch", payload);
	} else if (
		eventType === "item.completed" &&
		itemRecord?.type === "file_change"
	) {
		const paths = getFileChangePaths(ctx, item);
		closeTool();
		emitDiffsForPaths(paths);
	} else if (
		eventType === "item.completed" &&
		itemRecord?.type === "agent_message"
	) {
		const text = stringField(itemRecord, "text") || extractText(item);
		if (text) {
			assistantDelta(text);
			closeAssistant();
			state.lastAssistantMessage = text;
			state.hasFinalAssistantMessage = true;
		}
	} else if (eventType === "agent_message_delta") {
		assistantDelta(firstString(data, ["delta", "text", "content"]));
		ctx.emitStatus("responding", true);
		ctx.emitAgentEvent({ type: "status", status: "responding" });
	} else if (eventType === "agent_message") {
		const content = firstString(data, ["message", "content", "text"]);
		if (content) assistantDelta(content);
	} else if (eventType === "exec_command_begin") {
		const payload = {
			command: firstString(data, ["parsed_cmd", "command", "cmd"]),
			cwd: stringField(data, "cwd") || ctx.cwd,
		};
		ctx.emitStatus("tool:exec", true);
		ctx.emitActivity({
			toolName: "exec",
			summary: summarizeToolEvent("exec", payload),
			isStreaming: true,
		});
		startTool("exec", payload);
	} else if (eventType === "exec_command_output_delta") {
		const encodedChunk = stringField(data, "chunk");
		const chunk = encodedChunk
			? Buffer.from(encodedChunk, "base64").toString("utf8")
			: "";
		toolDelta(chunk);
	} else if (eventType === "exec_command_end") {
		closeTool();
	} else if (eventType === "patch_apply_begin") {
		const paths = getFileChangePaths(ctx, event);
		state.activePatchPaths = paths;
		snapshotPaths(paths);
		const payload = {
			changes:
				arrayField(data, "changes").length > 0
					? arrayField(data, "changes")
					: arrayField(data, "files").length > 0
						? arrayField(data, "files")
						: paths,
		};
		ctx.emitStatus("tool:patch", true);
		ctx.emitActivity({
			toolName: "patch",
			summary: summarizeToolEvent("patch", payload),
			isStreaming: true,
		});
		startTool("patch", payload);
	} else if (eventType === "patch_apply_end") {
		closeTool();
		const paths = getFileChangePaths(ctx, event);
		emitDiffsForPaths(paths.length > 0 ? paths : state.activePatchPaths);
		state.activePatchPaths = [];
	} else if (eventType === "web_search_begin") {
		const payload = { query: stringField(data, "query") };
		ctx.emitStatus("tool:web_search", true);
		ctx.emitActivity({
			toolName: "web_search",
			summary: summarizeToolEvent("web_search", payload),
			isStreaming: true,
		});
		startTool("web_search", payload);
	} else if (eventType === "web_search_end") {
		const query = stringField(data, "query");
		if (query) toolDelta(query);
		closeTool();
	} else if (eventType === "mcp_tool_call_begin") {
		const invocation = asRecord(data.invocation);
		const toolName =
			firstString(invocation, ["tool"]) ||
			stringField(data, "tool") ||
			"mcp_tool";
		const payload = invocation?.arguments ?? data.arguments ?? {};
		ctx.emitStatus(`tool:${toolName}`, true);
		ctx.emitActivity({
			toolName,
			summary: summarizeToolEvent(toolName, payload),
			isStreaming: true,
		});
		startTool(toolName, payload);
	} else if (eventType === "mcp_tool_call_end") {
		closeTool();
	} else if (
		eventType === "item.completed" &&
		itemRecord?.type === "error" &&
		stringField(itemRecord, "message")
	) {
		const message = stringField(itemRecord, "message");
		ctx.emitAgentEvent({ type: "error", message });
		ctx.emitSystemMessage(message);
	} else if (eventType === "item.completed" && item && extractText(item)) {
		const itemText = extractText(item);
		if (!state.sawAssistantStream && itemText) {
			ctx.emitChatEvent({ type: "result", result: itemText });
			ctx.emitAgentEvent({ type: "result", text: itemText });
			state.hasFinalAssistantMessage = true;
		}
	} else if (eventType === "error" && stringField(data, "message")) {
		const message = stringField(data, "message");
		ctx.emitAgentEvent({ type: "error", message });
		ctx.emitSystemMessage(message);
	} else if (eventType === "task_complete") {
		state.completedFromEvent = true;
		const finalText = stringField(data, "last_agent_message");
		if (finalText) {
			state.lastAssistantMessage = finalText;
		}
		if (finalText && !state.sawAssistantStream) {
			ctx.emitChatEvent({
				type: "result",
				result: finalText,
			});
			ctx.emitAgentEvent({ type: "result", text: finalText });
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

const codexAdapter: AgentAdapter<CodexRunState> = {
	kind: "codex",
	displayName: "Codex",

	createState(ctx) {
		const paneFileStem =
			ctx.paneId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "pane";
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
			completedFromEvent: false,
			lastAssistantMessage: "",
			lastChatBlockRole: null,
			currentToolId: null,
			fileSnapshots: new Map(),
			fileWatchers: new Map(),
			activePatchPaths: [],
			commandOutputs: new Map(),
		};
	},

	createHandle(prompt, ctx, state): AgentHandle {
		let proc: ReturnType<typeof Bun.spawn> | null = null;
		const killProcess = () => {
			try {
				if (proc?.pid) PidTracker.killPid(proc.pid);
				else proc?.kill();
			} catch {}
		};

		return {
			async run() {
				const codexCmd = resolveAgentBinary("codex");
				const baseArgs = [
					"--json",
					"--skip-git-repo-check",
					"--dangerously-bypass-approvals-and-sandbox",
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
				const workspaceArgs = getCodexWorkspaceArgs(ctx);
				const args = sessionId
					? [
							codexCmd,
							...workspaceArgs,
							"exec",
							"resume",
							...baseArgs,
							sessionId,
							"--",
							prompt,
						]
					: [codexCmd, ...workspaceArgs, "exec", ...baseArgs, "--", prompt];

				proc = Bun.spawn(args, {
					stdout: "pipe",
					stderr: "pipe",
					cwd: ctx.cwd,
					env: createAgentEnv("codex"),
				});
				if (proc.pid) PidTracker.trackPid(proc.pid);

				const stderrPromise = drainStreamToString(
					proc.stderr as ReadableStream<Uint8Array>
				);
				const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
				const decoder = new TextDecoder();
				let leftover = "";
				let completionStopRequested = false;
				const handleStdoutEvent = (event: unknown) => {
					const eventRecord = asRecord(event);
					const payload = asRecord(eventRecord?.payload);
					handleCodexEvent(
						ctx,
						state,
						eventRecord?.type === "event_msg" && payload?.type ? payload : event
					);
				};

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					leftover += decoder.decode(value, { stream: true });
					leftover = parseNdjsonLines(leftover, handleStdoutEvent);
					if (state.completedFromEvent && !completionStopRequested) {
						completionStopRequested = true;
						killProcess();
					}
				}
				flushNdjsonLeftover(leftover, handleStdoutEvent);

				const exitCode = await proc.exited;
				if (proc.pid) PidTracker.untrackPid(proc.pid);
				proc = null;
				const stderrText = (await stderrPromise).trim();
				for (const watcher of state.fileWatchers.values())
					clearInterval(watcher);
				state.fileWatchers.clear();

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
					(!state.hasFinalAssistantMessage ||
						state.lastChatBlockRole !== "assistant")
				) {
					ctx.emitChatEvent({
						type: "result",
						result: assistantText,
					});
					ctx.emitAgentEvent({ type: "result", text: assistantText });
					state.hasFinalAssistantMessage = true;
					state.lastChatBlockRole = "assistant";
				} else if (
					exitCode !== 0 &&
					stderrText &&
					!state.completedFromEvent &&
					!ctx.isCancelled()
				) {
					ctx.emitAgentEvent({ type: "error", message: stderrText });
					ctx.emitSystemMessage(stderrText);
				}
				const finishReason = ctx.isCancelled()
					? "cancelled"
					: exitCode === 0 || state.completedFromEvent
						? "completed"
						: `exit:${exitCode}`;
				ctx.emitAgentEvent({ type: "finish", reason: finishReason });

				return { lastAssistantMessage: state.lastAssistantMessage };
			},

			stop: killProcess,
			kill: killProcess,
		};
	},
};

const adapters: Record<ChatAgentKind, AgentAdapter<any>> = {
	claude: claudeAdapter,
	codex: codexAdapter,
};

export function getAgentAdapter(kind: ChatAgentKind): AgentAdapter<any> {
	return adapters[kind];
}

export function resolveAgentModel(
	agentKind: ChatAgentKind,
	requestedModel?: string
): string | undefined {
	const definition = getAgentDefinition(agentKind);
	if (!definition.models.length) return undefined;
	if (
		requestedModel &&
		definition.models.some(hasId.bind(null, requestedModel))
	) {
		return requestedModel;
	}
	return definition.defaultModel || definition.models[0]?.id;
}
