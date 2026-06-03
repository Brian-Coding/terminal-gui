import * as stylex from "@stylexjs/stylex";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import {
	type AgentChatHandle,
	AgentChatView,
} from "../../components/chat/AgentChatView.tsx";
import { BranchDropdown } from "../../components/chat/AgentChatHeader.tsx";
import { DiffViewerBoundary } from "../../components/diff/DiffViewerBoundary.tsx";
import {
	ChangeFileSidebar,
	type SelectedFile,
} from "../../components/git/ChangeFileSidebar.tsx";
import { CommitGraph } from "../../components/git/CommitGraph.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import {
	IconCollapse,
	IconExpand,
	IconGitBranch,
	IconLayoutGrid,
	IconPanelLeft,
	IconPlus,
	IconSettings,
	IconX,
} from "../../components/ui/Icons.tsx";
import { useActivityFeed } from "../../features/activity-feed/useActivityFeed.ts";
import { isChatAgentKind } from "../../features/agents/agents.ts";
import { useAgentSessions } from "../../features/agents/useAgentSessions.ts";
import {
	clearAgentChatMessages,
	loadPendingWorkspacePaths,
} from "../../features/chat/chat-session-store.ts";
import { useFileWatcher } from "../../features/file-watcher/useFileWatcher.ts";
import { useGitChangeActions } from "../../features/git/useGitChangeActions.ts";
import {
	type DiffRequest,
	summarizeHunkDiff,
	useGitDiff,
} from "../../features/git/useGitDiff.ts";
import {
	useCommitDetails,
	useGitGraph,
} from "../../features/git/useGitGraph.ts";
import { useGitStatus } from "../../features/git/useGitStatus.ts";
import {
	dispatchTerminalShellChange,
	loadTerminalState,
	type TerminalGroupModel,
	type ThemeId,
} from "../../features/terminal/terminal-utils.ts";
import {
	loadAppThemeId,
	mapAppThemeToTerminalTheme,
} from "../../lib/app-theme.ts";
import {
	incrementNumber,
	isNonEmptyString,
	toggleBoolean,
} from "../../lib/data.ts";
import {
	isStagedChange,
	isUnstagedTrackedChange,
	isUntrackedChange,
	orderProjectGitFiles,
} from "../../features/git/git-file-utils.ts";
import {
	listenWindowEvent,
	setupTerminalThemePanelShortcut,
} from "../../lib/react-events.ts";
import {
	readStoredValue,
	removeStoredValue,
	writeStoredValue,
} from "../../lib/stored-json.ts";
import { wsClient } from "../../lib/websocket.ts";
import { color, controlSize, font } from "../../tokens.stylex.ts";
import { type DiffViewMode, GitDiffView } from "../Terminal/GitDiffView.tsx";
import { TerminalSettingsPanel } from "../Terminal/TerminalSettingsPanel.tsx";

interface Session {
	groupId: string;
	groupName: string;
	paneId: string;
	paneTitle: string;
	agentKind: "claude" | "codex";
	cwd?: string;
	referencePaths?: string[];
	pendingCwd?: boolean;
	messageCount: number;
}

type StateValue<T> = T | ((current: T) => T);

type EditorUiState = {
	selectedPaneId: string | null;
	selectedFiles: Record<string, SelectedFile | null>;
	diffViewMode: DiffViewMode;
	closedPaneIds: Set<string>;
	scrollToChange: number;
	zenMode: boolean;
	sidebarWidth: number;
	sidebarVisible: boolean;
	selectedCommitHash: string | null;
	fileViewMode: "path" | "tree";
	mainViewMode: "diff" | "graph";
	showSettings: boolean;
};

type EditorUiAction<K extends keyof EditorUiState = keyof EditorUiState> = {
	type: "fieldChanged";
	field: K;
	value: StateValue<EditorUiState[K]>;
};

function getInitialEditorUiState(): EditorUiState {
	return {
		selectedPaneId: readStoredValue("editor-selected-pane") ?? null,
		selectedFiles: {},
		diffViewMode: "split",
		closedPaneIds: new Set(),
		scrollToChange: 0,
		zenMode: loadZenMode(),
		sidebarWidth: 280,
		sidebarVisible: true,
		selectedCommitHash: null,
		fileViewMode: "tree",
		mainViewMode: "diff",
		showSettings: false,
	};
}

function resolveStateValue<T>(current: T, value: StateValue<T>): T {
	return typeof value === "function"
		? (value as (current: T) => T)(current)
		: value;
}

function editorUiReducer(
	state: EditorUiState,
	action: EditorUiAction
): EditorUiState {
	switch (action.type) {
		case "fieldChanged":
			return {
				...state,
				[action.field]: resolveStateValue(state[action.field], action.value),
			};
	}
}

let cachedKey = "";
let cachedSessions: Session[] = [];
const EMPTY_TERMINAL_GROUPS: TerminalGroupModel[] = [];

