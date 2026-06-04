import { createCollection, localStorageCollectionOptions } from "@tanstack/db";
import { hasRole, isString, noop } from "../../lib/data.ts";
import { postJson, sendJson } from "../../lib/fetch-json.ts";
import {
	readStoredJson,
	readStoredValue,
	removeStoredValue,
	writeStoredJson,
	writeStoredValue,
} from "../../lib/stored-json.ts";
import type { ChatMessage } from "./agent-chat-shared.ts";

const STORAGE_KEY_PREFIX = "inferay-chat-";
const SESSION_KEY_PREFIX = "inferay-chat-session-";
const INPUT_KEY_PREFIX = "inferay-chat-input-";
const CHECKPOINT_KEY_PREFIX = "inferay-checkpoints-";
const MODEL_KEY_PREFIX = "inferay-chat-model-";
const REASONING_KEY_PREFIX = "inferay-chat-reasoning-";
const PENDING_SEND_KEY_PREFIX = "inferay-chat-pending-send-";
const SUMMARY_KEY_PREFIX = "inferay-chat-summary-";
const PENDING_WORKSPACE_KEY_PREFIX = "inferay-chat-pending-workspace-";
const QUEUE_KEY_PREFIX = "inferay-chat-queue-";
const pendingSummaryRequests = new Set<string>();
const pendingQueueFileSaves = new Map<
	string,
	{ queue: unknown[]; inFlight: boolean }
>();

type DbConversation = {
	id: string;
	paneId: string;
	agentKind: string;
	title: string | null;
	cwd: string | null;
	createdAt: number;
	updatedAt: number;
	status: "idle" | "streaming" | "error";
	syncState: "local" | "pending" | "synced" | "error";
};

type DbMessage = {
	id: string;
	conversationId: string;
	role: ChatMessage["role"];
	content: string;
	toolName: string | null;
	partsJson: string | null;
	artifactsJson: string | null;
	imagesJson: string | null;
	isStreaming: boolean;
	createdAt: number;
	updatedAt: number;
	syncState: "local" | "pending" | "synced" | "error";
};

type DbPreference = {
	id: string;
	valueJson: string;
	updatedAt: number;
};

const conversationsCollection = createCollection(
	localStorageCollectionOptions<DbConversation, string>({
		storageKey: "inferay-db-conversations",
		getKey: (conversation) => conversation.id,
	})
);
const messagesCollection = createCollection(
	localStorageCollectionOptions<DbMessage, string>({
		storageKey: "inferay-db-messages",
		getKey: (message) => message.id,
	})
);
const preferencesCollection = createCollection(
	localStorageCollectionOptions<DbPreference, string>({
		storageKey: "inferay-db-preferences",
		getKey: (preference) => preference.id,
	})
);

function storageKey(prefix: string, paneId: string): string {
	return prefix + paneId;
}

function readPaneJson<T>(prefix: string, paneId: string, fallback: T): T {
	return readStoredJson(storageKey(prefix, paneId), fallback);
}

function writePaneJson<T>(prefix: string, paneId: string, value: T) {
	writeStoredJson(storageKey(prefix, paneId), value);
}

function readPaneValue(
	prefix: string,
	paneId: string,
	fallback: string | null = null
): string | null {
	return readStoredValue(storageKey(prefix, paneId), fallback);
}

function writePaneValue(prefix: string, paneId: string, value: string | null) {
	if (value) writeStoredValue(storageKey(prefix, paneId), value);
	else removePaneValue(prefix, paneId);
}

function removePaneValue(prefix: string, paneId: string) {
	removeStoredValue(storageKey(prefix, paneId));
}

function loadPreference<T>(id: string, fallback: T): T {
	const value = preferencesCollection.get(id)?.valueJson;
	return value ? JSON.parse(value) : fallback;
}

function messageStorageId(conversationId: string, messageId: string) {
	return `${conversationId}:${messageId}`;
}

function getStoredMessageId(message: DbMessage): string {
	if (message.partsJson) {
		try {
			const parsed = JSON.parse(message.partsJson) as { id?: unknown };
			if (typeof parsed.id === "string" && parsed.id) return parsed.id;
		} catch {}
	}
	const prefix = `${message.conversationId}:`;
	return message.id.startsWith(prefix)
		? message.id.slice(prefix.length)
		: message.id;
}

function dedupeMessagesById<
	T extends {
		id: string;
	},
>(messages: T[]) {
	const byId = new Map<string, T>();
	for (const message of messages) {
		if (byId.has(message.id)) byId.delete(message.id);
		byId.set(message.id, message);
	}
	return [...byId.values()];
}

