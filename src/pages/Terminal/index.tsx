import * as stylex from "@stylexjs/stylex";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import type { AgentChatHandle } from "../../components/chat/AgentChatView.tsx";
import { ProjectFileGraphView } from "../../components/graph/ProjectFileGraphView.tsx";
import { IconGitBranch } from "../../components/ui/Icons.tsx";
import { clearAgentChatPaneState } from "../../features/chat/chat-session-store.ts";
import { useGitStatus } from "../../features/git/useGitStatus.ts";
import { wsClient } from "../../lib/websocket.ts";
import { EditorPage } from "../EditorPage/index.tsx";
import { TerminalGrid } from "./TerminalGrid.tsx";
import { TerminalSettingsPanel } from "./TerminalSettingsPanel.tsx";

import "@xterm/xterm/css/xterm.css";

import {
	type AgentKind,
	cacheTerminalState,
	createTerminalPane,
	DEFAULT_FONT_FAMILY,
	DEFAULT_FONT_SIZE,
	DEFAULT_OPACITY,
	DEFAULT_ROWS,
	type GroupId,
	getInitialGroups,
	getThemeById,
	loadCanonicalTerminalState,
	loadTerminalLayoutMode,
	loadTerminalState,
	migrateGroup,
	mutateTerminalWorkspaceState,
	normalizeTerminalState,
	reduceTerminalGroups,
	saveSyncedTerminalState,
	syncTerminalLayoutMode,
	type TerminalGroupsAction,
	type TerminalLayoutMode,
	type TerminalShellChangeDetail,
	type ThemeId,
	terminalStateKey,
	terminalStateScore,
} from "../../features/terminal/terminal-utils.ts";
import {
	DEFAULT_TERMINAL_MAIN_VIEW,
	isTerminalMainView,
	type TerminalMainView,
} from "../../lib/app-navigation.tsx";
import {
	loadAppThemeId,
	mapAppThemeToTerminalTheme,
} from "../../lib/app-theme.ts";
import { TERMINAL_MAIN_VIEW_STORAGE_KEY } from "../../lib/client-storage-keys.ts";
import { hasId, isNonEmptyString } from "../../lib/data.ts";
import {
	listenWindowEvent,
	setupTerminalThemePanelShortcut,
} from "../../lib/react-events.ts";
import { readStoredValue, writeStoredValue } from "../../lib/stored-json.ts";
import { color, controlSize } from "../../tokens.stylex.ts";

const EMPTY_GRAPH_CWDS: string[] = [];

function GraphEmptyState({ message }: { message: string }) {
	return (
		<div {...stylex.props(styles.centerState, styles.centerPad)}>
			<div {...stylex.props(styles.centerTextBox)}>
				<div {...stylex.props(styles.iconBox)}>
					<IconGitBranch size={18} />
				</div>
				<p {...stylex.props(styles.centerMessage)}>{message}</p>
			</div>
		</div>
	);
}

const styles = stylex.create({
	appRoot: {
		display: "flex",
		flexDirection: "column",
		backgroundColor: color.background,
	},
	fullHeight: {
		height: "100%",
	},
	appFrame: {
		position: "relative",
		display: "flex",
		flex: 1,
		minHeight: 0,
		flexDirection: "column",
		overflow: "hidden",
	},
	appColumn: {
		display: "flex",
		flex: 1,
		minHeight: 0,
		flexDirection: "column",
		overflow: "hidden",
	},
	appBody: {
		display: "flex",
		flex: 1,
		minHeight: 0,
		overflow: "hidden",
	},
	mainPane: {
		position: "relative",
		display: "flex",
		flex: 1,
		minHeight: 0,
		flexDirection: "column",
		overflow: "hidden",
	},
	surfaceLayer: {
		position: "absolute",
		inset: 0,
		display: "flex",
		minWidth: 0,
		minHeight: 0,
		flexDirection: "column",
		overflow: "hidden",
	},
	surfaceLayerVisible: {
		pointerEvents: "auto",
		visibility: "visible",
		zIndex: 1,
	},
	surfaceLayerHidden: {
		pointerEvents: "none",
		visibility: "hidden",
		zIndex: 0,
	},
	centerState: {
		display: "flex",
		height: "100%",
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
	},
	centerPad: {
		padding: controlSize._6,
	},
	centerTextBox: {
		maxWidth: "24rem",
		textAlign: "center",
	},
	iconBox: {
		display: "flex",
		width: controlSize._12,
		height: controlSize._12,
		alignItems: "center",
		justifyContent: "center",
		marginInline: "auto",
		marginBottom: controlSize._4,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.border,
		borderRadius: controlSize._3,
		backgroundColor: color.backgroundRaised,
		color: color.textMuted,
	},
	centerMessage: {
		color: color.textMain,
		fontSize: "0.875rem",
	},
	spacer: {
		flex: 1,
	},
	emptyWorkspace: {
		flex: 1,
	},
});