function flattenSessions(groups: TerminalGroupModel[]): Session[] {
	return groups.flatMap((g) =>
		g.panes.flatMap((p) => {
			if (!isChatAgentKind(p.agentKind)) return [];
			const pendingWorkspacePaths = p.cwd
				? []
				: loadPendingWorkspacePaths(p.id);
			return [
				{
					groupId: g.id,
					groupName: g.name,
					paneId: p.id,
					paneTitle: p.title,
					agentKind: p.agentKind,
					cwd: p.cwd ?? pendingWorkspacePaths[0],
					referencePaths: p.cwd
						? p.referencePaths
						: pendingWorkspacePaths.slice(1),
					pendingCwd:
						p.pendingCwd || (!p.cwd && pendingWorkspacePaths.length > 0),
					messageCount: 0,
				},
			];
		})
	);
}

function stableSessions(next: Session[]): Session[] {
	const key = next
		.map((s) =>
			[
				s.groupId,
				s.paneId,
				s.agentKind,
				s.cwd ?? "",
				s.pendingCwd ? "pending" : "ready",
				s.referencePaths?.join("\u0000") ?? "",
			].join("\u0001")
		)
		.join("\u0002");
	if (key === cachedKey) return cachedSessions;
	cachedKey = key;
	cachedSessions = next;
	return next;
}

function loadZenMode() {
	return readStoredValue("terminal-editor-zen") === "true";
}

interface EditorPageProps {
	groups?: TerminalGroupModel[];
	selectedGroupId?: string | null;
	themeId?: ThemeId;
	onSelectPane?: (paneId: string) => void;
	onDirectoryChange?: (
		paneId: string,
		cwd: string,
		referencePaths?: string[]
	) => void;
}

