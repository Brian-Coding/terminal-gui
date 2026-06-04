import { expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

function installBrowserStorage() {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url: "http://localhost/#/terminal",
	});
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document"
	);
	const previousLocalStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: dom.window.document,
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: dom.window.localStorage,
	});
	return () => {
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else delete (globalThis as { window?: unknown }).window;
		if (previousDocument)
			Object.defineProperty(globalThis, "document", previousDocument);
		else delete (globalThis as { document?: unknown }).document;
		if (previousLocalStorage)
			Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
		else delete (globalThis as { localStorage?: unknown }).localStorage;
	};
}

test("chat message storage namespaces server ids by pane", async () => {
	const restoreBrowserStorage = installBrowserStorage();
	try {
		const { loadStoredMessages, saveStoredMessages } =
			await import("../src/features/chat/chat-session-store.ts");

		saveStoredMessages("pane-a", [
			{ id: "s3", role: "assistant", content: "first pane" },
		]);
		saveStoredMessages("pane-b", [
			{ id: "s3", role: "assistant", content: "second pane" },
		]);
		saveStoredMessages("pane-a", [
			{ id: "s3", role: "assistant", content: "older duplicate" },
			{ id: "s3", role: "assistant", content: "newer duplicate" },
		]);

		expect(loadStoredMessages("pane-a")).toEqual([
			{
				id: "s3",
				role: "assistant",
				content: "newer duplicate",
				isStreaming: false,
			},
		]);
		expect(loadStoredMessages("pane-b")).toEqual([
			{
				id: "s3",
				role: "assistant",
				content: "second pane",
				isStreaming: false,
			},
		]);
	} finally {
		restoreBrowserStorage();
	}
});

test("chat queue file saves serialize the latest queue", async () => {
	const restoreBrowserStorage = installBrowserStorage();
	const previousFetch = globalThis.fetch;
	const queuedSaves: string[][] = [];
	let resolveFirstSave: (() => void) | null = null;
	globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/api/chat-queues/") && init?.method === "PUT") {
			const payload = JSON.parse(String(init.body)) as {
				queue: Array<{ text: string }>;
			};
			queuedSaves.push(payload.queue.map((item) => item.text));
			if (queuedSaves.length === 1) {
				return new Promise<Response>((resolve) => {
					resolveFirstSave = () => resolve(Response.json({ ok: true }));
				});
			}
			return Promise.resolve(Response.json({ ok: true }));
		}
		return Promise.resolve(Response.json({ ok: true }));
	}) as typeof fetch;
	try {
		const { saveStoredQueue } =
			await import("../src/features/chat/chat-session-store.ts");

		saveStoredQueue("pane-save-race", [
			{ id: "q1", text: "first", displayText: "first" },
		]);
		saveStoredQueue("pane-save-race", [
			{ id: "q1", text: "first", displayText: "first" },
			{ id: "q2", text: "second", displayText: "second" },
		]);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(queuedSaves).toEqual([["first"]]);
		resolveFirstSave?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(queuedSaves).toEqual([["first"], ["first", "second"]]);
	} finally {
		globalThis.fetch = previousFetch;
		restoreBrowserStorage();
	}
});

test("chat queue restore prefers direct local queue over stale preference row", async () => {
	const restoreBrowserStorage = installBrowserStorage();
	try {
		const { loadStoredQueue } =
			await import("../src/features/chat/chat-session-store.ts");
		localStorage.setItem(
			"inferay-db-preferences",
			JSON.stringify([
				{
					id: "inferay-chat-queue-pane-direct-queue",
					valueJson: JSON.stringify([]),
					updatedAt: Date.now(),
				},
			])
		);
		localStorage.setItem(
			"inferay-chat-queue-pane-direct-queue",
			JSON.stringify([{ id: "q1", text: "first", displayText: "first" }])
		);

		expect(loadStoredQueue("pane-direct-queue")).toEqual([
			{ id: "q1", text: "first", displayText: "first" },
		]);
	} finally {
		restoreBrowserStorage();
	}
});

test("chat clear operations remove durable preference rows", async () => {
	const restoreBrowserStorage = installBrowserStorage();
	const previousFetch = globalThis.fetch;
	globalThis.fetch = mock(() =>
		Promise.resolve(Response.json({ ok: true }))
	) as typeof fetch;
	try {
		const {
			clearAgentChatPaneState,
			clearPendingSend,
			clearStoredSessionId,
			loadPendingSend,
			loadStoredInput,
			loadStoredMessages,
			loadStoredSessionId,
			savePendingSend,
			saveStoredInput,
			saveStoredMessages,
			saveStoredSessionId,
		} = await import("../src/features/chat/chat-session-store.ts");

		savePendingSend("pane-clear-pending", "send me");
		clearPendingSend("pane-clear-pending");
		expect(loadPendingSend("pane-clear-pending")).toBe("");

		saveStoredSessionId("pane-clear-session", "session-id");
		clearStoredSessionId("pane-clear-session");
		expect(loadStoredSessionId("pane-clear-session")).toBeNull();

		saveStoredInput("pane-clear-all", "draft");
		saveStoredMessages("pane-clear-all", [
			{ id: "m1", role: "user", content: "hello" },
		]);
		saveStoredSessionId("pane-clear-all", "stale-session");
		clearAgentChatPaneState("pane-clear-all");
		expect(loadStoredInput("pane-clear-all")).toBe("");
		expect(loadStoredMessages("pane-clear-all")).toEqual([]);
		expect(loadStoredSessionId("pane-clear-all")).toBeNull();
	} finally {
		globalThis.fetch = previousFetch;
		restoreBrowserStorage();
	}
});
