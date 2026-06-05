import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { userDataPath } from "../../lib/user-data.ts";

const CHAT_EVENTS_DIR = "chat-events";

export interface ChatEventLogEntry {
	paneId: string;
	sequence: number;
	timestamp: number;
	type: string;
	payload: unknown;
}

const eventSequenceByPane = new Map<string, number>();
const pendingEventWrites = new Map<string, Promise<void>>();

function eventPath(paneId: string): string {
	return userDataPath(CHAT_EVENTS_DIR, `${paneId}.jsonl`);
}

function nextEventSequence(paneId: string): number {
	const floor = Date.now() * 1000;
	const previous = eventSequenceByPane.get(paneId) ?? 0;
	const next = Math.max(floor, previous + 1);
	eventSequenceByPane.set(paneId, next);
	return next;
}

export function appendChatEvent(
	paneId: string,
	type: string,
	payload: unknown
): number {
	const sequence = nextEventSequence(paneId);
	const entry: ChatEventLogEntry = {
		paneId,
		sequence,
		timestamp: Date.now(),
		type,
		payload,
	};
	const path = eventPath(paneId);
	const previous = pendingEventWrites.get(paneId) ?? Promise.resolve();
	const nextWrite = previous
		.catch(() => {})
		.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, `${JSON.stringify(entry)}\n`);
		})
		.catch((error) => {
			console.error("[ChatEvents] Failed to append chat event:", error);
		});
	pendingEventWrites.set(paneId, nextWrite);
	return sequence;
}

export async function readChatEvents(
	paneId: string,
	afterSequence = 0,
	limit = 500
): Promise<ChatEventLogEntry[]> {
	const file = Bun.file(eventPath(paneId));
	if (!(await file.exists())) return [];
	const text = await file.text();
	const events: ChatEventLogEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as ChatEventLogEntry;
			if (
				entry.paneId === paneId &&
				entry.sequence > afterSequence &&
				events.length < limit
			) {
				events.push(entry);
			}
		} catch {}
	}
	return events;
}