type TerminalViewState = {
	layoutMode: TerminalLayoutMode;
	mainView: TerminalMainView;
};

type TerminalViewAction =
	| { type: "layoutModeChanged"; value: TerminalLayoutMode }
	| { type: "mainViewChanged"; value: TerminalMainView };

function getInitialTerminalViewState(): TerminalViewState {
	const stored = readStoredValue(TERMINAL_MAIN_VIEW_STORAGE_KEY);
	return {
		layoutMode: loadTerminalLayoutMode(),
		mainView: isTerminalMainView(stored) ? stored : DEFAULT_TERMINAL_MAIN_VIEW,
	};
}

function terminalViewReducer(
	state: TerminalViewState,
	action: TerminalViewAction
): TerminalViewState {
	switch (action.type) {
		case "layoutModeChanged":
			return { ...state, layoutMode: action.value };
		case "mainViewChanged":
			return { ...state, mainView: action.value };
	}
}

export function TerminalPage() {
	useEffect(() => {
		return wsClient.connect();
	}, []);
	const [viewState, viewDispatch] = useReducer(
		terminalViewReducer,
		undefined,
		getInitialTerminalViewState
	);
	const { layoutMode, mainView } = viewState;
	const setLayoutMode = useCallback(
		(value: TerminalLayoutMode) =>
			viewDispatch({ type: "layoutModeChanged", value }),
		[]
	);
	const setMainView = useCallback(
		(value: TerminalMainView) =>
			viewDispatch({ type: "mainViewChanged", value }),
		[]
	);
	useEffect(() => {
		writeStoredValue("terminal-layout-mode", layoutMode);
	}, [layoutMode]);
	useEffect(() => {
		writeStoredValue(TERMINAL_MAIN_VIEW_STORAGE_KEY, mainView);
	}, [mainView]);
	const initialState = useMemo(() => loadTerminalState(), []);
	const initGroups = useMemo(() => getInitialGroups(), []);
	const [groups, groupsDispatch] = useReducer(reduceTerminalGroups, initGroups);
	const [selectedGroupId, setSelectedGroupId] = useState<GroupId | null>(
		() => initialState?.selectedGroupId ?? initGroups[0]?.id ?? null
	);
	const [showSettings, setShowSettings] = useState(false);
	const [appearance, setAppearance] = useState(() => ({
		themeId: (initialState?.themeId ??
			mapAppThemeToTerminalTheme(loadAppThemeId())) as ThemeId,
		fontSize: initialState?.fontSize ?? DEFAULT_FONT_SIZE,
		fontFamily: initialState?.fontFamily ?? DEFAULT_FONT_FAMILY,
		opacity: initialState?.opacity ?? DEFAULT_OPACITY,
	}));
	const { themeId, fontSize, fontFamily, opacity } = appearance;
	const chatRefs = useRef<Map<string, AgentChatHandle>>(new Map());
	const theme = useMemo(() => getThemeById(themeId), [themeId]);
	const currentGroup = useMemo(
		() => groups.find(hasId.bind(null, selectedGroupId)),
		[groups, selectedGroupId]
	);
	const graphCwds = useMemo(
		() =>
			Array.from(
				new Set(
					(currentGroup?.panes ?? [])
						.map((pane) => pane.cwd)
						.filter(isNonEmptyString)
				)
			),
		[currentGroup]
	);
	const [activeGraphCwd, setActiveGraphCwd] = useState<string | null>(null);
	useEffect(() => {
		const selectedPaneCwd =
			currentGroup?.panes.find(
				(pane) => pane.id === currentGroup.selectedPaneId
			)?.cwd ?? null;
		if (selectedPaneCwd && graphCwds.includes(selectedPaneCwd)) {
			setActiveGraphCwd(selectedPaneCwd);
			return;
		}
		setActiveGraphCwd((current) =>
			current && graphCwds.includes(current) ? current : (graphCwds[0] ?? null)
		);
	}, [currentGroup, graphCwds]);
	const graphStatusCwds = mainView === "graph" ? graphCwds : EMPTY_GRAPH_CWDS;
	const { projectMap } = useGitStatus(graphStatusCwds, {
		enabled: mainView === "graph" && graphCwds.length > 0,
	});
	const activeGraphProject = activeGraphCwd
		? (projectMap.get(activeGraphCwd) ?? null)
		: null;
	const restoreSavedState = useCallback(
		(s: ReturnType<typeof loadTerminalState>) => {
			const normalized = normalizeTerminalState(s);
			if (!normalized) return;
			groupsDispatch({
				type: "replaceAll",
				groups: normalized.groups.map(migrateGroup),
			});
			setSelectedGroupId(normalized.selectedGroupId);
			setAppearance({
				themeId: normalized.themeId,
				fontSize: normalized.fontSize,
				fontFamily: normalized.fontFamily,
				opacity: normalized.opacity,
			});
		},
		[]
	);
	const cleanupPane = useCallback((paneId: string) => {
		wsClient.send({ type: "terminal:destroy", paneId });
		chatRefs.current.delete(paneId);
		clearAgentChatPaneState(paneId);
	}, []);
	const withSelectedGroup = useCallback(
		(fn: (groupId: string) => void) => {
			if (selectedGroupId) fn(selectedGroupId);
		},
		[selectedGroupId]
	);
	const dispatchTerminalGroupAction = useCallback(
		(action: TerminalGroupsAction, reason?: string) => {
			groupsDispatch(action);
			if (!reason) return;
			switch (action.type) {
				case "directorySelected":
				case "selectPane":
				case "setPaneAgentKind":
					void mutateTerminalWorkspaceState(action, reason);
					return;
				case "addPane":
					if ("pane" in action) {
						void mutateTerminalWorkspaceState(
							{
								type: "addPane",
								groupId: action.groupId,
								pane: action.pane,
							},
							reason
						);
					}
					return;
				case "removePane":
					void mutateTerminalWorkspaceState(
						{
							type: "removePane",
							groupId: action.groupId,
							paneId: action.paneId,
						},
						reason
					);
					return;
			}
		},
		[]
	);
	const latestStateRef = useRef({
		groups,
		selectedGroupId,
		themeId,
		fontSize,
		fontFamily,
		opacity,
	});
	const mainViewRef = useRef(mainView);
	mainViewRef.current = mainView;
	const pendingSaveRef = useRef(false);
	const startupRestoreCompleteRef = useRef(false);
	const canonicalShellKeyRef = useRef<string | null>(null);
	const latestStateKey = terminalStateKey({
		groups,
		selectedGroupId,
		themeId,
		fontSize,
		fontFamily,
		opacity,
	});
	useEffect(() => {
		const nextState = {
			groups,
			selectedGroupId,
			themeId,
			fontSize,
			fontFamily,
			opacity,
		};
		const canonicalShellKey = canonicalShellKeyRef.current;
		if (
			canonicalShellKey &&
			terminalStateKey(nextState) !== canonicalShellKey &&
			terminalStateScore(nextState) < terminalStateScore(latestStateRef.current)
		) {
			return;
		}
		latestStateRef.current = {
			groups,
			selectedGroupId,
			themeId,
			fontSize,
			fontFamily,
			opacity,
		};
		cacheTerminalState(latestStateRef.current);
	}, [groups, selectedGroupId, themeId, fontSize, fontFamily, opacity]);
	useEffect(() => {
		void latestStateKey;
		pendingSaveRef.current = true;
		const id = setTimeout(() => {
			if (!startupRestoreCompleteRef.current) {
				pendingSaveRef.current = false;
				return;
			}
			const saved = loadTerminalState();
			if (
				saved &&
				terminalStateScore(latestStateRef.current) < terminalStateScore(saved)
			) {
				pendingSaveRef.current = false;
				return;
			}
			saveSyncedTerminalState(
				latestStateRef.current,
				"terminal-page-save",
				"canonical"
			);
			pendingSaveRef.current = false;
		}, 100);
		return () => clearTimeout(id);
	}, [latestStateKey]);
	useEffect(
		() => () => {
			if (!startupRestoreCompleteRef.current) return;
			const saved = loadTerminalState();
			if (
				saved &&
				terminalStateScore(latestStateRef.current) < terminalStateScore(saved)
			) {
				return;
			}
			saveSyncedTerminalState(
				latestStateRef.current,
				"terminal-page-unmount",
				"canonical"
			);
		},
		[]
	);
	useEffect(() => {
		let cancelled = false;
		const restoreCanonicalState = async () => {
			const canonicalState = await loadCanonicalTerminalState();
			if (cancelled) return;
			if (!canonicalState) {
				startupRestoreCompleteRef.current = true;
				return;
			}
			const currentState = latestStateRef.current;
			const canonicalKey = terminalStateKey(canonicalState);
			const currentKey = terminalStateKey(currentState);
			if (
				canonicalKey !== currentKey &&
				terminalStateScore(canonicalState) >= terminalStateScore(currentState)
			) {
				canonicalShellKeyRef.current = canonicalKey;
				latestStateRef.current = canonicalState;
				restoreSavedState(canonicalState);
				saveSyncedTerminalState(
					canonicalState,
					"startup-canonical-restore",
					"canonical"
				);
			}
			startupRestoreCompleteRef.current = true;
		};
		restoreCanonicalState().catch(() => {
			startupRestoreCompleteRef.current = true;
		});
		return () => {
			cancelled = true;
		};
	}, [restoreSavedState]);
	useEffect(() => {
		const handleShellChange = (event: Event) => {
			const currentState = latestStateRef.current;
			const detail = (event as CustomEvent<TerminalShellChangeDetail>).detail;
			const saved =
				normalizeTerminalState(detail?.state) ??
				(detail?.source === "canonical" ? loadTerminalState() : null);
			if (saved?.themeId && saved.themeId !== currentState.themeId) {
				setAppearance((prev) => ({ ...prev, themeId: saved.themeId }));
			}
			const savedState = saved;
			// Always allow selectedGroupId changes (workspace switching) even during pending saves
			if (
				savedState?.selectedGroupId &&
				savedState.selectedGroupId !== currentState.selectedGroupId
			) {
				setSelectedGroupId(savedState.selectedGroupId);
				// Sync the ref immediately so the pending save doesn't revert
				latestStateRef.current = {
					...latestStateRef.current,
					selectedGroupId: savedState.selectedGroupId,
				};
			}
			if (savedState) {
				const savedShellKey = terminalStateKey(savedState);
				const currentShellKey = terminalStateKey(latestStateRef.current);
				if (savedShellKey !== currentShellKey) {
					latestStateRef.current = savedState;
					restoreSavedState(savedState);
					pendingSaveRef.current = false;
				}
			}
			// Skip the remaining external sync work during a pending save. Shell state
			// has already been reconciled above so a queued save cannot erase it.
			if (pendingSaveRef.current) {
				return;
			}
			const storedView = readStoredValue(TERMINAL_MAIN_VIEW_STORAGE_KEY);
			const nextMainView = isTerminalMainView(storedView)
				? storedView
				: DEFAULT_TERMINAL_MAIN_VIEW;
			if (nextMainView !== mainViewRef.current) {
				setMainView(nextMainView);
			}
			syncTerminalLayoutMode(setLayoutMode);
		};
		return listenWindowEvent("terminal-shell-change", handleShellChange);
	}, [restoreSavedState, setLayoutMode, setMainView]);
	useEffect(() => {
		return setupTerminalThemePanelShortcut(setShowSettings);
	}, []);
	const handleAddPane = useCallback(
		(agentKind: AgentKind) =>
			withSelectedGroup((groupId) => {
				const pane = createTerminalPane(agentKind, undefined, true);
				dispatchTerminalGroupAction(
					{
						type: "addPane",
						groupId,
						pane,
					},
					"add-pane"
				);
			}),
		[dispatchTerminalGroupAction, withSelectedGroup]
	);
	const removePane = useCallback(
		(paneId: string, force?: boolean) => {
			const group =
				groups.find((item) => item.panes.some(hasId.bind(null, paneId))) ??
				(selectedGroupId
					? groups.find(hasId.bind(null, selectedGroupId))
					: null);
			if (!group) return;
			cleanupPane(paneId);
			dispatchTerminalGroupAction(
				{
					type: "removePane",
					groupId: group.id,
					paneId,
					force,
				},
				"remove-pane"
			);
		},
		[cleanupPane, dispatchTerminalGroupAction, groups, selectedGroupId]
	);
	const reorderPanes = useCallback(
		(fromIndex: number, toIndex: number) =>
			withSelectedGroup((groupId) =>
				dispatchTerminalGroupAction({
					type: "reorderPanes",
					groupId,
					fromIndex,
					toIndex,
				})
			),
		[dispatchTerminalGroupAction, withSelectedGroup]
	);
	const handleSetPaneAgentKind = useCallback(
		(paneId: string, agentKind: AgentKind) =>
			withSelectedGroup((groupId) =>
				dispatchTerminalGroupAction(
					{
						type: "setPaneAgentKind",
						groupId,
						paneId,
						agentKind,
					},
					"set-pane-agent-kind"
				)
			),
		[dispatchTerminalGroupAction, withSelectedGroup]
	);
	const handleDirectorySelected = useCallback(
		(paneId: string, path: string | null, referencePaths?: string[]) =>
			withSelectedGroup((groupId) =>
				dispatchTerminalGroupAction(
					{
						type: "directorySelected",
						groupId,
						paneId,
						path,
						referencePaths,
					},
					"directory-selected"
				)
			),
		[dispatchTerminalGroupAction, withSelectedGroup]
	);
	const selectPane = useCallback(
		(paneId: string) =>
			withSelectedGroup((groupId) =>
				dispatchTerminalGroupAction(
					{ type: "selectPane", groupId, paneId },
					"select-pane"
				)
			),
		[dispatchTerminalGroupAction, withSelectedGroup]
	);
	const handleChatRef = useCallback(
		(paneId: string, handle: AgentChatHandle | null) => {
			if (handle) chatRefs.current.set(paneId, handle);
			else chatRefs.current.delete(paneId);
		},
		[]
	);
	const terminalGrid = currentGroup ? (
		<TerminalGrid
			active={mainView === "chat"}
			panes={currentGroup.panes}
			selectedPaneId={currentGroup.selectedPaneId}
			columns={currentGroup.columns}
			rows={currentGroup.rows ?? DEFAULT_ROWS}
			layoutMode={layoutMode}
			theme={theme}
			fontSize={fontSize}
			fontFamily={fontFamily}
			onSelectPane={selectPane}
			onClosePane={removePane}
			onDirectorySelect={handleDirectorySelected}
			onDirectoryCancel={removePane}
			onChatRef={handleChatRef}
			onReorderPanes={reorderPanes}
			onAddPane={handleAddPane}
			onSetPaneAgentKind={handleSetPaneAgentKind}
		/>
	) : null;
	const hasCurrentPanes = !!currentGroup && currentGroup.panes.length > 0;
	const graphView =
		graphCwds.length === 0 ? (
			<GraphEmptyState message="Open a project directory in one of this group's panes to populate the file graph." />
		) : (
			<ProjectFileGraphView
				cwds={graphCwds}
				activeCwd={activeGraphCwd}
				onSelectCwd={setActiveGraphCwd}
				project={activeGraphProject}
			/>
		);
	return (
		<div {...stylex.props(styles.appRoot, styles.fullHeight)}>
			<div {...stylex.props(styles.appFrame)}>
				<div {...stylex.props(styles.appColumn)}>
					<div {...stylex.props(styles.appBody)}>
						<div {...stylex.props(styles.mainPane)}>
							{!hasCurrentPanes ? (
								<div {...stylex.props(styles.emptyWorkspace)} />
							) : (
								<>
									<div
										{...stylex.props(
											styles.surfaceLayer,
											mainView === "chat"
												? styles.surfaceLayerVisible
												: styles.surfaceLayerHidden
										)}
										aria-hidden={mainView !== "chat"}
									>
										{terminalGrid}
									</div>
									<div
										{...stylex.props(
											styles.surfaceLayer,
											mainView === "editor"
												? styles.surfaceLayerVisible
												: styles.surfaceLayerHidden
										)}
										aria-hidden={mainView !== "editor"}
									>
										<EditorPage
											active={mainView === "editor"}
											groups={groups}
											selectedGroupId={selectedGroupId}
											themeId={themeId}
											onSelectPane={selectPane}
											onDirectoryChange={handleDirectorySelected}
										/>
									</div>
									{mainView === "graph" && (
										<div
											{...stylex.props(
												styles.surfaceLayer,
												styles.surfaceLayerVisible
											)}
										>
											{graphView}
										</div>
									)}
								</>
							)}
							{showSettings && (
								<TerminalSettingsPanel
									themeId={themeId}
									onThemeChange={(v: ThemeId) =>
										setAppearance((prev) => ({ ...prev, themeId: v }))
									}
									onClose={setShowSettings.bind(null, false)}
								/>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
