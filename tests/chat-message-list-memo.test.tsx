import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("chat message list is memoized at the component boundary", async () => {
	const source = readFileSync(
		"src/components/chat/ChatMessageList.tsx",
		"utf8"
	);

	expect(source).toContain("export const ChatMessageList = React.memo(");
});
