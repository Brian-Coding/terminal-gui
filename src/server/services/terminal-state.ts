import { writeJson } from "../../lib/route-helpers.ts";
import { userDataPath } from "../../lib/user-data.ts";
import {
	createDefaultTerminalState,
	normalizeTerminalState,
	reduceTerminalWorkspaceState,
	type TerminalSavedState,
	type TerminalWorkspaceAction,
} from "../../features/terminal/terminal-utils.ts";

const TERMINAL_STATE_PATH = userDataPath("terminal-state.json");

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
	return (await readJsonFile<T>(TERMINAL_STATE_PATH)) ?? fallback;
}

export async function writeTerminalState(data: unknown): Promise<void> {
	const current = await readJsonFile<unknown>(TERMINAL_STATE_PATH);
	if (isTerminalStateRegression(current, data)) return;
	return writeJson(TERMINAL_STATE_PATH, data);
}

export async function applyTerminalWorkspaceAction(
	action: TerminalWorkspaceAction
): Promise<TerminalSavedState | null> {
	const current = normalizeTerminalState(
		await readJsonFile<unknown>(TERMINAL_STATE_PATH),
		{ createDefault: true }
	);
	const next = reduceTerminalWorkspaceState(
		current ?? createDefaultTerminalState(),
		action
	);
	const normalized = normalizeTerminalState(next, { createDefault: true });
	if (!normalized) return null;
	await writeJson(TERMINAL_STATE_PATH, normalized);
	return normalized;
}

function isTerminalStateRegression(current: unknown, next: unknown): boolean {
	if (terminalStateScore(next) < terminalStateScore(current)) return true;
	const currentPanes = getPaneMap(current);
	if (currentPanes.size === 0) return false;
	for (const [paneId, currentPane] of currentPanes) {
		if (!currentPane.cwd) continue;
		const nextPane = getPaneMap(next).get(paneId);
		if (!nextPane) continue;
		if (!nextPane.cwd && nextPane.pendingCwd) return true;
	}
	return false;
}

export function terminalStateScore(state: unknown): number {
	if (typeof state !== "object" || state === null) return 0;
	const groups = (state as { groups?: unknown }).groups;
	if (!Array.isArray(groups)) return 0;
	let score = groups.length;
	for (const group of groups) {
		if (typeof group !== "object" || group === null) continue;
		const panes = (group as { panes?: unknown }).panes;
		if (!Array.isArray(panes)) continue;
		score += panes.length * 10;
		for (const pane of panes) {
			if (typeof pane !== "object" || pane === null) continue;
			const value = pane as { cwd?: unknown; pendingCwd?: unknown };
			if (typeof value.cwd === "string" && value.cwd) score += 10;
			if (value.pendingCwd === false) score += 3;
		}
	}
	return score;
}

function getPaneMap(
	state: unknown
): Map<string, { cwd?: string; pendingCwd?: boolean }> {
	const panesById = new Map<string, { cwd?: string; pendingCwd?: boolean }>();
	if (typeof state !== "object" || state === null) return panesById;
	const groups = (state as { groups?: unknown }).groups;
	if (!Array.isArray(groups)) return panesById;
	for (const group of groups) {
		if (typeof group !== "object" || group === null) continue;
		const panes = (group as { panes?: unknown }).panes;
		if (!Array.isArray(panes)) continue;
		for (const pane of panes) {
			if (typeof pane !== "object" || pane === null) continue;
			const value = pane as {
				id?: unknown;
				cwd?: unknown;
				pendingCwd?: unknown;
			};
			if (typeof value.id !== "string") continue;
			panesById.set(value.id, {
				cwd: typeof value.cwd === "string" ? value.cwd : undefined,
				pendingCwd:
					typeof value.pendingCwd === "boolean" ? value.pendingCwd : undefined,
			});
		}
	}
	return panesById;
}
