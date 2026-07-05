import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

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

describe("chat markdown rendering", () => {
	test("renders long streaming tails without reparsing inline markdown", async () => {
		const { Markdown } =
			await import("../src/components/chat/ChatRichContent.tsx");
		const tail = Array.from({ length: 90 }, () => "tail **still raw**").join(
			" "
		);
		const html = renderToStaticMarkup(
			<Markdown
				streaming
				text={`# Done\n\nParagraph with **bold** text.\n\n${tail}`}
			/>
		);

		expect(html).toContain("Done");
		expect(html).toContain("<strong");
		expect(html.match(/<strong/g)?.length).toBe(1);
		expect(html).toContain("**still raw**");
	});

	test("renders copy controls for fenced code blocks", async () => {
		const { Markdown } =
			await import("../src/components/chat/ChatRichContent.tsx");
		const html = renderToStaticMarkup(
			<Markdown text={"```ts\nconst value = 1;\n```"} />
		);

		expect(html).toContain("<pre");
		expect(html).toContain("const value = 1;");
		expect(html).toContain('title="Copy"');
	});

	test("renders copy controls for raw tool question output", async () => {
		const { AskUserQuestionCard } =
			await import("../src/components/chat/ChatRichContent.tsx");
		const html = renderToStaticMarkup(
			<AskUserQuestionCard content={"raw tool output"} />
		);

		expect(html).toContain("<pre");
		expect(html).toContain("raw tool output");
		expect(html).toContain('title="Copy"');
	});
});
