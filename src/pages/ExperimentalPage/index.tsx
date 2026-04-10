import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ClaudeChatHandle,
	ClaudeChatView,
	clearChatMessages,
} from "../../components/chat/ClaudeChatView.tsx";
import { CommitGraph } from "../../components/git/CommitGraph.tsx";
import {
	IconGitBranch,
	IconLayoutGrid,
	IconLayoutRows,
	IconPanelRight,
	IconZen,
} from "../../components/ui/Icons.tsx";
import { useCommitDetails, useGitGraph } from "../../hooks/useGitGraph.ts";
import { useAgentSessions } from "../../hooks/useAgentSessions.ts";
import { type DiffRequest, useGitDiff } from "../../hooks/useGitDiff.ts";
import {
	type GitFileEntry,
	type GitProjectStatus,
	useGitStatus,
} from "../../hooks/useGitStatus.ts";
import { getAgentIcon } from "../../lib/agent-ui.tsx";
import { getAgentDefinition, isChatAgentKind } from "../../lib/agents.ts";
import {
	getStatusInfo,
	getThemeById,
	loadTerminalState,
	type TerminalGroupModel,
} from "../../lib/terminal-utils.ts";
import {
	ActivityIndicator,
	useActivityFeed,
} from "../../features/activity-feed/index.ts";
import { useFileWatcher } from "../../features/file-watcher/useFileWatcher.ts";
import { wsClient } from "../../lib/websocket.ts";
import { type DiffViewMode, GitDiffView } from "../Terminal/GitDiffView.tsx";
import { StatusIcon } from "../Terminal/StatusIcon.tsx";

interface Session {
	groupId: string;
	groupName: string;
	paneId: string;
	paneTitle: string;
	agentKind: "claude" | "codex";
	cwd?: string;
	messageCount: number;
}

interface SelectedFile {
	path: string;
	staged: boolean;
}

let cachedKey = "";
let cachedSessions: Session[] = [];

function flattenSessions(groups: TerminalGroupModel[]): Session[] {
	return groups.flatMap((g) =>
		g.panes.flatMap((p) =>
			isChatAgentKind(p.agentKind)
				? [
						{
							groupId: g.id,
							groupName: g.name,
							paneId: p.id,
							paneTitle: p.title,
							agentKind: p.agentKind,
							cwd: p.cwd,
							messageCount: 0,
						},
					]
				: []
		)
	);
}

function stableSessions(next: Session[]): Session[] {
	const key = next.map((s) => s.paneId).join(",");
	if (key === cachedKey) return cachedSessions;
	cachedKey = key;
	cachedSessions = next;
	return next;
}

function getAllFiles(project: GitProjectStatus | null): GitFileEntry[] {
	if (!project) return [];
	return [
		...project.files.filter((f) => !f.staged),
		...project.files.filter((f) => f.staged),
	];
}

function basename(p?: string): string {
	if (!p) return "No directory";
	return p.split("/").pop() || p;
}

