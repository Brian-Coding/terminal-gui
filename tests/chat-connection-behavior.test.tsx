import { expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
	ChatMessage,
	ChatUiState,
} from "../src/features/chat/agent-chat-shared.ts";

const subscribeCleanup = mock(() => {});
const reconnectCleanup = mock(() => {});
const subscribe = mock(() => subscribeCleanup);
const onReconnect = mock(() => reconnectCleanup);
const send = mock(() => {});

mock.module("../src/lib/websocket.ts", () => ({
	wsClient: {
		onReconnect,
		send,
		subscribe,
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
	const rootElement = dom.window.document.getElementById("root");
	if (!rootElement) throw new Error("Missing root element");
	return { root: createRoot(rootElement) };
}

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

test("hidden chat views do not own websocket reconnects", async () => {
	subscribe.mockClear();
	subscribeCleanup.mockClear();
	onReconnect.mockClear();
	reconnectCleanup.mockClear();
	send.mockClear();
	const { root } = setupDom();
	const { useChatConnection } =
		await import("../src/components/chat/useChatConnection.ts");

	function Harness({ enabled }: { enabled: boolean }) {
		const [uiState, setUiState] = useState<ChatUiState>({
			expandedTools: new Set(),
			isLoading: false,
			liveActivities: [],
			startTime: null,
			status: "idle",
		});
		const uiStateRef = useRef(uiState);
		const messagesRef = useRef<ChatMessage[]>([]);
		uiStateRef.current = uiState;
		useChatConnection({
			chatUiStateRef: uiStateRef,
			enabled,
			messagesRef,
			paneId: "pane-hidden",
			saveMessagesNow: (messages) => messages,
			sendNextQueuedMessage: () => {},
			setChatUiState: setUiState,
			setLoadingState: (value) =>
				setUiState((prev) => ({
					...prev,
					...(typeof value === "function" ? value(prev) : value),
				})),
			setMessages: () => {},
		});
		return null;
	}

	try {
		root.render(<Harness enabled={false} />);
		await tick();
		expect(subscribe).toHaveBeenCalledTimes(0);
		expect(onReconnect).toHaveBeenCalledTimes(0);
		expect(send).toHaveBeenCalledTimes(0);

		root.render(<Harness enabled />);
		await tick();
		expect(subscribe).toHaveBeenCalledTimes(1);
		expect(onReconnect).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({
			type: "chat:reconnect",
			paneId: "pane-hidden",
		});

		root.render(<Harness enabled={false} />);
		await tick();
		expect(subscribeCleanup).toHaveBeenCalledTimes(1);
		expect(reconnectCleanup).toHaveBeenCalledTimes(1);
	} finally {
		root.unmount();
	}
});

test("live turn completion drains queued messages once across sync and done", async () => {
	subscribe.mockClear();
	send.mockClear();
	const { root } = setupDom();
	const { useChatConnection } =
		await import("../src/components/chat/useChatConnection.ts");
	const drainQueue = mock(() => {});
	let messagesAtDrain: ChatMessage[] = [];
	let handleMessage: ((message: unknown) => void) | undefined;
	subscribe.mockImplementationOnce((_paneId, cb) => {
		handleMessage = cb as (message: unknown) => void;
		return subscribeCleanup;
	});

	function Harness() {
		const [uiState, setUiState] = useState<ChatUiState>({
			expandedTools: new Set(),
			isLoading: true,
			liveActivities: [],
			startTime: Date.now(),
			status: "responding",
		});
		const uiStateRef = useRef(uiState);
		const messagesRef = useRef<ChatMessage[]>([
			{ id: "m1", role: "user", content: "first" },
		]);
		uiStateRef.current = uiState;
		const saveMessagesNow = useCallback(
			(messages: ChatMessage[]) => messages,
			[]
		);
		const setMessages = useCallback(
			(
				update: ChatMessage[] | ((messages: ChatMessage[]) => ChatMessage[])
			) => {
				messagesRef.current =
					typeof update === "function" ? update(messagesRef.current) : update;
			},
			[]
		);
		const setLoadingState = useCallback(
			(
				value:
					| Partial<ChatUiState>
					| ((prev: ChatUiState) => Partial<ChatUiState>)
			) =>
				setUiState((prev) => ({
					...prev,
					...(typeof value === "function" ? value(prev) : value),
				})),
			[]
		);
		useChatConnection({
			chatUiStateRef: uiStateRef,
			enabled: true,
			messagesRef,
			paneId: "pane-drain-once",
			saveMessagesNow,
			sendNextQueuedMessage: () => {
				messagesAtDrain = messagesRef.current;
				drainQueue();
			},
			setChatUiState: setUiState,
			setLoadingState,
			setMessages,
		});
		return null;
	}

	try {
		root.render(<Harness />);
		await tick();
		handleMessage?.({
			type: "chat:sync",
			paneId: "pane-drain-once",
			messages: [{ id: "m1", role: "user", content: "first" }],
			isStreaming: true,
		});
		await tick();
		drainQueue.mockClear();

		handleMessage?.({
			type: "chat:sync",
			paneId: "pane-drain-once",
			messages: [
				{ id: "m1", role: "user", content: "first" },
				{ id: "m2", role: "assistant", content: "done" },
			],
			isStreaming: false,
		});
		handleMessage?.({ type: "chat:done", paneId: "pane-drain-once" });
		await tick();

		expect(drainQueue).toHaveBeenCalledTimes(1);
		expect(messagesAtDrain).toEqual([
			{ id: "m1", role: "user", content: "first" },
			{ id: "m2", role: "assistant", content: "done" },
		]);
	} finally {
		root.unmount();
	}
});
