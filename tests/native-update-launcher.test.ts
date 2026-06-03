import { describe, expect, test } from "bun:test";
import { delimiter } from "node:path";
import {
	createInferayUpdateCommand,
	createInferayUpdatePath,
} from "../src/server/services/native-open.ts";

describe("native update launcher", () => {
	test("adds common user package manager locations to the update PATH", () => {
		const path = createInferayUpdatePath({
			HOME: "/Users/ray",
			PATH: "/usr/bin:/bin",
		});
		const entries = path.split(delimiter);

		expect(entries).toContain("/Users/ray/.bun/bin");
		expect(entries).toContain("/Users/ray/.local/bin");
		expect(entries).toContain("/Users/ray/.npm-global/bin");
		expect(entries).toContain("/opt/homebrew/bin");
		expect(entries).toContain("/usr/local/bin");
		expect(entries).toContain("/usr/bin");
	});

	test("falls back to bunx when npx is unavailable or fails", () => {
		const command = createInferayUpdateCommand();

		expect(command).toContain("command -v npx");
		expect(command).toContain("npx --yes inferay update && exit 0");
		expect(command).toContain("command -v bunx");
		expect(command).toContain("bunx inferay update && exit 0");
		expect(command.indexOf("npx --yes inferay update")).toBeLessThan(
			command.indexOf("bunx inferay update")
		);
	});
});