export function ExperimentalPage() {
	const [, setTick] = useState(0);
	const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
	const [selectedFiles, setSelectedFiles] = useState<
		Record<string, SelectedFile | null>
	>({});
	const [agentStatuses, setAgentStatuses] = useState<Map<string, string>>(
		new Map()
	);
	const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("split");
	const [closedPaneIds, setClosedPaneIds] = useState<Set<string>>(new Set());
	const [commitMessage, setCommitMessage] = useState("");
	const [isCommitting, setIsCommitting] = useState(false);
	const [scrollToChange, setScrollToChange] = useState(0);
	const [zenMode, setZenMode] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(224); // Default w-56 = 224px
	const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(
		null
	);
	const [fileViewMode, setFileViewMode] = useState<"path" | "tree">("path");
	const [mainViewMode, setMainViewMode] = useState<"diff" | "graph">("diff");
	const chatRef = useRef<ClaudeChatHandle>(null);
	const sidebarDragRef = useRef<{
		startX: number;
		startWidth: number;
	} | null>(null);

	const terminalState = useMemo(() => loadTerminalState(), []);
	const allSessions = useMemo(
		() => stableSessions(flattenSessions(terminalState?.groups ?? [])),
		[terminalState]
	);
	const sessions = useMemo(
		() => allSessions.filter((s) => !closedPaneIds.has(s.paneId)),
		[allSessions, closedPaneIds]
	);
	const { sessions: liveAgentSessions } = useAgentSessions();
	const trackedDirs = useMemo(
		() => [...new Set(sessions.map((s) => s.cwd).filter(Boolean))],
		[sessions]
	);
	const { projectMap } = useGitStatus(trackedDirs);
	const theme = useMemo(
		() => getThemeById(terminalState?.themeId ?? "default"),
		[terminalState?.themeId]
	);
	const {
		diff,
		request,
		loading: diffLoading,
		loadDiff,
		clear: clearDiff,
	} = useGitDiff();

	const refresh = useCallback(() => setTick((v) => v + 1), []);

	// Ensure WebSocket is connected
	useEffect(() => {
		wsClient.connect();
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
		if (!sessions.length) {
			setSelectedPaneId(null);
			return;
		}
		setSelectedPaneId((cur) =>
			cur && sessions.some((s) => s.paneId === cur) ? cur : sessions[0]?.paneId
		);
	}, [sessions]);

	const sessionIdx = useMemo(
		() => sessions.findIndex((s) => s.paneId === selectedPaneId),
		[sessions, selectedPaneId]
	);
	const session =
		sessionIdx >= 0 ? sessions[sessionIdx] : (sessions[0] ?? null);
	const project = session?.cwd ? (projectMap.get(session.cwd) ?? null) : null;
	const files = useMemo(() => getAllFiles(project), [project]);
	const staged = project?.files.filter((f) => f.staged) ?? [];
	const modified =
		project?.files.filter((f) => !f.staged && f.status !== "?") ?? [];
	const untracked = project?.files.filter((f) => f.status === "?") ?? [];
	const selectedFile = session ? (selectedFiles[session.paneId] ?? null) : null;

	// Fetch commit graph when in graph view
	const { commits: graphCommits, loading: graphLoading } = useGitGraph(
		mainViewMode === "graph" ? session?.cwd : undefined,
		100
	);

	// Fetch commit details when a commit is selected
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
		[loadDiff]
	);

	const { events: activityEvents } = useActivityFeed({
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
			[session?.paneId]
		),
		onDiffLoaded: useCallback(() => {
			refresh();
			setTimeout(() => setScrollToChange((v) => v + 1), 50);
		}, [refresh]),
	});

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
	}, [clearDiff, files, loadDiff, session]);

	const cycleSession = useCallback(
		(dir: -1 | 1) => {
			if (!sessions.length) return;
			const idx = sessionIdx >= 0 ? sessionIdx : 0;
			const next =
				dir === 1
					? idx >= sessions.length - 1
						? 0
						: idx + 1
					: idx <= 0
						? sessions.length - 1
						: idx - 1;
			setSelectedPaneId(sessions[next]?.paneId);
		},
		[sessionIdx, sessions]
	);

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
			// Skip if user is in an input field or textarea
			const target = e.target as HTMLElement;
			const isEditable =
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable;
			if (isEditable) return;

			if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				e.preventDefault();
				cycleSession(e.key === "ArrowLeft" ? -1 : 1);
				setTimeout(() => chatRef.current?.focusInput(true), 50);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				cycleFile(1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				cycleFile(-1);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [cycleFile, cycleSession]);

	const closePane = useCallback(
		(paneId: string) => {
			clearChatMessages(paneId);
			setClosedPaneIds((prev) => new Set(prev).add(paneId));
			if (selectedPaneId === paneId) {
				const rest = sessions.filter((s) => s.paneId !== paneId);
				setSelectedPaneId(rest[0]?.paneId ?? null);
			}
		},
		[selectedPaneId, sessions]
	);

	const gitAction = useCallback(
		async (endpoint: string, body: object) => {
			await fetch(`/api/git/${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			refresh();
		},
		[refresh]
	);

	const stageFile = useCallback(
		(file: string) =>
			session?.cwd && gitAction("stage", { cwd: session.cwd, file }),
		[session?.cwd, gitAction]
	);
	const unstageFile = useCallback(
		(file: string) =>
			session?.cwd && gitAction("unstage", { cwd: session.cwd, file }),
		[session?.cwd, gitAction]
	);
	const stageAll = useCallback(
		() => session?.cwd && gitAction("stage", { cwd: session.cwd }),
		[session?.cwd, gitAction]
	);
	const unstageAll = useCallback(
		() => session?.cwd && gitAction("unstage", { cwd: session.cwd }),
		[session?.cwd, gitAction]
	);

	const handleCommit = useCallback(async () => {
		if (!session?.cwd || !commitMessage.trim() || isCommitting) return;
		setIsCommitting(true);
		try {
			const res = await fetch("/api/git/commit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: session.cwd, message: commitMessage }),
			});
			const result = await res.json();
			if (result.success) {
				setCommitMessage("");
				refresh();
			}
		} finally {
			setIsCommitting(false);
		}
	}, [session?.cwd, commitMessage, isCommitting, refresh]);

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
		[sidebarWidth]
	);

	return (
		<div className="flex h-full min-h-0 flex-col bg-surgent-bg">
			<div className="electrobun-webkit-app-region-drag relative flex h-12 shrink-0 items-center gap-2 border-b border-surgent-border bg-surgent-bg px-2">
				<div className="electrobun-webkit-app-region-no-drag relative z-10 min-w-0 shrink-0 overflow-x-auto">
					<AgentStrip
						sessions={sessions}
						statuses={agentStatuses}
						selectedId={session?.paneId ?? null}
						onSelect={setSelectedPaneId}
						onClose={closePane}
					/>
				</div>
				<div className="flex-1 min-w-0" />
				{/* Main view mode toggle: Diff / Graph */}
				<div className="electrobun-webkit-app-region-no-drag relative z-10 flex shrink-0 items-center rounded-lg border border-surgent-border bg-surgent-surface overflow-hidden h-7">
					<button
						type="button"
						onClick={() => setMainViewMode("diff")}
						className={`px-2.5 h-full text-[10px] font-medium transition-all ${
							mainViewMode === "diff"
								? "bg-surgent-text/10 text-surgent-text"
								: "text-surgent-text-3 hover:text-surgent-text-2"
						}`}
					>
						Diff
					</button>
					<button
						type="button"
						onClick={() => setMainViewMode("graph")}
						className={`px-2.5 h-full text-[10px] font-medium transition-all ${
							mainViewMode === "graph"
								? "bg-surgent-text/10 text-surgent-text"
								: "text-surgent-text-3 hover:text-surgent-text-2"
						}`}
					>
						Graph
					</button>
				</div>
				{/* Diff view mode buttons */}
				<div className="electrobun-webkit-app-region-no-drag relative z-10 flex shrink-0 items-center rounded-lg border border-surgent-border bg-surgent-surface overflow-hidden h-7">
					<ToolbarButton
						active={diffViewMode === "split"}
						title="Split diff"
						onClick={() => setDiffViewMode("split")}
						icon={<IconLayoutGrid size={13} />}
					/>
					<ToolbarButton
						active={diffViewMode === "stacked"}
						title="Vertical diff"
						onClick={() => setDiffViewMode("stacked")}
						icon={<IconLayoutRows size={13} />}
					/>
					<ToolbarButton
						active={diffViewMode === "hunks"}
						title="Hunk view"
						onClick={() => setDiffViewMode("hunks")}
						icon={<IconGitBranch size={13} />}
					/>
				</div>
				<button
					type="button"
					onClick={() => setZenMode((v) => !v)}
					title={zenMode ? "Zen mode: ON" : "Zen mode: OFF"}
					className={`electrobun-webkit-app-region-no-drag relative z-10 flex shrink-0 items-center justify-center rounded-lg border border-surgent-border bg-surgent-surface h-7 w-7 transition-all ${
						zenMode
							? "bg-surgent-text/10 text-surgent-text"
							: "text-surgent-text-3 hover:text-surgent-text-2"
					}`}
				>
					<IconZen size={13} />
				</button>
			</div>

			{!session ? (
				<EmptyState />
			) : (
				<div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
					<section className="flex min-h-0 min-w-0 flex-col border-r border-surgent-border">
						<div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-surgent-border bg-surgent-text/[0.02]">
							<span className="text-surgent-accent">
								{getAgentIcon(session.agentKind, 10)}
							</span>
							<span className="text-[10px] font-medium text-surgent-text-2">
								{getAgentDefinition(session.agentKind).label}
							</span>
							{session.cwd && (
								<>
									<span className="text-[10px] text-surgent-text-3">›</span>
									<span
										className="text-[10px] font-medium text-surgent-text truncate"
										title={session.cwd}
									>
										{session.cwd.split("/").pop() || session.cwd}
									</span>
								</>
							)}
							<span className="flex-1" />
							<ActivityIndicator events={activityEvents} />
							<button
								type="button"
								onClick={() => closePane(session.paneId)}
								className="flex items-center justify-center h-4 w-4 rounded transition-colors text-surgent-text-3 hover:text-red-400 hover:bg-red-500/15"
								title="Close session"
							>
								<svg
									aria-hidden
									width="8"
									height="8"
									viewBox="0 0 8 8"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
								>
									<path d="M1 1l6 6M7 1l-6 6" />
								</svg>
							</button>
						</div>
						<div className="flex-1 min-h-0">
							<ClaudeChatView
								key={session.paneId}
								ref={chatRef}
								paneId={session.paneId}
								cwd={session.cwd}
								agentKind={session.agentKind}
								theme={theme}
								onStatusChange={(id, status) => {
									setAgentStatuses((cur) => {
										if (cur.get(id) === status) return cur;
										return new Map(cur).set(id, status);
									});
								}}
							/>
						</div>
					</section>

					<aside className="min-h-0 min-w-0 bg-surgent-bg">
						<div className="flex h-full min-h-0 flex-col">
							<div className="flex min-h-0 flex-1 overflow-hidden">
								<div className="min-h-0 min-w-0 flex-1 overflow-hidden">
									{mainViewMode === "diff" ? (
										// Diff View
										diffLoading ? (
											<Placeholder label="Loading diff..." />
										) : diff && request ? (
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
										) : (
											<Placeholder
												label={
													project
														? "Select a changed file"
														: "No diff available"
												}
											/>
										)
									) : // Graph View - full width, details show in sidebar
									graphLoading ? (
										<div className="flex items-center justify-center h-full">
											<p className="text-[11px] text-surgent-text-3">
												Loading graph...
											</p>
										</div>
									) : (
										<CommitGraph
											commits={graphCommits}
											selectedHash={selectedCommitHash ?? undefined}
											onSelect={setSelectedCommitHash}
											className="h-full"
											wipFiles={files}
											branch={project?.branch}
										/>
									)}
								</div>

								{sidebarCollapsed ? (
									<button
										type="button"
										onClick={() => setSidebarCollapsed(false)}
										title="Show file sidebar"
										className="shrink-0 flex items-center justify-center w-6 border-l border-surgent-border bg-surgent-bg text-surgent-text-3 hover:text-surgent-text-2 hover:bg-surgent-text/5 transition-all"
									>
										<IconPanelRight size={12} />
									</button>
								) : (
									<div
										className="flex shrink-0 flex-row border-l border-surgent-border bg-surgent-bg"
										style={{ width: sidebarWidth }}
									>
										{/* Drag handle for resizing sidebar */}
										<div
											className="w-1 cursor-ew-resize bg-transparent hover:bg-surgent-accent/30 transition-colors shrink-0"
											onMouseDown={handleSidebarDragStart}
										/>
										<div className="flex flex-1 flex-col min-w-0">
											{/* Sidebar Header */}
											<div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-surgent-border bg-surgent-bg px-2.5 py-2">
												<IconGitBranch
													size={12}
													className="shrink-0 text-surgent-text-3"
												/>
												<span className="flex-1 truncate text-[11px] font-medium text-surgent-text">
													{project?.branch ?? "No repo"}
												</span>
												<button
													type="button"
													onClick={() => setSidebarCollapsed(true)}
													title="Hide sidebar"
													className="shrink-0 flex items-center justify-center rounded w-5 h-5 text-surgent-text-3 hover:text-surgent-text-2 hover:bg-surgent-text/10 transition-all"
												>
													<IconPanelRight size={12} />
												</button>
											</div>

											{/* Files View */}
											{mainViewMode !== "graph" && (
												<div className="flex-1 min-h-0 overflow-y-auto">
													{/* Path/Tree toggle */}
													<div className="sticky top-0 z-20 flex items-center justify-end gap-1 px-2 py-1 border-b border-surgent-border/30 bg-surgent-bg">
														<div className="flex items-center rounded border border-surgent-border bg-surgent-surface overflow-hidden">
															<button
																type="button"
																onClick={() => setFileViewMode("path")}
																title="Path view"
																className={`px-1.5 py-0.5 text-[8px] font-medium transition-all ${
																	fileViewMode === "path"
																		? "bg-surgent-text/10 text-surgent-text"
																		: "text-surgent-text-3 hover:text-surgent-text-2"
																}`}
															>
																Path
															</button>
															<button
																type="button"
																onClick={() => setFileViewMode("tree")}
																title="Tree view"
																className={`px-1.5 py-0.5 text-[8px] font-medium transition-all ${
																	fileViewMode === "tree"
																		? "bg-surgent-text/10 text-surgent-text"
																		: "text-surgent-text-3 hover:text-surgent-text-2"
																}`}
															>
																Tree
															</button>
														</div>
													</div>
													<FileGroup
														title="Unstaged"
														files={[...modified, ...untracked]}
														color="text-surgent-text-2"
														selected={selectedFile}
														onSelect={(f) =>
															session.cwd &&
															selectFile(session.paneId, {
																cwd: session.cwd,
																file: f.path,
																staged: f.staged,
															})
														}
														actionLabel="Stage"
														onAction={stageFile}
														onActionAll={stageAll}
														viewMode={fileViewMode}
													/>
													<FileGroup
														title="Staged"
														files={staged}
														color="text-git-added"
														selected={selectedFile}
														onSelect={(f) =>
															session.cwd &&
															selectFile(session.paneId, {
																cwd: session.cwd,
																file: f.path,
																staged: f.staged,
															})
														}
														actionLabel="Unstage"
														onAction={unstageFile}
														onActionAll={unstageAll}
														viewMode={fileViewMode}
													/>

													{project && !project.files.length && (
														<div className="flex items-center justify-center py-6">
															<p className="text-[10px] text-surgent-text-3/50">
																Clean
															</p>
														</div>
													)}
													{!project && (
														<div className="flex items-center justify-center py-6">
															<p className="px-3 text-center text-[10px] text-surgent-text-3/50">
																No repository
															</p>
														</div>
													)}
												</div>
											)}

											{/* Graph View - show commit details or WIP files in sidebar */}
											{mainViewMode === "graph" && (
												<div className="flex-1 min-h-0 overflow-y-auto">
													{selectedCommitHash === "wip" ? (
														// WIP selected - show current changes
														<>
															<div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 border-b border-surgent-border bg-surgent-bg">
																<div className="w-3 h-3 rounded-full border-2 border-dashed border-surgent-accent" />
																<span className="text-[11px] font-medium text-surgent-text">
																	WIP on {project?.branch ?? "branch"}
																</span>
																<span className="ml-auto text-[9px] text-surgent-text-3">
																	{files.length} files
																</span>
															</div>
															<div className="py-1">
																{files.map((f, i) => (
																	<div
																		key={i}
																		className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-surgent-text/5"
																	>
																		<FileStatusIcon status={f.status} />
																		<span className="flex-1 truncate text-[10px] font-mono text-surgent-text-2">
																			{f.path}
																		</span>
																	</div>
																))}
																{files.length === 0 && (
																	<div className="flex items-center justify-center py-6">
																		<p className="text-[10px] text-surgent-text-3/50">
																			No changes
																		</p>
																	</div>
																)}
															</div>
														</>
													) : selectedCommitHash ? (
														// Commit selected - show commit details
														commitDetailsLoading ? (
															<div className="flex items-center justify-center py-8">
																<p className="text-[10px] text-surgent-text-3">
																	Loading...
																</p>
															</div>
														) : commitDetails ? (
															<CommitDetailsPanel details={commitDetails} />
														) : (
															<div className="flex items-center justify-center py-8">
																<p className="text-[10px] text-surgent-text-3">
																	No details
																</p>
															</div>
														)
													) : (
														// Nothing selected
														<div className="flex items-center justify-center py-8">
															<p className="text-[10px] text-surgent-text-3 px-4 text-center">
																Select a commit to view details
															</p>
														</div>
													)}
												</div>
											)}

											{/* Commit Section - only show when not in graph view */}
											{project && mainViewMode !== "graph" && (
												<div className="shrink-0 border-t border-surgent-border">
													{/* Commit header */}
													<div className="flex items-center justify-between px-2.5 py-1.5 border-b border-surgent-border/50">
														<div className="flex items-center gap-1.5">
															<svg
																className="w-3 h-3 text-surgent-text-3"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																strokeWidth="2"
															>
																<circle cx="12" cy="12" r="4" />
																<line x1="1.05" y1="12" x2="7" y2="12" />
																<line x1="17.01" y1="12" x2="22.96" y2="12" />
															</svg>
															<span className="text-[9px] font-medium text-surgent-text-2">
																Commit
															</span>
														</div>
														{commitMessage.length > 0 && (
															<span
																className={`text-[9px] tabular-nums ${commitMessage.length > 72 ? "text-amber-400" : "text-surgent-text-3"}`}
															>
																{commitMessage.length}
															</span>
														)}
													</div>
													<div className="p-2 space-y-2">
														{/* Summary line */}
														<input
															type="text"
															value={commitMessage.split("\n")[0] || ""}
															onChange={(e) => {
																const lines = commitMessage.split("\n");
																lines[0] = e.target.value;
																setCommitMessage(lines.join("\n"));
															}}
															placeholder="Summary (required)"
															className="w-full rounded border border-surgent-border bg-surgent-surface px-2 py-1.5 text-[11px] text-surgent-text placeholder:text-surgent-text-3/50 focus:border-surgent-accent focus:outline-none"
															onKeyDown={(e) => {
																if (
																	e.key === "Enter" &&
																	(e.metaKey || e.ctrlKey)
																) {
																	e.preventDefault();
																	handleCommit();
																}
															}}
														/>
														{/* Description */}
														<textarea
															value={commitMessage
																.split("\n")
																.slice(1)
																.join("\n")}
															onChange={(e) => {
																const summary =
																	commitMessage.split("\n")[0] || "";
																setCommitMessage(
																	summary +
																		(e.target.value
																			? "\n" + e.target.value
																			: "")
																);
															}}
															placeholder="Description (optional)"
															className="w-full resize-none rounded border border-surgent-border bg-surgent-surface px-2 py-1.5 text-[10px] text-surgent-text placeholder:text-surgent-text-3/50 focus:border-surgent-accent focus:outline-none"
															rows={2}
														/>
														{/* Commit button */}
														<button
															type="button"
															onClick={handleCommit}
															disabled={
																!commitMessage.trim() ||
																!staged.length ||
																isCommitting
															}
															className="w-full flex items-center justify-center gap-1.5 rounded bg-surgent-accent hover:bg-surgent-accent/90 px-3 py-1.5 text-[10px] font-medium text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
														>
															<svg
																className="w-3 h-3"
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																strokeWidth="2"
															>
																<circle cx="12" cy="12" r="4" />
																<line x1="1.05" y1="12" x2="7" y2="12" />
																<line x1="17.01" y1="12" x2="22.96" y2="12" />
															</svg>
															{isCommitting
																? "Committing..."
																: `Commit Changes to ${staged.length} File${staged.length !== 1 ? "s" : ""}`}
														</button>
													</div>
												</div>
											)}
										</div>
									</div>
								)}
							</div>
						</div>
					</aside>
				</div>
			)}
		</div>
	);
}

function AgentStrip({
	sessions,
	statuses,
	selectedId,
	onSelect,
	onClose,
}: {
	sessions: Session[];
	statuses: Map<string, string>;
	selectedId: string | null;
	onSelect: (id: string) => void;
	onClose: (id: string) => void;
}) {
	return (
		<div className="flex items-center gap-1 overflow-x-auto py-1">
			{sessions.map((s) => {
				const selected = s.paneId === selectedId;
				const info = getStatusInfo(statuses.get(s.paneId) ?? "idle");
				return (
					<div
						key={s.paneId}
						className={`group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 cursor-pointer transition-colors ${
							selected
								? "bg-surgent-surface-2 text-surgent-text"
								: "text-surgent-text-3 hover:bg-surgent-surface hover:text-surgent-text-2"
						}`}
						title={`${basename(s.cwd)} - ${getAgentDefinition(s.agentKind).label}`}
						onClick={() => onSelect(s.paneId)}
					>
						<StatusIcon
							iconType={info.iconType}
							size={12}
							className={info.iconColor}
						/>
						<span className="max-w-[110px] truncate text-[10px] font-medium">
							{basename(s.cwd)}
						</span>
						{s.messageCount > 0 && (
							<span
								className={`rounded-md px-1.5 py-0.5 text-[9px] tabular-nums ${selected ? "bg-surgent-text/10 text-surgent-text" : "bg-surgent-text/5 text-surgent-text-3"}`}
							>
								{s.messageCount}
							</span>
						)}
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onClose(s.paneId);
							}}
							className="ml-0.5 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-surgent-text/10 transition-opacity"
							title="Close"
						>
							<svg
								aria-hidden
								width="8"
								height="8"
								viewBox="0 0 8 8"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							>
								<path d="M1 1l6 6M7 1L1 7" />
							</svg>
						</button>
					</div>
				);
			})}
		</div>
	);
}

function EmptyState() {
	return (
		<div className="flex flex-1 items-center justify-center px-6">
			<div className="max-w-md border border-surgent-border bg-surgent-surface p-6 text-center">
				<h2 className="text-[15px] font-semibold text-surgent-text">
					No saved agent sessions
				</h2>
				<p className="mt-2 text-[12px] leading-5 text-surgent-text-3">
					Open Claude or Codex in the terminal page, pick a project directory,
					and it will appear here.
				</p>
			</div>
		</div>
	);
}

function Placeholder({ label }: { label: string }) {
	return (
		<div className="flex h-full items-center justify-center px-6">
			<p className="max-w-xs text-center text-[12px] leading-5 text-surgent-text-3">
				{label}
			</p>
		</div>
	);
}

// Commit details panel for graph view
function CommitDetailsPanel({
	details,
}: {
	details: {
		hash: string;
		message: string;
		author: string;
		date: string;
		files: Array<{
			path: string;
			status: string;
			additions: number;
			deletions: number;
		}>;
	};
}) {
	return (
		<div className="flex flex-col h-full">
			{/* Commit info header */}
			<div className="shrink-0 border-b border-surgent-border p-3 space-y-2">
				<div className="flex items-center gap-2">
					<span className="font-mono text-[11px] text-surgent-accent font-medium">
						{details.hash.slice(0, 7)}
					</span>
					<span className="text-[10px] text-surgent-text-3">
						{details.date}
					</span>
				</div>
				<p className="text-[11px] text-surgent-text leading-relaxed">
					{details.message}
				</p>
				<p className="text-[10px] text-surgent-text-2">{details.author}</p>
			</div>

			{/* Files changed */}
			<div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-surgent-border/50 bg-surgent-text/[0.02]">
				<span className="text-[9px] font-medium text-surgent-text-2">
					Files Changed
				</span>
				<span className="text-[9px] text-surgent-text-3">
					{details.files.length}
				</span>
			</div>

			{/* File list */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				{details.files.map((file, i) => (
					<div
						key={i}
						className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-surgent-text/5 cursor-pointer"
					>
						<FileStatusIcon status={file.status} />
						<span className="flex-1 truncate text-[10px] font-mono text-surgent-text-2">
							{file.path.split("/").pop()}
						</span>
						<div className="shrink-0 flex items-center gap-1 text-[9px] tabular-nums">
							{file.additions > 0 && (
								<span className="text-git-added">+{file.additions}</span>
							)}
							{file.deletions > 0 && (
								<span className="text-git-deleted">-{file.deletions}</span>
							)}
						</div>
					</div>
				))}
			</div>

			{/* Stats summary */}
			<div className="shrink-0 flex items-center justify-center gap-3 px-3 py-2 border-t border-surgent-border text-[10px]">
				<span className="text-git-added">
					+{details.files.reduce((sum, f) => sum + f.additions, 0)}
				</span>
				<span className="text-git-deleted">
					-{details.files.reduce((sum, f) => sum + f.deletions, 0)}
				</span>
			</div>
		</div>
	);
}

// File status icon component
function FileStatusIcon({ status }: { status: string }) {
	// M = modified, A = added, D = deleted, R = renamed, ? = untracked
	const getStatusConfig = () => {
		switch (status) {
			case "M":
				return {
					icon: "M",
					color: "text-amber-400",
					bg: "bg-amber-400/15",
					title: "Modified",
				};
			case "A":
				return {
					icon: "+",
					color: "text-git-added",
					bg: "bg-git-added/15",
					title: "Added",
				};
			case "D":
				return {
					icon: "−",
					color: "text-git-deleted",
					bg: "bg-git-deleted/15",
					title: "Deleted",
				};
			case "R":
				return {
					icon: "R",
					color: "text-blue-400",
					bg: "bg-blue-400/15",
					title: "Renamed",
				};
			case "?":
				return {
					icon: "?",
					color: "text-surgent-text-3",
					bg: "bg-surgent-text/10",
					title: "Untracked",
				};
			default:
				return {
					icon: "•",
					color: "text-surgent-text-3",
					bg: "bg-surgent-text/10",
					title: status,
				};
		}
	};

	const config = getStatusConfig();
	return (
		<span
			className={`shrink-0 flex items-center justify-center w-4 h-4 rounded text-[8px] font-bold ${config.color} ${config.bg}`}
			title={config.title}
		>
			{config.icon}
		</span>
	);
}

// Build tree structure from flat file list
interface TreeNode {
	name: string;
	path: string;
	children: Map<string, TreeNode>;
	file?: GitFileEntry;
}

function buildFileTree(files: GitFileEntry[]): TreeNode {
	const root: TreeNode = { name: "", path: "", children: new Map() };

	for (const file of files) {
		const parts = file.path.split("/");
		let current = root;
		let currentPath = "";

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			if (!current.children.has(part)) {
				current.children.set(part, {
					name: part,
					path: currentPath,
					children: new Map(),
				});
			}
			current = current.children.get(part)!;

			// If this is the last part, attach the file
			if (i === parts.length - 1) {
				current.file = file;
			}
		}
	}

	return root;
}

function TreeNodeRow({
	node,
	depth,
	selected,
	onSelect,
	onAction,
	actionLabel,
	expandedDirs,
	toggleDir,
}: {
	node: TreeNode;
	depth: number;
	selected: SelectedFile | null;
	onSelect: (f: GitFileEntry) => void;
	onAction?: (path: string) => void;
	actionLabel?: string;
	expandedDirs: Set<string>;
	toggleDir: (path: string) => void;
}) {
	const isDir = node.children.size > 0 && !node.file;
	const isExpanded = expandedDirs.has(node.path);
	const file = node.file;
	const active =
		file && selected?.path === file.path && selected?.staged === file.staged;

	const sortedChildren = [...node.children.values()].sort((a, b) => {
		// Directories first
		const aIsDir = a.children.size > 0 && !a.file;
		const bIsDir = b.children.size > 0 && !b.file;
		if (aIsDir && !bIsDir) return -1;
		if (!aIsDir && bIsDir) return 1;
		return a.name.localeCompare(b.name);
	});

	return (
		<>
			<div
				className={`group flex h-[26px] items-center gap-1 cursor-pointer transition-colors ${
					active ? "bg-surgent-accent/10" : "hover:bg-surgent-text/5"
				}`}
				style={{ paddingLeft: `${8 + depth * 12}px` }}
				onClick={() => {
					if (isDir) {
						toggleDir(node.path);
					} else if (file) {
						onSelect(file);
					}
				}}
			>
				{isDir ? (
					<>
						<svg
							className={`w-2.5 h-2.5 text-surgent-text-3 transition-transform shrink-0 ${isExpanded ? "rotate-90" : ""}`}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						>
							<polyline points="9 18 15 12 9 6" />
						</svg>
						<svg
							className="w-3 h-3 text-surgent-text-3 shrink-0"
							viewBox="0 0 24 24"
							fill="currentColor"
						>
							<path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
						</svg>
						<span className="truncate text-[10px] text-surgent-text-2">
							{node.name}
						</span>
					</>
				) : file ? (
					<>
						<FileStatusIcon status={file.status} />
						<span
							className={`truncate text-[10px] font-mono transition-colors ${
								active
									? "text-surgent-text"
									: "text-surgent-text-2 group-hover:text-surgent-text"
							}`}
						>
							{node.name}
						</span>
						{onAction && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onAction(file.path);
								}}
								className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 rounded px-1 py-0.5 text-[8px] text-surgent-text-3 hover:bg-surgent-text/10 hover:text-surgent-text transition-all"
							>
								{actionLabel}
							</button>
						)}
					</>
				) : null}
			</div>
			{isDir &&
				isExpanded &&
				sortedChildren.map((child) => (
					<TreeNodeRow
						key={child.path}
						node={child}
						depth={depth + 1}
						selected={selected}
						onSelect={onSelect}
						onAction={onAction}
						actionLabel={actionLabel}
						expandedDirs={expandedDirs}
						toggleDir={toggleDir}
					/>
				))}
		</>
	);
}

function FileGroup({
	title,
	files,
	color,
	selected,
	onSelect,
	actionLabel,
	onAction,
	onActionAll,
	isCollapsible = true,
	viewMode = "path",
}: {
	title: string;
	files: GitFileEntry[];
	color: string;
	selected: SelectedFile | null;
	onSelect: (f: GitFileEntry) => void;
	actionLabel?: string;
	onAction?: (path: string) => void;
	onActionAll?: () => void;
	isCollapsible?: boolean;
	viewMode?: "path" | "tree";
}) {
	const [isCollapsed, setIsCollapsed] = useState(false);
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
		// Start with all directories expanded
		const dirs = new Set<string>();
		for (const f of files) {
			const parts = f.path.split("/");
			let path = "";
			for (let i = 0; i < parts.length - 1; i++) {
				path = path ? `${path}/${parts[i]}` : parts[i]!;
				dirs.add(path);
			}
		}
		return dirs;
	});

	const toggleDir = useCallback((path: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	}, []);

	const tree = useMemo(() => buildFileTree(files), [files]);

	if (!files.length) return null;
	return (
		<div>
			<div className="sticky top-0 z-10 flex h-7 items-center justify-between border-b border-surgent-border/30 bg-surgent-bg px-2">
				<button
					type="button"
					onClick={() => isCollapsible && setIsCollapsed(!isCollapsed)}
					className={`flex items-center gap-1.5 ${isCollapsible ? "cursor-pointer" : "cursor-default"}`}
				>
					{isCollapsible && (
						<svg
							className={`w-2.5 h-2.5 text-surgent-text-3 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						>
							<polyline points="9 18 15 12 9 6" />
						</svg>
					)}
					<span
						className={`text-[9px] font-medium uppercase tracking-wide ${color}`}
					>
						{title}
					</span>
					<span className="text-[9px] text-surgent-text-3">
						({files.length})
					</span>
				</button>
				{onActionAll && !isCollapsed && (
					<button
						type="button"
						onClick={onActionAll}
						className="rounded px-1.5 py-0.5 text-[8px] text-surgent-accent hover:bg-surgent-accent/10 transition-colors"
					>
						{actionLabel} All
					</button>
				)}
			</div>
			{!isCollapsed &&
				viewMode === "path" &&
				files.map((f) => {
					const active =
						selected?.path === f.path && selected?.staged === f.staged;
					const name = f.path.split("/").pop() || f.path;
					const dir = f.path.includes("/")
						? f.path.slice(0, f.path.lastIndexOf("/"))
						: "";
					return (
						<div
							key={`${f.staged ? "s" : "u"}-${f.path}`}
							className={`group flex h-[28px] items-center gap-1.5 px-2 ${
								active ? "bg-surgent-accent/10" : "hover:bg-surgent-text/5"
							}`}
						>
							<FileStatusIcon status={f.status} />
							<button
								type="button"
								onClick={() => onSelect(f)}
								className="flex-1 min-w-0 h-full flex items-center gap-1 text-left"
								title={f.path}
							>
								<span
									className={`truncate text-[10px] font-mono transition-colors ${active ? "text-surgent-text" : "text-surgent-text-2 group-hover:text-surgent-text"}`}
								>
									{name}
								</span>
								{dir && (
									<span className="truncate text-[9px] text-surgent-text-3/60">
										{dir}
									</span>
								)}
							</button>
							{onAction && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onAction(f.path);
									}}
									className="shrink-0 opacity-0 group-hover:opacity-100 rounded px-1.5 py-0.5 text-[8px] text-surgent-text-3 hover:bg-surgent-text/10 hover:text-surgent-text transition-all"
									title={`${actionLabel} ${f.path}`}
								>
									{actionLabel}
								</button>
							)}
						</div>
					);
				})}
			{!isCollapsed && viewMode === "tree" && (
				<div>
					{[...tree.children.values()]
						.sort((a, b) => {
							const aIsDir = a.children.size > 0 && !a.file;
							const bIsDir = b.children.size > 0 && !b.file;
							if (aIsDir && !bIsDir) return -1;
							if (!aIsDir && bIsDir) return 1;
							return a.name.localeCompare(b.name);
						})
						.map((child) => (
							<TreeNodeRow
								key={child.path}
								node={child}
								depth={0}
								selected={selected}
								onSelect={onSelect}
								onAction={onAction}
								actionLabel={actionLabel}
								expandedDirs={expandedDirs}
								toggleDir={toggleDir}
							/>
						))}
				</div>
			)}
		</div>
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
			className={`flex h-full w-7 items-center justify-center transition-all ${
				active
					? "bg-surgent-text/10 text-surgent-text"
					: "text-surgent-text-3 hover:text-surgent-text-2"
			}`}
		>
			{icon}
		</button>
	);
}
