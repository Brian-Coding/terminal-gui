import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AgentHandle } from "../types.ts";

export const claudeAdapter: AgentAdapter<undefined> = {
	kind: "claude",
	displayName: "Claude",

	createState() {
		return undefined;
	},

	createHandle(prompt, ctx): AgentHandle {
		const abortController = new AbortController();

		const env = { ...process.env };
		delete env.CLAUDECODE;

		const sessionId = ctx.getSessionId();

		return {
			async run() {
				const q = query({
					prompt,
					options: {
						cwd: ctx.cwd,
						permissionMode: "bypassPermissions",
						allowDangerouslySkipPermissions: true,
						includePartialMessages: true,
						abortController,
						env,
						...(sessionId ? { resume: sessionId } : {}),
					},
				});

				try {
					let knownSessionId = sessionId;
					for await (const event of q) {
						const e = event as any;

						// Extract session ID (only update when new)
						if (e.session_id && e.session_id !== knownSessionId) {
							knownSessionId = e.session_id;
							ctx.updateSessionId(e.session_id);
						}

						if (e.type === "system" && e.subtype === "init") {
							// Init event handled above for session_id
							continue;
						}

						if (e.type === "stream_event" && e.event) {
							// Forward inner streaming event (content_block_start/delta/stop)
							ctx.emitChatEvent(e.event);
						} else if (e.type === "assistant") {
							// Full assistant message
							ctx.emitChatEvent({
								type: "assistant",
								message: e.message,
							});
						} else if (e.type === "result") {
							ctx.emitChatEvent({
								type: "result",
								result: e.result,
								session_id: e.session_id,
							});
						}
					}
				} catch (err: any) {
					if (err.name === "AbortError") return;
					const msg = err.message || "Claude encountered an error";
					ctx.emitSystemMessage(msg);
				}
			},

			stop() {
				abortController.abort();
			},

			kill() {
				abortController.abort();
			},
		};
	},
};
