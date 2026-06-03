import { createCollection, localStorageCollectionOptions } from "@tanstack/db";
import { flushPendingClientStorageSync } from "../../lib/client-storage-sync.ts";
import { isString, noop } from "../../lib/data.ts";
import { fetchJsonOr, sendJson } from "../../lib/fetch-json.ts";
import {
	readStoredJson,
	readStoredValue,
	removeStoredValue,
	writeStoredJson,
	writeStoredValue,
} from "../../lib/stored-json.ts";

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
const LOADING_STATE_KEY_PREFIX = "inferay-chat-loading-";
const LOADING_STATE_TTL_MS = 6 * 60 * 60 * 1000;

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
	role: "user" | "assistant" | "tool" | "system" | "btw";
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

type DbPendingMutation = {
	id: string;
	collectionId: string;
	mutationJson: string;
	createdAt: number;
	lastAttemptAt: number | null;
	status: "pending" | "error";
	error: string | null;
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
const pendingMutationsCollection = createCollection(
	localStorageCollectionOptions<DbPendingMutation, string>({
		storageKey: "inferay-db-pending-mutations",
		getKey: (mutation) => mutation.id,
	})
);

export interface StoredLoadingState {
	isLoading: boolean;
	status: string;
	startTime: number | null;
}

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

function savePreference(id: string, value: unknown) {
	const row = { id, valueJson: JSON.stringify(value), updatedAt: Date.now() };
	if (preferencesCollection.get(id)) {
		preferencesCollection.update(id, (draft) => Object.assign(draft, row));
	} else {
		preferencesCollection.insert(row);
	}
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
		status: "idle" as const,
		syncState: "pending" as const,
	};
	if (conversationsCollection.get(conversation.id)) {
		conversationsCollection.update(conversation.id, (draft) => {
			draft.agentKind = agentKind;
			draft.updatedAt = now;
			draft.status = messages.some((message) => message.isStreaming)
				? "streaming"
				: "idle";
			draft.syncState = "pending";
		});
	} else {
		conversationsCollection.insert(conversation);
	}
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const row = {
			id: message.id,
			conversationId: conversation.id,
			role: message.role,
			content: message.content,
			toolName: message.toolName ?? null,
			partsJson: JSON.stringify(message),
			artifactsJson: null,
			imagesJson: message.images?.length
				? JSON.stringify(message.images)
				: null,
			isStreaming: !!message.isStreaming,
			createdAt: now + index,
			updatedAt: now,
			syncState: "pending" as const,
		};
		if (messagesCollection.get(row.id)) {
			messagesCollection.update(row.id, (draft) => Object.assign(draft, row));
		} else {
			messagesCollection.insert(row);
		}
	}
	pendingMutationsCollection.insert({
		id: `messages-${paneId}-${now}`,
		collectionId: "messages",
		mutationJson: JSON.stringify({
			paneId,
			messageIds: messages.map((m) => m.id),
		}),
		createdAt: now,
		lastAttemptAt: null,
		status: "pending",
		error: null,
	});
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

export function clearStoredCheckpoints(paneId: string) {
	removePaneValue(CHECKPOINT_KEY_PREFIX, paneId);
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

export function loadStoredSummary(paneId: string): string | null {
	return loadPreference(
		storageKey(SUMMARY_KEY_PREFIX, paneId),
		readPaneValue(SUMMARY_KEY_PREFIX, paneId)
	);
}

export function saveStoredSummary(paneId: string, summary: string) {
	writePaneValue(SUMMARY_KEY_PREFIX, paneId, summary);
	savePreference(storageKey(SUMMARY_KEY_PREFIX, paneId), summary);
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
	return loadPreference(
		storageKey(QUEUE_KEY_PREFIX, paneId),
		readPaneJson(QUEUE_KEY_PREFIX, paneId, [])
	);
}

export async function loadFileBackedQueue<T>(paneId: string): Promise<T[]> {
	const response = await fetchJsonOr<{ queue?: unknown[] }>(
		`/api/chat-queues/${encodeURIComponent(paneId)}`,
		{ queue: [] }
	);
	return Array.isArray(response.queue) ? (response.queue as T[]) : [];
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

export function saveStoredQueue<T>(paneId: string, queue: T[]) {
	if (queue.length === 0) removePaneValue(QUEUE_KEY_PREFIX, paneId);
	else writePaneJson(QUEUE_KEY_PREFIX, paneId, queue);
	savePreference(storageKey(QUEUE_KEY_PREFIX, paneId), queue);
	saveFileBackedQueue(paneId, queue).catch(noop);
	flushPendingClientStorageSync();
}

export function loadStoredLoadingState(
	paneId: string
): StoredLoadingState | null {
	const parsed = readPaneJson<Partial<StoredLoadingState> | null>(
		LOADING_STATE_KEY_PREFIX,
		paneId,
		null
	);
	if (!parsed?.isLoading || typeof parsed.status !== "string") return null;
	if (
		typeof parsed.startTime !== "number" ||
		Date.now() - parsed.startTime > LOADING_STATE_TTL_MS
	) {
		return null;
	}
	return {
		isLoading: true,
		status: parsed.status,
		startTime: parsed.startTime,
	};
}

export function saveStoredLoadingState(
	paneId: string,
	state: StoredLoadingState
) {
	if (!state.isLoading || !state.startTime) {
		removePaneValue(LOADING_STATE_KEY_PREFIX, paneId);
		return;
	}
	writePaneJson(LOADING_STATE_KEY_PREFIX, paneId, state);
	savePreference(storageKey(LOADING_STATE_KEY_PREFIX, paneId), state);
}

export function clearStoredLoadingState(paneId: string) {
	removePaneValue(LOADING_STATE_KEY_PREFIX, paneId);
}

export function clearAgentChatMessages(paneId: string) {
	clearPaneConversation(paneId);
	for (const prefix of [
		STORAGE_KEY_PREFIX,
		SESSION_KEY_PREFIX,
		INPUT_KEY_PREFIX,
		SUMMARY_KEY_PREFIX,
		PENDING_WORKSPACE_KEY_PREFIX,
		QUEUE_KEY_PREFIX,
		LOADING_STATE_KEY_PREFIX,
	]) {
		removePaneValue(prefix, paneId);
	}
}
