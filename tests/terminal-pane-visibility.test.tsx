import { expect, mock, test } from "bun:test";
import * as React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { PaneId } from "../src/features/terminal/terminal-utils.ts";

mock.module("@stylexjs/stylex", () => ({
	create: <T extends Record<string, unknown>>(styles: T) => styles,
	createTheme: (_vars: unknown, values: unknown) => values,
	defineVars: <T extends Record<string, string>>(values: T) => values,
	keyframes: () => "test-keyframes",
	props: () => ({ className: "" }),
}));

const refit = mock(() => {});
const terminalEnabledStates: boolean[] = [];
const chatHandle = {};

mock.module("../src/hooks/useXtermTerminal.ts", () => ({
	useXtermTerminal: mock(({ enabled }: { enabled: boolean }) => {
		terminalEnabledStates.push(enabled);
		return {
			containerRef: React.createRef<HTMLDivElement>(),
			termRef: React.createRef<{ focus: () => void }>(),
			refit,
		};
	}),
}));

mock.module("../src/components/chat/AgentChatView.tsx", () => ({
	AgentChatView: React.forwardRef(function MockAgentChatView(
		_props: unknown,
		ref: React.ForwardedRef<unknown>
	) {
		React.useImperativeHandle(ref, () => chatHandle, []);
		return <div data-testid="agent-chat" />;
	}),
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
	Object.defineProperty(globalThis, "HTMLElement", {
		configurable: true,
		value: dom.window.HTMLElement,
	});
	Object.defineProperty(globalThis, "SVGElement", {
		configurable: true,
		value: dom.window.SVGElement,
	});
	const rootElement = dom.window.document.getElementById("root");
	if (!rootElement) throw new Error("Missing root element");
	return { root: createRoot(rootElement) };
}

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

test("terminal panes do not keep xterm live while their surface is hidden", async () => {
	refit.mockClear();
	terminalEnabledStates.length = 0;
	const { root } = setupDom();
	const { TerminalPaneView } =
		await import("../src/pages/Terminal/TerminalPaneView.tsx");
	const pane = {
		id: "terminal-pane" as PaneId,
		title: "Terminal",
		agentKind: "terminal" as const,
		isClaude: false,
		paneType: "terminal" as const,
		cwd: "/tmp/project",
	};

	try {
		root.render(
			<TerminalPaneView
				pane={pane}
				isSelected
				isVisible={false}
				theme={{ bg: "#000", fg: "#fff", cursor: "#fff", separator: "#333" }}
				fontSize={13}
				fontFamily="SF Mono"
				onSelect={() => {}}
				onClose={() => {}}
				chatRef={() => {}}
			/>
		);
		await tick();
		expect(terminalEnabledStates.at(-1)).toBe(false);
		expect(refit).toHaveBeenCalledTimes(0);

		root.render(
			<TerminalPaneView
				pane={pane}
				isSelected
				isVisible
				theme={{ bg: "#000", fg: "#fff", cursor: "#fff", separator: "#333" }}
				fontSize={13}
				fontFamily="SF Mono"
				onSelect={() => {}}
				onClose={() => {}}
				chatRef={() => {}}
			/>
		);
		await tick();
		expect(terminalEnabledStates.at(-1)).toBe(true);
		expect(refit).toHaveBeenCalledTimes(1);
	} finally {
		root.unmount();
	}
});

test("chat pane refs stay attached across parent rerenders", async () => {
	const { root } = setupDom();
	const { TerminalPaneView } =
		await import("../src/pages/Terminal/TerminalPaneView.tsx");
	const pane = {
		id: "chat-pane" as PaneId,
		title: "Codex",
		agentKind: "codex" as const,
		isClaude: false,
		paneType: "codex" as const,
		cwd: "/tmp/project",
	};
	const theme = { bg: "#000", fg: "#fff", cursor: "#fff", separator: "#333" };
	const chatRef = mock(() => {});
	const noop = () => {};

	try {
		root.render(
			<TerminalPaneView
				pane={pane}
				isSelected
				isVisible
				theme={theme}
				fontSize={13}
				fontFamily="SF Mono"
				gitBranch="main"
				onSelect={noop}
				onClose={noop}
				chatRef={chatRef}
			/>
		);
		await tick();
		expect(chatRef).toHaveBeenCalledTimes(1);
		expect(chatRef.mock.calls[0]).toEqual(["chat-pane", chatHandle]);

		root.render(
			<TerminalPaneView
				pane={pane}
				isSelected
				isVisible
				theme={theme}
				fontSize={13}
				fontFamily="SF Mono"
				gitBranch="feature"
				onSelect={noop}
				onClose={noop}
				chatRef={chatRef}
			/>
		);
		await tick();
		expect(chatRef).toHaveBeenCalledTimes(1);
	} finally {
		root.unmount();
	}
});
