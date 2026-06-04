import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { userDataPath } from "../src/lib/user-data.ts";
import {
	readChatTranscript,
	writeChatTranscript,
} from "../src/server/services/chat-transcripts.ts";

test("chat transcript reads reuse cached disk data without leaking mutable objects", async () => {
	const paneId = `test-transcript-cache-${crypto.randomUUID()}`;
	const path = userDataPath("chat-transcripts", `${paneId}.json`);
	try {
		await mkdir(dirname(path), { recursive: true });
		await Bun.write(
			path,
			JSON.stringify([
				{ id: "m1", role: "assistant", content: "cached from disk" },
			])
		);

		const first = await readChatTranscript(paneId);
		expect(first?.[0]?.content).toBe("cached from disk");
		if (!first?.[0]) throw new Error("Missing first transcript message");
		first[0].content = "mutated by caller";

		await Bun.write(
			path,
			JSON.stringify([{ id: "m1", role: "assistant", content: "disk changed" }])
		);

		const second = await readChatTranscript(paneId);
		expect(second?.[0]?.content).toBe("cached from disk");
		expect(second).not.toBe(first);
		expect(second?.[0]).not.toBe(first[0]);
	} finally {
		await rm(path, { force: true });
	}
});

test("chat transcript writes cache the storage-safe message shape", async () => {
	const paneId = `test-transcript-write-cache-${crypto.randomUUID()}`;
	const path = userDataPath("chat-transcripts", `${paneId}.json`);
	try {
		await writeChatTranscript(paneId, [
			{
				id: "m1",
				role: "assistant",
				content: "done",
				isStreaming: true,
			},
		]);

		const fromCache = await readChatTranscript(paneId);
		const fromDisk = (await Bun.file(path).json()) as Array<{
			isStreaming?: boolean;
		}>;
		expect(fromCache?.[0]?.isStreaming).toBe(false);
		expect(fromDisk[0]?.isStreaming).toBe(false);
	} finally {
		await rm(path, { force: true });
	}
});
