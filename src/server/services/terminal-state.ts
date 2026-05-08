import { resolve } from "node:path";
import { PROJECT_ROOT } from "../../lib/path-utils.ts";
import { writeJson } from "../../lib/route-helpers.ts";
import { userDataPath } from "../../lib/user-data.ts";

const TERMINAL_STATE_PATH = userDataPath("terminal-state.json");
const LEGACY_TERMINAL_STATE_PATHS = [
	resolve(import.meta.dir, "../../data/terminal-state.json"),
	resolve(PROJECT_ROOT, "data/terminal-state.json"),
	resolve(PROJECT_ROOT, "src/data/terminal-state.json"),
];

async function readJsonFile<T>(path: string): Promise<T | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as T;
	} catch {
		return null;
	}
}

export async function readTerminalState<T>(fallback: T): Promise<T> {
	return (
		(await readJsonFile<T>(TERMINAL_STATE_PATH)) ??
		(await readFirstLegacyTerminalState<T>()) ??
		fallback
	);
}

export function writeTerminalState(data: unknown): Promise<void> {
	return writeJson(TERMINAL_STATE_PATH, data);
}

async function readFirstLegacyTerminalState<T>(): Promise<T | null> {
	for (const path of LEGACY_TERMINAL_STATE_PATHS) {
		const state = await readJsonFile<T>(path);
		if (state) return state;
	}
	return null;
}