export function EditorPage({
	groups: liveGroups,
	selectedGroupId: liveSelectedGroupId,
	themeId: liveThemeId,
	onSelectPane,
	onDirectoryChange,
}: EditorPageProps = {}) {
	const [, setTick] = useState(0);
	const [, setAgentStatuses] = useState<Map<string, string>>(new Map());
	const [editorUiState, editorUiDispatch] = useReducer(
		editorUiReducer,
		undefined,
		getInitialEditorUiState
	);
	const {
		selectedPaneId,
		selectedFiles,
		diffViewMode,
		closedPaneIds,
		scrollToChange,
		zenMode,
		sidebarWidth,
		sidebarVisible,
		selectedCommitHash,
		fileViewMode,
		mainViewMode,
		showSettings,
	} = editorUiState;
	const setEditorUiField = useCallback(
		<K extends keyof EditorUiState>(
			field: K,
			value: StateValue<EditorUiState[K]>
		) =>
			editorUiDispatch({
				type: "fieldChanged",
				field,
				value,
			} as EditorUiAction),
		[]
	);
	const setSelectedPaneId = useCallback(
		(value: StateValue<string | null>) =>
			setEditorUiField("selectedPaneId", value),
		[setEditorUiField]
	);
	const setSelectedFiles = useCallback(
		(value: StateValue<Record<string, SelectedFile | null>>) =>
			setEditorUiField("selectedFiles", value),
		[setEditorUiField]
	);
	const setDiffViewMode = useCallback(
		(value: StateValue<DiffViewMode>) =>
			setEditorUiField("diffViewMode", value),
		[setEditorUiField]
	);
	const setClosedPaneIds = useCallback(
		(value: StateValue<Set<string>>) =>
			setEditorUiField("closedPaneIds", value),
		[setEditorUiField]
	);
	const setScrollToChange = useCallback(
		(value: StateValue<number>) => setEditorUiField("scrollToChange", value),
		[setEditorUiField]
	);
	const setZenMode = useCallback(
		(value: StateValue<boolean>) => setEditorUiField("zenMode", value),
		[setEditorUiField]
	);
	const setSidebarWidth = useCallback(
		(value: StateValue<number>) => setEditorUiField("sidebarWidth", value),
		[setEditorUiField]
	);
	const setSidebarVisible = useCallback(
		(value: StateValue<boolean>) => setEditorUiField("sidebarVisible", value),
		[setEditorUiField]
	);
	const setSelectedCommitHash = useCallback(
		(value: StateValue<string | null>) =>
			setEditorUiField("selectedCommitHash", value),
		[setEditorUiField]
	);
	const setFileViewMode = useCallback(
		(value: StateValue<"path" | "tree">) =>
			setEditorUiField("fileViewMode", value),
		[setEditorUiField]
	);
	const setMainViewMode = useCallback(
		(value: StateValue<"diff" | "graph">) =>
			setEditorUiField("mainViewMode", value),
		[setEditorUiField]
	);
	const setShowSettings = useCallback(
		(value: StateValue<boolean>) => setEditorUiField("showSettings", value),
		[setEditorUiField]
	);
	const chatRef = useRef<AgentChatHandle>(null);
	const sidebarDragRef = useRef<{
		startX: number;
		startWidth: number;
	} | null>(null);

	const [, setSessionVersion] = useState(0);
	const terminalState = liveGroups ? null : loadTerminalState();
	const themeId =
		liveThemeId ??
		terminalState?.themeId ??
		mapAppThemeToTerminalTheme(loadAppThemeId());
	const sourceGroups =
		liveGroups ?? terminalState?.groups ?? EMPTY_TERMINAL_GROUPS;
	const activeGroupId =
		liveSelectedGroupId ?? terminalState?.selectedGroupId ?? null;
	const visibleGroups = useMemo(() => {
		const activeGroup = sourceGroups.find(
			(group) => group.id === activeGroupId
		);
		return activeGroup ? [activeGroup] : sourceGroups;
	}, [activeGroupId, sourceGroups]);
	const activeGroupSelectedPaneId = visibleGroups[0]?.selectedPaneId ?? null;
	const allSessions = useMemo(
		() => stableSessions(flattenSessions(visibleGroups)),
		[visibleGroups]
	);
	const sessions = useMemo(
		() => allSessions.filter((s) => !closedPaneIds.has(s.paneId)),
		[allSessions, closedPaneIds]
	);
	const effectiveSelectedPaneId = useMemo(() => {
		const activePaneId =
			activeGroupSelectedPaneId &&
			sessions.some((s) => s.paneId === activeGroupSelectedPaneId)
				? activeGroupSelectedPaneId
				: selectedPaneId;
		return activePaneId && sessions.some((s) => s.paneId === activePaneId)
			? activePaneId
			: (sessions[0]?.paneId ?? null);
	}, [activeGroupSelectedPaneId, selectedPaneId, sessions]);
	const { sessions: liveAgentSessions } = useAgentSessions();
	const trackedDirs = useMemo(
		() => [...new Set(sessions.map((s) => s.cwd).filter(isNonEmptyString))],
		[sessions]
	);
	const {
		projectMap,
		refetch: refetchGit,
		applyOptimistic,
	} = useGitStatus(trackedDirs);
	const {
		diff,
		request,
		loading: diffLoading,
		loadDiff,
		clear: clearDiff,
	} = useGitDiff();
	const selectedDiffStats = useMemo(() => summarizeHunkDiff(diff), [diff]);

	const refresh = useCallback(() => setTick(incrementNumber), []);
	useEffect(() => {
		return wsClient.connect();
	}, []);

	useEffect(() => {
		const id = setInterval(refresh, 5000);
		return () => clearInterval(id);
	}, [refresh]);

	useEffect(() => {
		setAgentStatuses((cur) => {
			const next = new Map(cur);
			for (const s of liveAgentSessions) {
				const existing = next.get(s.paneId);
				if (!existing || existing === "idle" || existing === "thinking") {
					next.set(s.paneId, s.isRunning ? "thinking" : "idle");
				}
			}
			return next;
		});
	}, [liveAgentSessions]);

	useEffect(() => {
		if (effectiveSelectedPaneId) {
			writeStoredValue("editor-selected-pane", effectiveSelectedPaneId);
		} else {
			removeStoredValue("editor-selected-pane");
		}
	}, [effectiveSelectedPaneId]);

	const sessionIdx = useMemo(
		() => sessions.findIndex((s) => s.paneId === effectiveSelectedPaneId),
		[effectiveSelectedPaneId, sessions]
	);
	const session =
		sessionIdx >= 0 ? sessions[sessionIdx] : (sessions[0] ?? null);
	const {
		commit,
		commitMessage,
		setCommitMessage,
		isCommitting,
		amendMode,
		setAmendMode,
		stageFile,
		unstageFile,
		stageAll,
		unstageAll,
	} = useGitChangeActions({
		cwd: session?.cwd,
		onRefresh: refresh,
		applyOptimistic,
		refetchStatus: refetchGit,
	});
	const project = session?.cwd ? (projectMap.get(session.cwd) ?? null) : null;
	const files = useMemo(
		() =>
			orderProjectGitFiles<{
				path: string;
				staged: boolean;
				status: string;
			}>(project),
		[project]
	);
	const staged = project?.files.filter(isStagedChange) ?? [];
	const modified = project?.files.filter(isUnstagedTrackedChange) ?? [];
	const untracked = project?.files.filter(isUntrackedChange) ?? [];
	const selectedFile = session ? (selectedFiles[session.paneId] ?? null) : null;
	const {
		commits: graphCommits,
		rows: graphRows,
		loading: graphLoading,
	} = useGitGraph(mainViewMode === "graph" ? session?.cwd : undefined, 100);
	const { details: commitDetails, loading: commitDetailsLoading } =
		useCommitDetails(
			mainViewMode === "graph" ? session?.cwd : undefined,
			selectedCommitHash ?? undefined
		);

	const selectFile = useCallback(
		(paneId: string, req: DiffRequest) => {
			setSelectedFiles((cur) => ({
				...cur,
				[paneId]: { path: req.file, staged: req.staged },
			}));
			loadDiff(req);
		},
		[loadDiff, setSelectedFiles]
	);

	useActivityFeed({
		paneId: session?.paneId,
		cwd: session?.cwd,
	});

	const { checkPendingScroll } = useFileWatcher({
		enabled: zenMode,
		cwd: session?.cwd,
		paneId: session?.paneId,
		currentFile: request?.file,
		loadDiff,
		setSelectedFile: useCallback(
			(path: string, staged: boolean) => {
				if (!session?.paneId) return;
				setSelectedFiles((cur) => ({
					...cur,
					[session.paneId]: { path, staged },
				}));
			},
			[session?.paneId, setSelectedFiles]
		),
		onDiffLoaded: useCallback(() => {
			refresh();
			setTimeout(setScrollToChange, 50, incrementNumber);
		}, [refresh, setScrollToChange]),
	});

	const updateZenMode = useCallback(
		(next: boolean) => {
			setZenMode(next);
			writeStoredValue("terminal-editor-zen", next ? "true" : "false");
			dispatchTerminalShellChange({ source: "view", reason: "editor-zen" });
		},
		[setZenMode]
	);

	useEffect(() => {
		const syncEditorShellState = () => {
			setZenMode(loadZenMode());
			setSessionVersion(incrementNumber);
			// Re-read selected pane (sidebar may have changed it)
			const storedPane = readStoredValue("editor-selected-pane");
			if (storedPane) setSelectedPaneId(storedPane);
		};
		return listenWindowEvent("terminal-shell-change", syncEditorShellState);
	}, [setSelectedPaneId, setZenMode]);

	useEffect(() => {
		return setupTerminalThemePanelShortcut(setShowSettings);
	}, [setShowSettings]);

	useEffect(() => {
		if (diff && !diffLoading) checkPendingScroll();
	}, [diff, diffLoading, checkPendingScroll]);

	const selectedFilesRef = useRef(selectedFiles);
	selectedFilesRef.current = selectedFiles;
	const requestRef = useRef(request);
	requestRef.current = request;

	useEffect(() => {
		if (!session?.cwd) {
			clearDiff();
			return;
		}
		if (!files.length) {
			clearDiff();
			setSelectedFiles((cur) => ({ ...cur, [session.paneId]: null }));
			return;
		}

		const cur = selectedFilesRef.current[session.paneId] ?? null;
		const match = cur
			? files.find((f) => f.path === cur.path && f.staged === cur.staged)
			: null;
		const target = match ?? files[0]!;

		if (!cur || cur.path !== target.path || cur.staged !== target.staged) {
			setSelectedFiles((c) => ({
				...c,
				[session.paneId]: { path: target.path, staged: target.staged },
			}));
		}

		const req = requestRef.current;
		if (
			req?.cwd !== session.cwd ||
			req?.file !== target.path ||
			req?.staged !== target.staged
		) {
			loadDiff({ cwd: session.cwd, file: target.path, staged: target.staged });
		}
	}, [clearDiff, files, loadDiff, session, setSelectedFiles]);

	const cycleFile = useCallback(
		(dir: -1 | 1) => {
			if (!session?.cwd || !files.length) return;
			const idx = selectedFile
				? files.findIndex(
						(f) =>
							f.path === selectedFile.path && f.staged === selectedFile.staged
					)
				: -1;
			const next =
				dir === 1
					? idx >= files.length - 1
						? 0
						: idx + 1
					: idx <= 0
						? files.length - 1
						: idx - 1;
			const f = files[next]!;
			selectFile(session.paneId, {
				cwd: session.cwd,
				file: f.path,
				staged: f.staged,
			});
		},
		[files, selectFile, selectedFile, session]
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isEditable =
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable;
			if (isEditable) return;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				cycleFile(1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				cycleFile(-1);
			}
		};
		return listenWindowEvent("keydown", onKey);
	}, [cycleFile]);

	const closePane = useCallback(
		(paneId: string) => {
			clearAgentChatMessages(paneId);
			setClosedPaneIds((prev) => new Set(prev).add(paneId));
			if (effectiveSelectedPaneId === paneId) {
				const rest = sessions.filter((s) => s.paneId !== paneId);
				setSelectedPaneId(rest[0]?.paneId ?? null);
			}
		},
		[effectiveSelectedPaneId, sessions, setClosedPaneIds, setSelectedPaneId]
	);
	const selectEditorPane = useCallback(
		(paneId: string) => {
			setSelectedPaneId(paneId);
			onSelectPane?.(paneId);
		},
		[onSelectPane, setSelectedPaneId]
	);

	const handleAgentStatusChange = useCallback((id: string, status: string) => {
		setAgentStatuses((cur) => {
			if (cur.get(id) === status) return cur;
			return new Map(cur).set(id, status);
		});
	}, []);

	const handleSidebarDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			sidebarDragRef.current = {
				startX: e.clientX,
				startWidth: sidebarWidth,
			};

			const handleMouseMove = (e: MouseEvent) => {
				if (!sidebarDragRef.current) return;
				const delta = sidebarDragRef.current.startX - e.clientX;
				const newWidth = Math.min(
					400,
					Math.max(160, sidebarDragRef.current.startWidth + delta)
				);
				setSidebarWidth(newWidth);
			};

			const handleMouseUp = () => {
				sidebarDragRef.current = null;
				document.removeEventListener("mousemove", handleMouseMove);
				document.removeEventListener("mouseup", handleMouseUp);
			};

			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
		},
		[setSidebarWidth, sidebarWidth]
	);

	const viewer =
		mainViewMode === "diff" ? (
			diffLoading ? (
				<Placeholder label="Loading diff…" />
			) : diff && request ? (
				<DiffViewerBoundary
					resetKey={`${request.cwd}:${request.staged ? "staged" : "unstaged"}:${request.file}`}
				>
					<GitDiffView
						diff={diff}
						filePath={request.file}
						staged={request.staged}
						scrollToChange={scrollToChange}
						loading={false}
						onClose={clearDiff}
						hideHeader
						hideToolbar
						viewMode={diffViewMode}
						onViewModeChange={setDiffViewMode}
					/>
				</DiffViewerBoundary>
			) : (
				<Placeholder
					label={project ? "Select a changed file" : "No diff available"}
				/>
			)
		) : graphLoading ? (
			<div {...stylex.props(styles.centerFull)}>
				<p {...stylex.props(styles.placeholderText)}>Loading graph…</p>
			</div>
		) : (
			<CommitGraph
				commits={graphCommits}
				rows={graphRows}
				selectedHash={selectedCommitHash ?? undefined}
				onSelect={setSelectedCommitHash}
				className={stylex.props(styles.fullHeight).className}
				wipFiles={files}
				branch={project?.branch}
			/>
		);
	const fileSidebarProps = {
		cwd: session?.cwd,
		fileViewMode,
		onFileViewModeChange: setFileViewMode,
		modified,
		untracked,
		staged,
		selectedFile,
		selectedDiffStats,
		onSelectFile: (f: { path: string; staged: boolean }) =>
			session?.cwd &&
			selectFile(session.paneId, {
				cwd: session.cwd,
				file: f.path,
				staged: f.staged,
			}),
		onStageFile: stageFile,
		onUnstageFile: unstageFile,
		onStageAll: stageAll,
		onUnstageAll: unstageAll,
		hasProject: !!project,
		files,
		branch: project?.branch,
		commitMessage,
		onCommitMessageChange: setCommitMessage,
		onCommit: commit,
		isCommitting,
		amendMode,
		onAmendModeChange: setAmendMode,
	};
	const diffSidebar = sidebarVisible ? (
		<div {...stylex.props(styles.sidebarShell)} style={{ width: sidebarWidth }}>
			<div
				{...stylex.props(styles.sidebarResize)}
				onMouseDown={handleSidebarDragStart}
			/>
			<ChangeFileSidebar
				{...fileSidebarProps}
				mainViewMode="diff"
				selectedCommitHash={null}
				commitDetailsLoading={false}
				commitDetails={null}
			/>
		</div>
	) : null;
	const detailsSidebar = sidebarVisible ? (
		<div {...stylex.props(styles.sidebarShell)} style={{ width: sidebarWidth }}>
			<div
				{...stylex.props(styles.sidebarResize)}
				onMouseDown={handleSidebarDragStart}
			/>
			<ChangeFileSidebar
				{...fileSidebarProps}
				mainViewMode={mainViewMode}
				selectedCommitHash={selectedCommitHash}
				commitDetailsLoading={commitDetailsLoading}
				commitDetails={commitDetails}
			/>
		</div>
	) : null;
	const emptyWorkspace = (
		<EditorWorkspace
			viewer={<Placeholder label="No diff available" />}
			sidebar={diffSidebar}
		/>
	);
	const diffToolbar = session ? (
		<DiffViewerTopBar
			mainViewMode={mainViewMode}
			diffViewMode={diffViewMode}
			cwd={zenMode ? session.cwd : undefined}
			gitBranch={zenMode ? (project?.branch ?? null) : null}
			filePath={request?.file}
			selectedFile={selectedFile}
			diffStats={selectedDiffStats}
			sidebarVisible={sidebarVisible}
			onStageFile={stageFile}
			onUnstageFile={unstageFile}
			onToggleSidebar={setSidebarVisible.bind(null, toggleBoolean)}
			onMainViewModeChange={setMainViewMode}
			onDiffViewModeChange={setDiffViewMode}
			onGitBranchChanged={() => void refetchGit()}
			zenMode={zenMode}
			onToggleZenMode={() => updateZenMode(!zenMode)}
		/>
	) : null;

	return (
		<div {...stylex.props(styles.root)}>
			{!session ? (
				<div {...stylex.props(styles.pageGrid)}>
					<section {...stylex.props(styles.leftPane)}>
						<div {...stylex.props(styles.topBar)}>
							<span {...stylex.props(styles.topBarLabel)}>
								No active session
							</span>
							<span {...stylex.props(styles.spacer)} />
							<IconButton
								type="button"
								onClick={setShowSettings.bind(null, true)}
								variant="ghost"
								size="xs"
								title="Settings"
							>
								<IconSettings size={10} />
							</IconButton>
						</div>
						<EmptyState />
					</section>
					{emptyWorkspace}
				</div>
			) : zenMode ? (
				/* ===== ZEN MODE LAYOUT ===== */
				<EditorWorkspace
					zen
					leading={
						<EditorAgentChat
							session={session}
							chatRef={chatRef}
							onStatusChange={handleAgentStatusChange}
							composerOnly
							composerOnlyOffsetX={sidebarVisible ? -(sidebarWidth / 2) : 0}
							onExitComposerOnly={() => updateZenMode(false)}
							onDirectoryChange={onDirectoryChange}
						/>
					}
					viewer={viewer}
					toolbar={diffToolbar}
					sidebar={diffSidebar}
				/>
			) : (
				/* ===== NORMAL MODE LAYOUT ===== */
				<div {...stylex.props(styles.pageGrid)}>
					<section {...stylex.props(styles.leftPane)}>
						<EditorAgentChat
							session={session}
							chatRef={chatRef}
							onStatusChange={handleAgentStatusChange}
							onClose={closePane}
							sessions={sessions}
							onSelectSession={selectEditorPane}
							onDirectoryChange={onDirectoryChange}
						/>
					</section>

					<EditorWorkspace
						toolbar={diffToolbar}
						viewer={viewer}
						sidebar={detailsSidebar}
					/>
				</div>
			)}
			{showSettings && (
				<TerminalSettingsPanel
					themeId={themeId}
					onThemeChange={() => setSessionVersion(incrementNumber)}
					onClose={setShowSettings.bind(null, false)}
				/>
			)}
		</div>
	);
}