function savePreference(id: string, value: unknown) {
	const valueJson = JSON.stringify(value);
	const existing = preferencesCollection.get(id);
	if (existing?.valueJson === valueJson) return;
	const row = { id, valueJson, updatedAt: Date.now() };
	if (existing) {
		preferencesCollection.update(id, (draft) => Object.assign(draft, row));
	} else {
		preferencesCollection.insert(row);
	}
}

function removePreference(id: string) {
	if (preferencesCollection.get(id)) preferencesCollection.delete(id);
}

function loadPaneMessages<T extends { id: string }>(paneId: string): T[] {
	const conversation = conversationsCollection.toArray
		.filter((item) => item.paneId === paneId)
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];
	if (!conversation) return [];
	return messagesCollection.toArray
		.filter((message) => message.conversationId === conversation.id)
		.sort((a, b) => a.createdAt - b.createdAt)
		.map((message) =>
			message.partsJson
				? { ...JSON.parse(message.partsJson), isStreaming: false }
				: {
						id: message.id,
						role: message.role,
						content: message.content,
						toolName: message.toolName ?? undefined,
						isStreaming: false,
						images: message.imagesJson
							? JSON.parse(message.imagesJson)
							: undefined,
					}
		) as unknown as T[];
}

function savePaneMessages<
	T extends {
		id: string;
		role: DbMessage["role"];
		content: string;
		toolName?: string;
		isStreaming?: boolean;
		images?: string[];
	},
>(paneId: string, messages: T[], agentKind = "codex") {
	const now = Date.now();
	const status = messages.some((message) => message.isStreaming)
		? "streaming"
		: "idle";
	const conversation = conversationsCollection.toArray.find(
		(item) => item.paneId === paneId
	) ?? {
		id: paneId,
		paneId,
		agentKind,
		title: null,
		cwd: null,
		createdAt: now,
		updatedAt: now,
		status,
		syncState: "pending" as const,
	};
	if (conversationsCollection.get(conversation.id)) {
		if (
			conversation.agentKind !== agentKind ||
			conversation.status !== status ||
			conversation.syncState !== "pending"
		) {
			conversationsCollection.update(conversation.id, (draft) => {
				draft.agentKind = agentKind;
				draft.updatedAt = now;
				draft.status = status;
				draft.syncState = "pending";
			});
		}
	} else {
		conversationsCollection.insert(conversation);
	}
	const existingRows = new Map(
		messagesCollection.toArray
			.filter((message) => message.conversationId === conversation.id)
			.map((message) => [getStoredMessageId(message), message])
	);
	const dedupedMessages = dedupeMessagesById(messages);
	const nextIds = new Set<string>();
	for (let index = 0; index < dedupedMessages.length; index++) {
		const message = dedupedMessages[index]!;
		nextIds.add(message.id);
		const partsJson = JSON.stringify(message);
		const imagesJson = message.images?.length
			? JSON.stringify(message.images)
			: null;
		const existing = existingRows.get(message.id);
		const rowId = existing?.id ?? messageStorageId(conversation.id, message.id);
		const row = {
			id: rowId,
			conversationId: conversation.id,
			role: message.role,
			content: message.content,
			toolName: message.toolName ?? null,
			partsJson,
			artifactsJson: null,
			imagesJson,
			isStreaming: !!message.isStreaming,
			createdAt: existing?.createdAt ?? now + index,
			updatedAt: now,
			syncState: "pending" as const,
		};
		if (existing || messagesCollection.get(rowId)) {
			const current = existing ?? messagesCollection.get(rowId)!;
			if (
				current.conversationId === row.conversationId &&
				current.role === row.role &&
				current.content === row.content &&
				current.toolName === row.toolName &&
				current.partsJson === row.partsJson &&
				current.imagesJson === row.imagesJson &&
				current.isStreaming === row.isStreaming &&
				current.syncState === row.syncState
			) {
				continue;
			}
			messagesCollection.update(rowId, (draft) => Object.assign(draft, row));
		} else {
			messagesCollection.insert(row);
		}
	}
	for (const row of existingRows.values()) {
		if (!nextIds.has(getStoredMessageId(row)))
			messagesCollection.delete(row.id);
	}
}

function clearPaneConversation(paneId: string) {
	for (const conversation of conversationsCollection.toArray.filter(
		(item) => item.paneId === paneId
	)) {
		for (const message of messagesCollection.toArray.filter(
			(item) => item.conversationId === conversation.id
		)) {
			messagesCollection.delete(message.id);
		}
		conversationsCollection.delete(conversation.id);
	}
}

