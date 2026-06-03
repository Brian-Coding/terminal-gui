import { describe, expect, test } from "bun:test";
import {
	appendPaneToGroup,
	compactTerminalState,
	createDefaultAgentChatGroup,
	getPaneTitle,
	getStatusInfo,
	migrateGroup,
	reduceTerminalGroups,
	reduceTerminalWorkspaceState,
	type GroupId,
	type PaneId,
	type TerminalGroupModel,
	type TerminalPaneModel,
} from "../src/features/terminal/terminal-utils.ts";
import { summarizeHunkDiff } from "../src/features/git/useGitDiff.ts";
import {
	isUnstagedTrackedChange,
	isUntrackedChange,
	orderGitFiles,
	orderProjectGitFiles,
} from "../src/features/git/git-file-utils.ts";
import { isTerminalMainView } from "../src/lib/app-navigation.tsx";
import { normalizeNumstatPath } from "../src/server/services/git.ts";

const pane = (
	id: string,
	overrides: Partial<TerminalPaneModel> = {}
): TerminalPaneModel => ({
	id: id as PaneId,
	title: id,
	agentKind: "terminal",
	isClaude: false,
	paneType: "terminal",
	...overrides,
});

describe("terminal state and git change behavior", () => {
	/*
	 * This protects saved terminal state migration across app versions. Older
	 * panes may only have paneType/isClaude fields, and selectedPaneId may point
	 * at a removed pane; migration must infer the agent kind and choose a valid
	 * selected pane so restored workspaces open cleanly.
	 */
	test("migrates terminal groups with valid selection and inferred agent metadata", () => {
		const migrated = migrateGroup({
			id: "group-1" as GroupId,
			name: "Main",
			selectedPaneId: "missing" as PaneId,
			panes: [
				pane("p1", {
					agentKind: undefined as unknown as TerminalPaneModel["agentKind"],
					paneType: "codex",
				}),
				pane("p2", {
					agentKind: undefined as unknown as TerminalPaneModel["agentKind"],
					isClaude: true,
					paneType: undefined,
				}),
			],
		});

		expect(migrated.selectedPaneId).toBe("p1" as PaneId);
		expect(migrated.columns).toBe(3);
		expect(migrated.rows).toBe(2);
		expect(migrated.panes.map((item) => item.agentKind)).toEqual([
			"codex",
			"claude",
		]);
		expect(migrated.panes.map((item) => item.isClaude)).toEqual([false, true]);
	});

	test("creates the default workspace with one pending chat", () => {
		const group = createDefaultAgentChatGroup();

		expect(group.columns).toBe(3);
		expect(group.rows).toBe(2);
		expect(group.panes).toHaveLength(1);
		expect(group.selectedPaneId).toBe(group.panes[0]!.id);
		expect(group.panes.every((item) => item.agentKind === "codex")).toBe(true);
		expect(group.panes.every((item) => item.pendingCwd)).toBe(true);
	});

	/*
	 * This protects core terminal tab/group data operations. Adding a pane should
	 * only affect the selected group and should atomically select the newly added
	 * pane, while title generation should prefer the workspace directory name
	 * over generic agent labels.
	 */
	test("appends panes only to the selected group and derives workspace titles", () => {
		const nextPane = pane("p2", { cwd: "/Users/test/project-a" });
		const group: TerminalGroupModel = {
			id: "group-1" as GroupId,
			name: "Main",
			panes: [pane("p1")],
			selectedPaneId: "p1" as PaneId,
			columns: 2,
			rows: 1,
		};

		const expectedPane = pane("p1");
		expect(appendPaneToGroup("group-1", nextPane, group)).toEqual({
			...group,
			panes: [expectedPane, nextPane],
			selectedPaneId: nextPane.id,
		});
		expect(appendPaneToGroup("other", nextPane, group)).toBe(group);
		expect(getPaneTitle("codex", "/Users/test/project-a")).toBe("project-a");
		expect(getPaneTitle("claude")).toBe("Claude");
	});

	test("replaces the starter pending pane when opening the first real pane", () => {
		const starter = pane("starter", {
			agentKind: "codex",
			paneType: "codex",
			title: "Codex",
			pendingCwd: true,
		});
		const nextPane = pane("real", {
			agentKind: "codex",
			paneType: "codex",
			cwd: "/Users/test/project-a",
			pendingCwd: false,
		});
		const group: TerminalGroupModel = {
			id: "group-1" as GroupId,
			name: "Main",
			panes: [starter],
			selectedPaneId: starter.id,
			columns: 2,
			rows: 1,
		};

		expect(appendPaneToGroup("group-1", nextPane, group)).toEqual({
			...group,
			panes: [nextPane],
			selectedPaneId: nextPane.id,
		});
	});

	test("creates empty workspaces without a required starter chat", () => {
		const group = createDefaultAgentChatGroup();
		const next = reduceTerminalWorkspaceState(
			{
				groups: [group],
				selectedGroupId: group.id,
				themeId: "default",
				fontSize: 13,
				fontFamily: "SF Mono",
				opacity: 1,
			},
			{ type: "addWorkspace" }
		);

		expect(next?.groups).toHaveLength(2);
		expect(next?.groups[1]?.panes).toEqual([]);
		expect(next?.groups[1]?.selectedPaneId).toBeNull();
		expect(next?.selectedGroupId).toBe(next?.groups[1]?.id);
	});

	test("removes the final pane without recreating a pending chat", () => {
		const group = createDefaultAgentChatGroup();
		const cleaned = reduceTerminalGroups([group], {
			type: "removePane",
			groupId: group.id,
			paneId: group.panes[0]!.id,
		});

		expect(cleaned[0]?.panes).toEqual([]);
		expect(cleaned[0]?.selectedPaneId).toBeNull();
	});

	test("restores to durable workspaces instead of empty draft workspaces", () => {
		const realPane = pane("real", {
			agentKind: "codex",
			paneType: "codex",
			cwd: "/Users/ray/Developer/inferay",
			pendingCwd: false,
		});
		const draftPane = pane("draft", {
			agentKind: "codex",
			paneType: "codex",
			title: "Codex",
			pendingCwd: true,
		});
		const restored = compactTerminalState({
			groups: [
				{
					id: "default" as GroupId,
					name: "Default",
					panes: [realPane],
					selectedPaneId: realPane.id,
					columns: 3,
					rows: 2,
				},
				{
					id: "workspace-2" as GroupId,
					name: "Workspace 2",
					panes: [draftPane],
					selectedPaneId: draftPane.id,
					columns: 3,
					rows: 2,
				},
			],
			selectedGroupId: "workspace-2" as GroupId,
			themeId: "default",
			fontSize: 13,
			fontFamily: "SF Mono",
			opacity: 1,
		});

		expect(restored.groups.map((group) => group.id)).toEqual([
			"default" as GroupId,
		]);
		expect(restored.selectedGroupId).toBe("default" as GroupId);
	});

	test("keeps the starter draft workspace when no durable workspace exists", () => {
		const group = createDefaultAgentChatGroup();
		const cleaned = compactTerminalState({
			groups: [group],
			selectedGroupId: group.id,
			themeId: "default",
			fontSize: 13,
			fontFamily: "SF Mono",
			opacity: 1,
		});

		expect(cleaned.groups).toEqual([group]);
		expect(cleaned.selectedGroupId).toBe(group.id);
	});

	test("collapses all-draft workspace state to the selected starter workspace", () => {
		const first = createDefaultAgentChatGroup();
		const extraPane = pane("extra-draft", {
			agentKind: "codex",
			paneType: "codex",
			title: "Codex",
			pendingCwd: true,
		});
		const second = {
			...createDefaultAgentChatGroup(),
			name: "Workspace 2",
		};
		const dirtySecond = {
			...second,
			panes: [...second.panes, extraPane],
		};
		const cleaned = compactTerminalState({
			groups: [first, dirtySecond],
			selectedGroupId: second.id,
			themeId: "default",
			fontSize: 13,
			fontFamily: "SF Mono",
			opacity: 1,
		});

		expect(cleaned.groups).toEqual([second]);
		expect(cleaned.selectedGroupId).toBe(second.id);
	});

	test("removes inactive draft panes and workspaces after switching back to real work", () => {
		const realPane = pane("real", {
			agentKind: "codex",
			paneType: "codex",
			cwd: "/Users/ray/Developer/inferay",
			pendingCwd: false,
		});
		const draftPane = pane("draft", {
			agentKind: "codex",
			paneType: "codex",
			title: "Codex",
			pendingCwd: true,
		});
		const cleaned = compactTerminalState(
			{
				groups: [
					{
						id: "default" as GroupId,
						name: "Default",
						panes: [realPane, draftPane],
						selectedPaneId: realPane.id,
						columns: 3,
						rows: 2,
					},
					{
						id: "draft-workspace" as GroupId,
						name: "Workspace 2",
						panes: [draftPane],
						selectedPaneId: draftPane.id,
						columns: 3,
						rows: 2,
					},
				],
				selectedGroupId: "default" as GroupId,
				themeId: "default",
				fontSize: 13,
				fontFamily: "SF Mono",
				opacity: 1,
			},
			{ keepSelectedDraft: true }
		);

		expect(cleaned.groups.map((group) => group.id)).toEqual([
			"default" as GroupId,
		]);
		expect(cleaned.groups[0]?.panes.map((item) => item.id)).toEqual([
			"real" as PaneId,
		]);
		expect(cleaned.selectedGroupId).toBe("default" as GroupId);
	});

	test("preserves pending panes inside the selected draft workspace", () => {
		const realPane = pane("real", {
			agentKind: "codex",
			paneType: "codex",
			cwd: "/Users/ray/Developer/inferay",
			pendingCwd: false,
		});
		const firstDraftPane = pane("draft-1", {
			agentKind: "codex",
			paneType: "codex",
			title: "Codex",
			pendingCwd: true,
		});
		const secondDraftPane = pane("draft-2", {
			agentKind: "codex",
			paneType: "codex",
			title: "Codex",
			pendingCwd: true,
		});
		const cleaned = compactTerminalState(
			{
				groups: [
					{
						id: "default" as GroupId,
						name: "Default",
						panes: [realPane],
						selectedPaneId: realPane.id,
						columns: 3,
						rows: 2,
					},
					{
						id: "draft-workspace" as GroupId,
						name: "ihl",
						panes: [firstDraftPane, secondDraftPane],
						selectedPaneId: secondDraftPane.id,
						columns: 3,
						rows: 2,
					},
				],
				selectedGroupId: "draft-workspace" as GroupId,
				themeId: "default",
				fontSize: 13,
				fontFamily: "SF Mono",
				opacity: 1,
			},
			{ keepSelectedDraft: true }
		);

		expect(cleaned.groups.map((group) => group.id)).toEqual([
			"default" as GroupId,
			"draft-workspace" as GroupId,
		]);
		expect(cleaned.groups[1]?.panes.map((item) => item.id)).toEqual([
			firstDraftPane.id,
			secondDraftPane.id,
		]);
		expect(cleaned.groups[1]?.selectedPaneId).toBe(secondDraftPane.id);
		expect(cleaned.selectedGroupId).toBe("draft-workspace" as GroupId);
	});

	test("drops selected draft workspaces during explicit cleanup compaction", () => {
		const realPane = pane("real", {
			agentKind: "codex",
			paneType: "codex",
			cwd: "/Users/ray/Developer/inferay",
			pendingCwd: false,
		});
		const draftPane = pane("draft", {
			agentKind: "codex",
			paneType: "codex",
			title: "Codex",
			pendingCwd: true,
		});
		const cleaned = compactTerminalState({
			groups: [
				{
					id: "default" as GroupId,
					name: "Default",
					panes: [realPane],
					selectedPaneId: realPane.id,
					columns: 3,
					rows: 2,
				},
				{
					id: "draft-workspace" as GroupId,
					name: "Workspace 2",
					panes: [draftPane],
					selectedPaneId: draftPane.id,
					columns: 3,
					rows: 2,
				},
			],
			selectedGroupId: "draft-workspace" as GroupId,
			themeId: "default",
			fontSize: 13,
			fontFamily: "SF Mono",
			opacity: 1,
		});

		expect(cleaned.groups.map((group) => group.id)).toEqual([
			"default" as GroupId,
		]);
		expect(cleaned.groups[0]?.panes.map((item) => item.id)).toEqual([
			"real" as PaneId,
		]);
		expect(cleaned.selectedGroupId).toBe("default" as GroupId);
	});

	/*
	 * This protects status mapping used by terminal and agent surfaces. Tool
	 * statuses carry the tool name through the UI, active statuses remain marked
	 * active, and unknown statuses degrade into an inactive readable label.
	 */
	test("maps terminal status strings into stable status info", () => {
		expect(getStatusInfo("tool:apply_patch")).toEqual(
			expect.objectContaining({
				label: "Running apply_patch",
				toolName: "apply_patch",
				isActive: true,
				iconType: "wrench",
			})
		);
		expect(getStatusInfo("thinking")).toEqual(
			expect.objectContaining({ label: "Thinking...", isActive: true })
		);
		expect(getStatusInfo("queued")).toEqual(
			expect.objectContaining({ label: "queued", isActive: false })
		);
	});

	test("accepts editor as a restorable terminal main view", () => {
		expect(isTerminalMainView("editor")).toBe(true);
		expect(isTerminalMainView("chat")).toBe(true);
		expect(isTerminalMainView("missing")).toBe(false);
	});

	/*
	 * This protects the Git changes ordering used by review and staging flows.
	 * Unstaged files should stay ahead of staged files, untracked files are
	 * distinct from tracked modifications, and null project aggregates should
	 * produce an empty list instead of forcing UI callers to branch.
	 */
	test("orders and classifies git files for change review flows", () => {
		const files = [
			{ path: "staged.ts", staged: true, status: "M" },
			{ path: "modified.ts", staged: false, status: "M" },
			{ path: "new.ts", staged: false, status: "?" },
		];

		expect(orderGitFiles(files).map((file) => file.path)).toEqual([
			"modified.ts",
			"new.ts",
			"staged.ts",
		]);
		expect(orderProjectGitFiles({ files }).map((file) => file.path)).toEqual([
			"modified.ts",
			"new.ts",
			"staged.ts",
		]);
		expect(orderProjectGitFiles(null)).toEqual([]);
		expect(isUntrackedChange(files[2]!)).toBe(true);
		expect(isUnstagedTrackedChange(files[1]!)).toBe(true);
		expect(isUnstagedTrackedChange(files[2]!)).toBe(false);
	});

	test("summarizes deletion-only diffs as navigable hunks", () => {
		expect(
			summarizeHunkDiff({
				oldLines: [
					{ number: 1, content: "remove me", type: "remove" },
					{ number: 2, content: "keep", type: "context" },
				],
				newLines: [
					{ number: null, content: "", type: "spacer" },
					{ number: 1, content: "keep", type: "context" },
				],
				isBinary: false,
				isNew: false,
			})
		).toEqual({ added: 0, removed: 1, hunks: 1, lines: 2 });
	});

	test("normalizes git numstat rename paths for sidebar diff stats", () => {
		expect(normalizeNumstatPath("src/old.ts => src/new.ts")).toBe("src/new.ts");
		expect(normalizeNumstatPath("src/{old => new}/file.ts")).toBe(
			"src/new/file.ts"
		);
	});
});