function EmptyState() {
	return null;
}

function Placeholder({ label }: { label: string }) {
	return (
		<div {...stylex.props(styles.centerFull, styles.centerPad)}>
			<p {...stylex.props(styles.placeholderText)}>{label}</p>
		</div>
	);
}

function EditorWorkspace({
	leading,
	toolbar,
	viewer,
	sidebar,
	zen,
}: {
	leading?: ReactNode;
	toolbar?: ReactNode;
	viewer: ReactNode;
	sidebar: ReactNode;
	zen?: boolean;
}) {
	const body = (
		<>
			{leading}
			<div {...stylex.props(toolbar ? styles.viewerColumn : styles.viewerPane)}>
				{toolbar}
				{toolbar ? (
					<div {...stylex.props(styles.diffHost)}>{viewer}</div>
				) : (
					viewer
				)}
			</div>
			{sidebar}
		</>
	);

	return zen ? (
		<div {...stylex.props(styles.zenLayout)}>{body}</div>
	) : (
		<aside {...stylex.props(styles.rightPane)}>
			<div {...stylex.props(styles.splitBody)}>{body}</div>
		</aside>
	);
}

function EditorAgentChat({
	session,
	chatRef,
	onStatusChange,
	onClose,
	sessions,
	onSelectSession,
	onDirectoryChange,
	composerOnly,
	composerOnlyOffsetX,
	onExitComposerOnly,
}: {
	session: Session;
	chatRef: React.RefObject<AgentChatHandle | null>;
	onStatusChange: (paneId: string, status: string) => void;
	onClose?: (paneId: string) => void;
	sessions?: Session[];
	onSelectSession?: (paneId: string) => void;
	onDirectoryChange?: (
		paneId: string,
		cwd: string,
		referencePaths?: string[]
	) => void;
	composerOnly?: boolean;
	composerOnlyOffsetX?: number;
	onExitComposerOnly?: () => void;
}) {
	return (
		<AgentChatView
			key={session.paneId}
			ref={chatRef}
			paneId={session.paneId}
			cwd={session.cwd}
			referencePaths={session.referencePaths}
			agentKind={session.agentKind}
			onStatusChange={onStatusChange}
			onClose={onClose}
			sessions={sessions}
			onSelectSession={onSelectSession}
			onDirectoryChange={onDirectoryChange}
			composerOnly={composerOnly}
			composerOnlyOffsetX={composerOnlyOffsetX}
			onExitComposerOnly={onExitComposerOnly}
		/>
	);
}

