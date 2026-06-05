import { expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";

mock.module("@stylexjs/stylex", () => ({
	create: <T extends Record<string, unknown>>(styles: T) => styles,
	createTheme: (_vars: unknown, values: unknown) => values,
	defineVars: <T extends Record<string, string>>(values: T) => values,
	keyframes: () => "test-keyframes",
	props: (
		...styles: Array<Record<string, unknown> | false | null | undefined>
	) => ({
		className: styles
			.filter(Boolean)
			.map((_, index) => `sx-${index}`)
			.join(" "),
	}),
}));

const fetchJsonOr = mock(async () => ({
	branches: [
		{ name: "main", current: true },
		{ name: "feature", current: false },
	],
}));

mock.module("../src/lib/fetch-json.ts", () => ({
	fetchJsonOr,
	postJson: mock(async () => ({ ok: true })),
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
	Object.defineProperty(dom.window, "innerHeight", {
		configurable: true,
		value: 800,
	});
	Object.defineProperty(dom.window, "innerWidth", {
		configurable: true,
		value: 1200,
	});

	const rootElement = dom.window.document.getElementById("root");
	if (!rootElement) throw new Error("Missing root element");
	return { dom, root: createRoot(rootElement), rootElement };
}

test("branch dropdown loads branches only when opened", async () => {
	fetchJsonOr.mockClear();
	const { dom, root, rootElement } = setupDom();
	try {
		const { BranchDropdown } =
			await import("../src/components/chat/AgentChatHeader.tsx");
		root.render(<BranchDropdown cwd="/tmp/repo" branch="main" />);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(fetchJsonOr).toHaveBeenCalledTimes(0);

		const button = rootElement.querySelector("button");
		expect(button).toBeTruthy();
		button!.dispatchEvent(
			new dom.window.MouseEvent("click", { bubbles: true })
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(fetchJsonOr).toHaveBeenCalledTimes(1);
		const calls = fetchJsonOr.mock.calls as unknown as Array<[string]>;
		expect(calls[0]?.[0]).toContain("/api/git/branches");
	} finally {
		root.unmount();
	}
});