export function loadStoredMessages<T>(paneId: string): T[] {
	const messages = loadPaneMessages<T & { id: string }>(paneId);
	return messages.length > 0
		? messages
		: readPaneJson(STORAGE_KEY_PREFIX, paneId, []);
}

export function saveStoredMessages<T>(paneId: string, messages: T[]) {
	writePaneJson(STORAGE_KEY_PREFIX, paneId, messages);
	savePaneMessages(paneId, messages as Parameters<typeof savePaneMessages>[1]);
}

export function loadStoredInput(paneId: string): string {
	return loadPreference(
		storageKey(INPUT_KEY_PREFIX, paneId),
		readPaneValue(INPUT_KEY_PREFIX, paneId, "") ?? ""
	);
}

export function saveStoredInput(paneId: string, value: string) {
	writePaneValue(INPUT_KEY_PREFIX, paneId, value);
	savePreference(storageKey(INPUT_KEY_PREFIX, paneId), value);
}

export function loadPendingSend(paneId: string): string {
	return loadPreference(
		storageKey(PENDING_SEND_KEY_PREFIX, paneId),
		readPaneValue(PENDING_SEND_KEY_PREFIX, paneId, "") ?? ""
	);
}

export function savePendingSend(paneId: string, value: string) {
	writePaneValue(PENDING_SEND_KEY_PREFIX, paneId, value);
	savePreference(storageKey(PENDING_SEND_KEY_PREFIX, paneId), value);
}

export function clearPendingSend(paneId: string) {
	removePaneValue(PENDING_SEND_KEY_PREFIX, paneId);
	removePreference(storageKey(PENDING_SEND_KEY_PREFIX, paneId));
}

export function loadStoredCheckpoints<T>(paneId: string): T[] {
	return loadPreference(
		storageKey(CHECKPOINT_KEY_PREFIX, paneId),
		readPaneJson(CHECKPOINT_KEY_PREFIX, paneId, [])
	);
}

export function saveStoredCheckpoints<T>(paneId: string, checkpoints: T[]) {
	writePaneJson(CHECKPOINT_KEY_PREFIX, paneId, checkpoints);
	savePreference(storageKey(CHECKPOINT_KEY_PREFIX, paneId), checkpoints);
}

export function loadStoredSessionId(paneId: string): string | null {
	return loadPreference(
		storageKey(SESSION_KEY_PREFIX, paneId),
		readPaneValue(SESSION_KEY_PREFIX, paneId)
	);
}

export function saveStoredSessionId(paneId: string, sessionId: string) {
	writePaneValue(SESSION_KEY_PREFIX, paneId, sessionId);
	savePreference(storageKey(SESSION_KEY_PREFIX, paneId), sessionId);
}

export function clearStoredSessionId(paneId: string) {
	removePaneValue(SESSION_KEY_PREFIX, paneId);
	removePreference(storageKey(SESSION_KEY_PREFIX, paneId));
}

export function loadStoredModel(paneId: string): string | null {
	return loadPreference(
		storageKey(MODEL_KEY_PREFIX, paneId),
		readPaneValue(MODEL_KEY_PREFIX, paneId)
	);
}

export function saveStoredModel(paneId: string, modelId: string) {
	writePaneValue(MODEL_KEY_PREFIX, paneId, modelId);
	savePreference(storageKey(MODEL_KEY_PREFIX, paneId), modelId);
}

export function loadStoredReasoningLevel(paneId: string): string | null {
	return loadPreference(
		storageKey(REASONING_KEY_PREFIX, paneId),
		readPaneValue(REASONING_KEY_PREFIX, paneId)
	);
}

export function saveStoredReasoningLevel(
	paneId: string,
	reasoningLevel: string
) {
	writePaneValue(REASONING_KEY_PREFIX, paneId, reasoningLevel);
	savePreference(storageKey(REASONING_KEY_PREFIX, paneId), reasoningLevel);
}

function loadStoredSummary(paneId: string): string | null {
	return loadPreference(
		storageKey(SUMMARY_KEY_PREFIX, paneId),
		readPaneValue(SUMMARY_KEY_PREFIX, paneId)
	);
}

function saveStoredSummary(paneId: string, summary: string) {
	writePaneValue(SUMMARY_KEY_PREFIX, paneId, summary);
	savePreference(storageKey(SUMMARY_KEY_PREFIX, paneId), summary);
}