function ToolbarButton({
	active,
	title,
	icon,
	onClick,
}: {
	active: boolean;
	title: string;
	icon: ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			{...stylex.props(
				styles.toolbarButton,
				active && styles.toolbarButtonActive
			)}
		>
			{icon}
		</button>
	);
}

/* ── Top-bar components ─────────────────────────────────── */

function DiffViewerTopBar({
	mainViewMode,
	diffViewMode,
	cwd,
	gitBranch,
	filePath,
	selectedFile,
	diffStats,
	sidebarVisible,
	onStageFile,
	onUnstageFile,
	onToggleSidebar,
	onMainViewModeChange,
	onDiffViewModeChange,
	onGitBranchChanged,
	zenMode,
	onToggleZenMode,
}: {
	mainViewMode: "diff" | "graph";
	diffViewMode: DiffViewMode;
	cwd?: string;
	gitBranch: string | null;
	filePath?: string;
	selectedFile: SelectedFile | null;
	diffStats: ReturnType<typeof summarizeHunkDiff>;
	sidebarVisible: boolean;
	onStageFile: (path: string) => void;
	onUnstageFile: (path: string) => void;
	onToggleSidebar: () => void;
	onMainViewModeChange: (mode: "diff" | "graph") => void;
	onDiffViewModeChange: (mode: DiffViewMode) => void;
	onGitBranchChanged?: (branch?: string) => void;
	zenMode: boolean;
	onToggleZenMode: () => void;
}) {
	const fileActionTitle = selectedFile?.staged ? "Unstage file" : "Stage file";
	const dirName = cwd ? cwd.split("/").pop() || cwd : null;
	return (
		<div {...stylex.props(styles.topBar)}>
			{dirName && (
				<span {...stylex.props(styles.headerTitle)} title={cwd}>
					{dirName}
				</span>
			)}
			{gitBranch && (
				<>
					<span {...stylex.props(styles.headerMuted)}>›</span>
					{cwd ? (
						<BranchDropdown
							cwd={cwd}
							branch={gitBranch}
							onBranchChanged={onGitBranchChanged}
						/>
					) : (
						<span {...stylex.props(styles.headerBranch)} title={gitBranch}>
							{gitBranch}
						</span>
					)}
				</>
			)}
			{(dirName || gitBranch) && (
				<span {...stylex.props(styles.headerDivider)} />
			)}
			<div {...stylex.props(styles.segmented)}>
				<button
					type="button"
					onClick={() => onMainViewModeChange("diff")}
					{...stylex.props(
						styles.segmentButton,
						mainViewMode === "diff" && styles.segmentButtonActive
					)}
				>
					Diff
				</button>
				<button
					type="button"
					onClick={() => onMainViewModeChange("graph")}
					{...stylex.props(
						styles.segmentButton,
						mainViewMode === "graph" && styles.segmentButtonActive
					)}
				>
					Graph
				</button>
			</div>

			{filePath && (
				<span {...stylex.props(styles.filePathLabel)}>{filePath}</span>
			)}
			{filePath && mainViewMode === "diff" && (
				<span {...stylex.props(styles.diffStatsLabel)}>
					<span>
						{diffStats.hunks} hunk{diffStats.hunks === 1 ? "" : "s"}
					</span>
					{diffStats.added > 0 && (
						<span {...stylex.props(styles.addedText)}>+{diffStats.added}</span>
					)}
					{diffStats.removed > 0 && (
						<span {...stylex.props(styles.deletedText)}>
							-{diffStats.removed}
						</span>
					)}
				</span>
			)}
			{filePath && selectedFile && (
				<IconButton
					type="button"
					title={fileActionTitle}
					onClick={() =>
						selectedFile.staged
							? onUnstageFile(selectedFile.path)
							: onStageFile(selectedFile.path)
					}
					variant="subtle"
					size="xs"
				>
					{selectedFile.staged ? <IconX size={10} /> : <IconPlus size={10} />}
				</IconButton>
			)}
			<span {...stylex.props(styles.spacer)} />

			<div {...stylex.props(styles.segmented)}>
				<ToolbarButton
					active={diffViewMode === "split"}
					title="Split diff"
					onClick={() => onDiffViewModeChange("split")}
					icon={<IconLayoutGrid size={11} />}
				/>
				<ToolbarButton
					active={diffViewMode === "hunks"}
					title="Hunk view"
					onClick={() => onDiffViewModeChange("hunks")}
					icon={<IconGitBranch size={11} />}
				/>
				<ToolbarButton
					active={sidebarVisible}
					title={
						sidebarVisible ? "Hide changes sidebar" : "Show changes sidebar"
					}
					onClick={onToggleSidebar}
					icon={<IconPanelLeft size={11} />}
				/>
				<ToolbarButton
					active={zenMode}
					title={zenMode ? "Exit focus mode" : "Focus editor"}
					onClick={onToggleZenMode}
					icon={zenMode ? <IconCollapse size={11} /> : <IconExpand size={11} />}
				/>
			</div>
		</div>
	);
}

