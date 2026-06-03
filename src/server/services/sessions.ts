import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { userDataPath } from "../../lib/user-data.ts";
import { readChatTranscript } from "./chat-transcripts.ts";
import { readTerminalState } from "./terminal-state.ts";

const CHAT_TRANSCRIPTS_DIR = userDataPath("chat-transcripts");

interface TerminalPaneSnapshot {
	id?: unknown;
	title?: unknown;
	agentKind?: unknown;
	cwd?: unknown;
	pendingCwd?: unknown;
}

export interface LocalSessionInfo {
	paneId: string;
	title: string;
	agentKind: "claude" | "codex";
	cwd: string | null;
	messageCount: number;
	lastMessage: string | null;
	lastRole: string | null;
	updatedAt: number;
	inCurrentWorkspace: boolean;
}

export async function listLocalSessions(): Promise<LocalSessionInfo[]> {
	const paneMetadata = await readPaneMetadata();
	const files = await readdir(CHAT_TRANSCRIPTS_DIR).catch(() => []);
	const sessions: LocalSessionInfo[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const paneId = file.slice(0, -".json".length);
		const transcript = await readChatTranscript(paneId);
		if (!transcript?.length) continue;
		const fileStat = await stat(join(CHAT_TRANSCRIPTS_DIR, file)).catch(
			() => null
		);
		const pane = paneMetadata.get(paneId);
		const cwd = pane?.cwd ?? inferCwdFromMessages(transcript);
		const lastMessage = transcript.at(-1) ?? null;
		sessions.push({
			paneId,
			title: pane?.title ?? (cwd ? basename(cwd) : "Archived session"),
			agentKind: pane?.agentKind ?? "codex",
			cwd,
			messageCount: transcript.length,
			lastMessage: lastMessage?.content?.trim() || null,
			lastRole: lastMessage?.role ?? null,
			updatedAt: fileStat?.mtimeMs ?? 0,
			inCurrentWorkspace: paneMetadata.has(paneId),
		});
	}
	return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readPaneMetadata(): Promise<Map<string, LocalSessionInfo>> {
	const state = await readTerminalState<any | null>(null);
	const metadata = new Map<string, LocalSessionInfo>();
	for (const group of state?.groups ?? []) {
		for (const pane of group.panes ?? []) {
			const value = pane as TerminalPaneSnapshot;
			if (typeof value.id !== "string") continue;
			const cwd = typeof value.cwd === "string" ? value.cwd : null;
			metadata.set(value.id, {
				paneId: value.id,
				title:
					typeof value.title === "string"
						? value.title
						: cwd
							? basename(cwd)
							: "Archived session",
				agentKind: value.agentKind === "claude" ? "claude" : "codex",
				cwd,
				messageCount: 0,
				lastMessage: null,
				lastRole: null,
				updatedAt: 0,
				inCurrentWorkspace: true,
			});
		}
	}
	return metadata;
}

function inferCwdFromMessages(
	messages: Array<{ content: string; role: string }>
): string | null {
	for (const message of messages) {
		if (message.role !== "tool") continue;
		try {
			const parsed = JSON.parse(message.content);
			if (typeof parsed?.cwd === "string") return parsed.cwd;
		} catch {}
	}
	return null;
}
