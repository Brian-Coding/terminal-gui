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
const CHAT_CACHE_DB = "inferay-chat-cache";
const CHAT_CONVERSATIONS_STORE = "conversations";
const CHAT_MESSAGES_STORE = "messages";
const pendingSummaryRequests = new Set<string>();
const pendingQueueFileSaves = new Map<
	string,
	{ queue: unknown[]; inFlight: boolean }
>();
let chatCacheDbPromise: Promise<IDBDatabase | null> | null = null;

type DbPreference = {
	id: string;
	valueJson: string;
	updatedAt: number;
};

const preferencesCollection = createCollection(
	localStorageCollectionOptions<DbPreference, string>({
		storageKey: "inferay-db-preferences",
		getKey: (preference) => preference.id,
	})
);

for (const staleChatDbKey of [
	"inferay-db-conversations",
	"inferay-db-messages",
]) {
	removeStoredValue(staleChatDbKey);
}

function openChatCacheDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return Promise.resolve(null);
	chatCacheDbPromise ??= new Promise((resolve) => {
		const request = indexedDB.open(CHAT_CACHE_DB, 2);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(CHAT_CONVERSATIONS_STORE)) {
				db.createObjectStore(CHAT_CONVERSATIONS_STORE, { keyPath: "paneId" });
			}
			if (!db.objectStoreNames.contains(CHAT_MESSAGES_STORE)) {
				const messages = db.createObjectStore(CHAT_MESSAGES_STORE, {
					keyPath: "storageId",
				});
				messages.createIndex("paneOrder", ["paneId", "order"]);
				messages.createIndex("paneId", "paneId");
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(null);
		request.onblocked = () => resolve(null);
	});
	return chatCacheDbPromise;
}

async function readIndexedChatMessages<T>(paneId: string): Promise<T[]> {
	const db = await openChatCacheDb();
	if (!db) return [];
	return new Promise((resolve) => {
		const tx = db.transaction(CHAT_MESSAGES_STORE, "readonly");
		const index = tx.objectStore(CHAT_MESSAGES_STORE).index("paneOrder");
		const range = IDBKeyRange.bound([paneId, -Infinity], [paneId, Infinity]);
		const request = index.getAll(range);
		request.onsuccess = () => {
			const rows = Array.isArray(request.result) ? request.result : [];
			resolve(rows.map((row) => (row as { message: T }).message));
		};
		request.onerror = () => resolve([]);
	});
}

async function writeIndexedChatMessages<T>(
	paneId: string,
	messages: T[]
): Promise<void> {
	const db = await openChatCacheDb();
	if (!db) return;
	await new Promise<void>((resolve) => {
		const tx = db.transaction(
			[CHAT_CONVERSATIONS_STORE, CHAT_MESSAGES_STORE],
			"readwrite"
		);
		tx.objectStore(CHAT_CONVERSATIONS_STORE).put({
			paneId,
			messageCount: messages.length,
			updatedAt: Date.now(),
		});
		const messageStore = tx.objectStore(CHAT_MESSAGES_STORE);
		const paneIndex = messageStore.index("paneId");
		const existingRequest = paneIndex.getAllKeys(paneId);
		existingRequest.onsuccess = () => {
			const nextIds = new Set<string>();
			for (let order = 0; order < messages.length; order++) {
				const message = messages[order] as { id?: unknown };
				if (typeof message.id !== "string") continue;
				const storageId = `${paneId}:${message.id}`;
				nextIds.add(storageId);
				messageStore.put({
					storageId,
					paneId,
					messageId: message.id,
					order,
					message,
				});
			}
			for (const key of existingRequest.result) {
				if (typeof key === "string" && !nextIds.has(key)) {
					messageStore.delete(key);
				}
			}
		};
		tx.oncomplete = () => resolve();
		tx.onerror = () => resolve();
		tx.onabort = () => resolve();
	});
}

async function deleteIndexedChatMessages(paneId: string): Promise<void> {
	const db = await openChatCacheDb();
	if (!db) return;
	await new Promise<void>((resolve) => {
		const tx = db.transaction(
			[CHAT_CONVERSATIONS_STORE, CHAT_MESSAGES_STORE],
			"readwrite"
		);
		tx.objectStore(CHAT_CONVERSATIONS_STORE).delete(paneId);
		const messageStore = tx.objectStore(CHAT_MESSAGES_STORE);
		const request = messageStore.index("paneId").getAllKeys(paneId);
		request.onsuccess = () => {
			for (const key of request.result) messageStore.delete(key);
		};
		tx.oncomplete = () => resolve();
		tx.onerror = () => resolve();
		tx.onabort = () => resolve();
	});
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

export function loadStoredMessages<T>(paneId: string): T[] {
	return readPaneJson(STORAGE_KEY_PREFIX, paneId, []);
}

export function loadStoredMessagesAsync<T>(paneId: string): Promise<T[]> {
	return readIndexedChatMessages<T>(paneId);
}

export function saveStoredMessages<T>(paneId: string, messages: T[]) {
	void writeIndexedChatMessages(paneId, messages);
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
	void deleteIndexedChatMessages(paneId);
	saveStoredQueue(paneId, []);
}