export function deriveStoredSummary(
	paneId: string,
	messages = loadStoredMessages<{ role: string; content: string }>(paneId),
	onStored?: () => void
): string | null {
	const existing = loadStoredSummary(paneId);
	if (existing) return existing;
	const firstUser = messages.find(hasRole.bind(null, "user"));
	if (!firstUser?.content) return null;
	if (!pendingSummaryRequests.has(paneId)) {
		pendingSummaryRequests.add(paneId);
		postJson<{ title?: string }>("/api/generate-title", {
			message: firstUser.content,
		})
			.then((data) => {
				const title = data?.title?.trim();
				if (!title) return;
				saveStoredSummary(paneId, title);
				onStored?.();
			})
			.catch(noop)
			.finally(() => pendingSummaryRequests.delete(paneId));
	}
	const text = firstUser.content.trim().split("\n")[0] ?? "";
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function loadPendingWorkspacePaths(paneId: string): string[] {
	const parsed = readPaneJson<unknown>(
		PENDING_WORKSPACE_KEY_PREFIX,
		paneId,
		[]
	);
	return Array.isArray(parsed) ? parsed.filter(isString) : [];
}

export function savePendingWorkspacePaths(paneId: string, paths: string[]) {
	if (paths.length === 0) removePaneValue(PENDING_WORKSPACE_KEY_PREFIX, paneId);
	else writePaneJson(PENDING_WORKSPACE_KEY_PREFIX, paneId, paths);
	savePreference(storageKey(PENDING_WORKSPACE_KEY_PREFIX, paneId), paths);
}

export function loadStoredQueue<T>(paneId: string): T[] {
	const directQueue = readPaneJson<T[] | null>(QUEUE_KEY_PREFIX, paneId, null);
	return (
		directQueue ?? loadPreference(storageKey(QUEUE_KEY_PREFIX, paneId), [])
	);
}

export async function loadFileBackedQueue<T>(
	paneId: string
): Promise<T[] | null> {
	try {
		const response = await fetch(
			`/api/chat-queues/${encodeURIComponent(paneId)}`
		);
		if (!response.ok) return null;
		const payload = (await response.json()) as { queue?: unknown };
		return Array.isArray(payload.queue) ? (payload.queue as T[]) : null;
	} catch {
		return null;
	}
}

async function saveFileBackedQueue<T>(
	paneId: string,
	queue: T[]
): Promise<void> {
	if (queue.length === 0) {
		await fetch(`/api/chat-queues/${encodeURIComponent(paneId)}`, {
			method: "DELETE",
		});
		return;
	}
	await sendJson(
		`/api/chat-queues/${encodeURIComponent(paneId)}`,
		{ queue },
		{ method: "PUT" }
	);
}

async function flushQueuedFileSave(
	paneId: string,
	state: { queue: unknown[]; inFlight: boolean }
) {
	state.inFlight = true;
	while (pendingQueueFileSaves.get(paneId) === state) {
		const queue = state.queue;
		try {
			await saveFileBackedQueue(paneId, queue);
		} catch {
			pendingQueueFileSaves.delete(paneId);
			break;
		}
		if (state.queue === queue) {
			pendingQueueFileSaves.delete(paneId);
			break;
		}
	}
	state.inFlight = false;
}

function saveLatestFileBackedQueue(paneId: string, queue: unknown[]) {
	const state = pendingQueueFileSaves.get(paneId) ?? {
		queue,
		inFlight: false,
	};
	state.queue = queue;
	pendingQueueFileSaves.set(paneId, state);
	if (!state.inFlight) void flushQueuedFileSave(paneId, state);
}

export function saveStoredQueue<T>(paneId: string, queue: T[]) {
	if (queue.length === 0) removePaneValue(QUEUE_KEY_PREFIX, paneId);
	else writePaneJson(QUEUE_KEY_PREFIX, paneId, queue);
	savePreference(storageKey(QUEUE_KEY_PREFIX, paneId), queue);
	saveLatestFileBackedQueue(paneId, queue);
}

export function clearAgentChatPaneState(paneId: string) {
	clearPaneConversation(paneId);
	for (const prefix of [
		STORAGE_KEY_PREFIX,
		SESSION_KEY_PREFIX,
		INPUT_KEY_PREFIX,
		SUMMARY_KEY_PREFIX,
		PENDING_WORKSPACE_KEY_PREFIX,
	]) {
		removePaneValue(prefix, paneId);
		removePreference(storageKey(prefix, paneId));
	}
	saveStoredQueue(paneId, []);
}
