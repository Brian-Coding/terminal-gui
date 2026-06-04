import { expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";

mock.module("../src/lib/websocket.ts", () => ({
	wsClient: {
		onMessage: mock(() => () => {}),
		send: mock(() => {}),
	},
}));

function setupDom() {
	const dom = new JSDOM('<div id="root"></div>', {
		pretendToBeVisual: true,
		url: "http://localhost/#/terminal",
	});
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
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: dom.window.crypto,
	});
	const rootElement = dom.window.document.getElementById("root");
	if (!rootElement) throw new Error("Missing root element");
	return { dom, root: createRoot(rootElement), rootElement };
}

function tick(ms = 0) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("queued messages survive stale file-backed queue hydration", async () => {
	const previousFetch = globalThis.fetch;
	let resolveQueueFetch: (() => void) | null = null;
	const initialQueue = [{ id: "q1", text: "first", displayText: "first" }];
	globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/api/chat-queues/") && !init?.method) {
			return new Promise<Response>((resolve) => {
				resolveQueueFetch = () =>
					resolve(Response.json({ queue: initialQueue }));
			});
		}
		return Promise.resolve(Response.json({ ok: true }));
	}) as typeof fetch;

	const { root, rootElement } = setupDom();
	try {
		localStorage.setItem(
			"inferay-chat-queue-pane-stale",
			JSON.stringify(initialQueue)
		);
		const { useAgentChatComposerState } =
			await import("../src/components/chat/useAgentChatComposerState.ts");
		let queueMessage: ((text: string, displayText: string) => void) | null =
			null;
		function Harness() {
			const state = useAgentChatComposerState("pane-stale");
			queueMessage = state.queueMessage;
			return (
				<div data-queue={state.queuedMessages.map((q) => q.text).join("|")} />
			);
		}

		root.render(<Harness />);
		await tick(20);
		expect(rootElement.firstElementChild?.getAttribute("data-queue")).toBe(
			"first"
		);

		queueMessage?.("second", "second");
		await tick(20);
		expect(rootElement.firstElementChild?.getAttribute("data-queue")).toBe(
			"first|second"
		);

		resolveQueueFetch?.();
		await tick(20);
		expect(rootElement.firstElementChild?.getAttribute("data-queue")).toBe(
			"first|second"
		);
	} finally {
		root.unmount();
		globalThis.fetch = previousFetch;
	}
});

test("hidden composer state does not hydrate file-backed queues", async () => {
	const previousFetch = globalThis.fetch;
	let queueFetchCount = 0;
	globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/api/chat-queues/") && !init?.method) {
			queueFetchCount++;
			return Promise.resolve(Response.json({ queue: [] }));
		}
		return Promise.resolve(Response.json({ ok: true }));
	}) as typeof fetch;

	const { root } = setupDom();
	try {
		const { useAgentChatComposerState } =
			await import("../src/components/chat/useAgentChatComposerState.ts");
		function Harness({ enabled }: { enabled: boolean }) {
			useAgentChatComposerState("pane-hidden-queue", enabled);
			return <div />;
		}

		root.render(<Harness enabled={false} />);
		await tick(20);
		expect(queueFetchCount).toBe(0);

		root.render(<Harness enabled={true} />);
		await tick(20);
		expect(queueFetchCount).toBe(1);
	} finally {
		root.unmount();
		globalThis.fetch = previousFetch;
	}
});

test("visible composer keeps in-memory queue while empty local snapshot hydrates", async () => {
	const previousFetch = globalThis.fetch;
	let resolveQueueFetch: (() => void) | null = null;
	const durableQueue = [{ id: "q1", text: "first", displayText: "first" }];
	globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/api/chat-queues/") && !init?.method) {
			return new Promise<Response>((resolve) => {
				resolveQueueFetch = () =>
					resolve(Response.json({ queue: durableQueue }));
			});
		}
		return Promise.resolve(Response.json({ ok: true }));
	}) as typeof fetch;

	const { root, rootElement } = setupDom();
	try {
		localStorage.setItem(
			"inferay-chat-queue-pane-visible-race",
			JSON.stringify(durableQueue)
		);
		const { useAgentChatComposerState } =
			await import("../src/components/chat/useAgentChatComposerState.ts");
		function Harness({ enabled }: { enabled: boolean }) {
			const state = useAgentChatComposerState("pane-visible-race", enabled);
			return (
				<div data-queue={state.queuedMessages.map((q) => q.text).join("|")} />
			);
		}

		root.render(<Harness enabled={true} />);
		await tick(20);
		expect(rootElement.firstElementChild?.getAttribute("data-queue")).toBe(
			"first"
		);

		root.render(<Harness enabled={false} />);
		await tick(20);
		localStorage.removeItem("inferay-chat-queue-pane-visible-race");
		root.render(<Harness enabled={true} />);
		await tick(20);
		expect(rootElement.firstElementChild?.getAttribute("data-queue")).toBe(
			"first"
		);

		resolveQueueFetch?.();
		await tick(20);
		expect(rootElement.firstElementChild?.getAttribute("data-queue")).toBe(
			"first"
		);
	} finally {
		root.unmount();
		globalThis.fetch = previousFetch;
	}
});

test("queue append uses storage event payload instead of stale storage reload", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/api/chat-queues/") && !init?.method) {
			return Promise.resolve(Response.json({ queue: [] }));
		}
		return Promise.resolve(Response.json({ ok: true }));
	}) as typeof fetch;

	const { root, rootElement } = setupDom();
	try {
		const { useAgentChatComposerState } =
			await import("../src/components/chat/useAgentChatComposerState.ts");
		function Harness() {
			const state = useAgentChatComposerState("pane-stale-preference");
			return (
				<div data-queue={state.queuedMessages.map((q) => q.text).join("|")} />
			);
		}

		root.render(<Harness />);
		await tick(20);

		localStorage.setItem(
			"inferay-chat-queue-pane-stale-preference",
			JSON.stringify([{ id: "q1", text: "first", displayText: "first" }])
		);
		window.dispatchEvent(
			new window.CustomEvent("inferay-client-storage-change", {
				detail: {
					key: "inferay-chat-queue-pane-stale-preference",
					value: JSON.stringify([
						{ id: "q1", text: "first", displayText: "first" },
						{ id: "q2", text: "second", displayText: "second" },
					]),
				},
			})
		);
		await tick(20);
		expect(rootElement.firstElementChild?.getAttribute("data-queue")).toBe(
			"first|second"
		);
	} finally {
		root.unmount();
		globalThis.fetch = previousFetch;
	}
});