const styles = stylex.create({
	root: {
		display: "flex",
		height: "100%",
		minHeight: 0,
		flexDirection: "column",
		backgroundColor: color.background,
	},
	pageGrid: {
		display: "grid",
		minHeight: 0,
		flex: 1,
		gridTemplateColumns: {
			default: "1fr",
			"@media (min-width: 1024px)": "400px minmax(0, 1fr)",
		},
	},
	leftPane: {
		display: "flex",
		minWidth: 0,
		minHeight: 0,
		flexDirection: "column",
		borderRightWidth: 1,
		borderRightStyle: "solid",
		borderRightColor: color.border,
	},
	rightPane: {
		display: "flex",
		minWidth: 0,
		minHeight: 0,
		flexDirection: "column",
		backgroundColor: color.background,
	},
	splitBody: {
		display: "flex",
		minHeight: 0,
		flex: 1,
		overflow: "hidden",
	},
	viewerPane: {
		display: "flex",
		minWidth: 0,
		minHeight: 0,
		flex: 1,
		flexDirection: "column",
		overflow: "hidden",
	},
	viewerColumn: {
		display: "flex",
		minWidth: 0,
		minHeight: 0,
		flex: 1,
		flexDirection: "column",
		overflow: "hidden",
	},
	diffHost: {
		minHeight: 0,
		flex: 1,
		overflow: "hidden",
	},
	sidebarShell: {
		display: "flex",
		flexShrink: 0,
		flexDirection: "row",
		borderLeftWidth: 1,
		borderLeftStyle: "solid",
		borderLeftColor: color.border,
		backgroundColor: color.background,
	},
	sidebarResize: {
		width: controlSize._1,
		flexShrink: 0,
		cursor: "ew-resize",
		backgroundColor: {
			default: "transparent",
			":hover": color.controlActive,
		},
		transitionProperty: "background-color",
		transitionDuration: "120ms",
	},
	sidebarRestore: {
		alignItems: "center",
		backgroundColor: {
			default: color.background,
			":hover": color.controlActive,
		},
		borderLeftColor: color.border,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		color: {
			default: color.textMuted,
			":hover": color.textMain,
		},
		cursor: "pointer",
		display: "flex",
		flexShrink: 0,
		justifyContent: "center",
		transitionProperty: "background-color, color",
		transitionDuration: "120ms",
		width: controlSize._8,
	},
	zenLayout: {
		position: "relative",
		display: "flex",
		minHeight: 0,
		flex: 1,
	},
	fullHeight: {
		height: "100%",
	},
	centerFull: {
		display: "flex",
		height: "100%",
		alignItems: "center",
		justifyContent: "center",
	},
	centerPad: {
		paddingInline: controlSize._6,
	},
	topBar: {
		alignItems: "center",
		backgroundColor: color.background,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: color.border,
		display: "flex",
		flexShrink: 0,
		gap: controlSize._1_5,
		minHeight: controlSize._8,
		minWidth: 0,
		paddingBlock: controlSize._1,
		paddingInline: controlSize._3,
	},
	topBarLabel: {
		color: color.textMuted,
		fontSize: font.size_2,
		fontWeight: font.weight_5,
	},
	spacer: {
		flex: 1,
	},
	headerTitle: {
		color: color.textMain,
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	headerMuted: {
		color: color.textMuted,
		fontSize: font.size_1,
	},
	headerBranch: {
		color: color.textMuted,
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		maxWidth: 80,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	headerDivider: {
		backgroundColor: color.border,
		flexShrink: 0,
		height: controlSize._4,
		width: 1,
	},
	emptyWrap: {
		display: "flex",
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		paddingInline: controlSize._6,
	},
	emptyCard: {
		maxWidth: "28rem",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.border,
		backgroundColor: color.backgroundRaised,
		padding: controlSize._6,
		textAlign: "center",
	},
	emptyTitle: {
		color: color.textMain,
		fontSize: "0.9375rem",
		fontWeight: 600,
	},
	emptyDescription: {
		marginTop: controlSize._2,
		color: color.textMuted,
		fontSize: font.size_3,
		lineHeight: 1.65,
	},
	placeholderText: {
		maxWidth: "20rem",
		color: color.textMuted,
		fontSize: font.size_3,
		lineHeight: 1.65,
		textAlign: "center",
	},
	toolbarButton: {
		display: "flex",
		height: "100%",
		width: controlSize._6,
		alignItems: "center",
		justifyContent: "center",
		color: color.textMuted,
		transitionProperty: "background-color, color",
		transitionDuration: "120ms",
		backgroundColor: {
			default: "transparent",
			":hover": color.controlHover,
		},
		":hover": {
			color: color.textSoft,
		},
	},
	toolbarButtonActive: {
		backgroundColor: color.controlActive,
		color: color.textMain,
	},
	segmented: {
		display: "flex",
		height: controlSize._5,
		alignItems: "center",
		overflow: "hidden",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.border,
		borderRadius: "0.375rem",
		backgroundColor: color.backgroundRaised,
	},
	segmentButton: {
		height: "100%",
		color: color.textMuted,
		fontSize: "0.5rem",
		fontWeight: font.weight_5,
		paddingInline: controlSize._2,
		transitionProperty: "background-color, color",
		transitionDuration: "120ms",
		backgroundColor: {
			default: "transparent",
			":hover": color.controlHover,
		},
		":hover": {
			color: color.textSoft,
		},
	},
	segmentButtonActive: {
		backgroundColor: color.controlActive,
		color: color.textMain,
	},
	filePathLabel: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: color.textMuted,
		fontFamily: "var(--font-diff)",
		fontSize: font.size_1,
	},
	diffStatsLabel: {
		alignItems: "center",
		color: color.textMuted,
		display: "flex",
		flexShrink: 0,
		fontSize: font.size_1,
		fontVariantNumeric: "tabular-nums",
		gap: controlSize._1,
	},
	addedText: {
		color: color.gitAdded,
	},
	deletedText: {
		color: color.gitDeleted,
	},
});
