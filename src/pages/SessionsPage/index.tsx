import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button.tsx";
import {
	IconMessageCircle,
	IconPlus,
	IconRefreshCw,
} from "../../components/ui/Icons.tsx";
import { getAgentIcon } from "../../features/agents/agent-ui.tsx";
import {
	appendPaneToGroup,
	dispatchTerminalShellChange,
	mutateCanonicalTerminalState,
	type TerminalPaneModel,
} from "../../features/terminal/terminal-utils.ts";
import { fetchJsonOr } from "../../lib/fetch-json.ts";
import { basename, formatRelativeTime, trimText } from "../../lib/format.ts";
import { writeStoredValue } from "../../lib/stored-json.ts";
import { color, font, radius, shadow } from "../../tokens.stylex.ts";

interface LocalSessionInfo {
	paneId: string;
	title: string;
	agentKind: "claude" | "codex";
	cwd: string | null;
	messageCount: number;
	lastMessage: string | null;
	lastRole: string | null;
	updatedAt: number;
	inCurrentWorkspace: boolean;
}

async function loadSessions(): Promise<LocalSessionInfo[]> {
	const payload = await fetchJsonOr<{ sessions?: LocalSessionInfo[] }>(
		"/api/sessions",
		{ sessions: [] }
	);
	return Array.isArray(payload.sessions) ? payload.sessions : [];
}

export function SessionsPage() {
	const [sessions, setSessions] = useState<LocalSessionInfo[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const next = await loadSessions();
			setSessions(next);
			setSelectedId((current) =>
				current && next.some((session) => session.paneId === current)
					? current
					: (next[0]?.paneId ?? null)
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selected =
		sessions.find((session) => session.paneId === selectedId) ??
		sessions[0] ??
		null;

	const groupedSessions = useMemo(() => {
		const active = sessions.filter((session) => session.inCurrentWorkspace);
		const archived = sessions.filter((session) => !session.inCurrentWorkspace);
		return { active, archived };
	}, [sessions]);

	const restoreSession = useCallback(async (session: LocalSessionInfo) => {
		await mutateCanonicalTerminalState(
			(state) => {
				const selectedGroupId = state.selectedGroupId ?? state.groups[0]?.id;
				if (!selectedGroupId) return null;
				const existingGroup = state.groups.find((group) =>
					group.panes.some((pane) => pane.id === session.paneId)
				);
				if (existingGroup) {
					return {
						...state,
						selectedGroupId: existingGroup.id,
						groups: state.groups.map((group) =>
							group.id === existingGroup.id
								? { ...group, selectedPaneId: session.paneId as never }
								: group
						),
					};
				}
				const pane: TerminalPaneModel = {
					id: session.paneId as never,
					title:
						session.title ||
						(session.cwd ? basename(session.cwd) : "Archived session"),
					agentKind: session.agentKind,
					isClaude: session.agentKind === "claude",
					paneType: session.agentKind,
					cwd: session.cwd ?? undefined,
					pendingCwd: !session.cwd,
				};
				return {
					...state,
					groups: state.groups.map(
						appendPaneToGroup.bind(null, selectedGroupId, pane)
					),
					selectedGroupId,
				};
			},
			"restore-session",
			{ createIfMissing: true }
		);
		writeStoredValue("terminal-main-view", "chat");
		dispatchTerminalShellChange({ source: "view", reason: "restore-session" });
		window.location.hash = "#/terminal";
	}, []);

	return (
		<div {...stylex.props(styles.root)}>
			<section {...stylex.props(styles.listPane)}>
				<div {...stylex.props(styles.toolbar)}>
					<div>
						<h1 {...stylex.props(styles.title)}>Sessions</h1>
						<p {...stylex.props(styles.subtitle)}>
							{sessions.length} local chat archives
						</p>
					</div>
					<Button type="button" variant="secondary" size="sm" onClick={refresh}>
						<IconRefreshCw size={12} />
						<span>Refresh</span>
					</Button>
				</div>
				<SessionGroup
					title="In Workspace"
					sessions={groupedSessions.active}
					selectedId={selected?.paneId ?? null}
					onSelect={setSelectedId}
				/>
				<SessionGroup
					title="Archived"
					sessions={groupedSessions.archived}
					selectedId={selected?.paneId ?? null}
					onSelect={setSelectedId}
				/>
				{!loading && sessions.length === 0 ? (
					<div {...stylex.props(styles.empty)}>
						<IconMessageCircle size={18} />
						<span>No saved sessions</span>
					</div>
				) : null}
			</section>
			<aside {...stylex.props(styles.detailPane)}>
				{selected ? (
					<>
						<div {...stylex.props(styles.detailHeader)}>
							<span {...stylex.props(styles.detailIcon)}>
								{getAgentIcon(selected.agentKind, 14)}
							</span>
							<div {...stylex.props(styles.detailTitleGroup)}>
								<span {...stylex.props(styles.detailKicker)}>
									{selected.cwd ? basename(selected.cwd) : "No folder"}
								</span>
								<h2 {...stylex.props(styles.detailTitle)}>{selected.title}</h2>
							</div>
						</div>
						<div {...stylex.props(styles.metaGrid)}>
							<Meta label="Messages" value={String(selected.messageCount)} />
							<Meta
								label="Updated"
								value={
									selected.updatedAt
										? formatRelativeTime(selected.updatedAt)
										: "Unknown"
								}
							/>
							<Meta
								label="Status"
								value={
									selected.inCurrentWorkspace ? "In workspace" : "Archived"
								}
							/>
						</div>
						<div {...stylex.props(styles.pathBlock)}>
							<span {...stylex.props(styles.pathLabel)}>Directory</span>
							<span {...stylex.props(styles.pathValue)}>
								{selected.cwd ?? "No folder saved"}
							</span>
						</div>
						<div {...stylex.props(styles.preview)}>
							<span {...stylex.props(styles.pathLabel)}>Last message</span>
							<p {...stylex.props(styles.previewText)}>
								{selected.lastMessage ?? "No message preview"}
							</p>
						</div>
						<Button
							type="button"
							variant="primary"
							size="md"
							onClick={() => restoreSession(selected)}
						>
							<IconPlus size={13} />
							<span>
								{selected.inCurrentWorkspace
									? "Open in Grid"
									: "Add to Current Grid"}
							</span>
						</Button>
					</>
				) : (
					<div {...stylex.props(styles.emptyDetail)}>
						<IconMessageCircle size={20} />
						<span>Select a session</span>
					</div>
				)}
			</aside>
		</div>
	);
}

function SessionGroup({
	title,
	sessions,
	selectedId,
	onSelect,
}: {
	title: string;
	sessions: LocalSessionInfo[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	if (sessions.length === 0) return null;
	return (
		<div {...stylex.props(styles.group)}>
			<div {...stylex.props(styles.groupTitle)}>{title}</div>
			{sessions.map((session) => (
				<button
					key={session.paneId}
					type="button"
					onClick={() => onSelect(session.paneId)}
					{...stylex.props(
						styles.sessionRow,
						session.paneId === selectedId && styles.sessionRowSelected
					)}
				>
					<span {...stylex.props(styles.sessionIcon)}>
						{getAgentIcon(session.agentKind, 13)}
					</span>
					<span {...stylex.props(styles.sessionMain)}>
						<span {...stylex.props(styles.sessionTitle)}>{session.title}</span>
						<span {...stylex.props(styles.sessionMeta)}>
							{session.cwd ? basename(session.cwd) : "No folder"}
							<span {...stylex.props(styles.dot)} />
							{session.messageCount} messages
							<span {...stylex.props(styles.dot)} />
							{session.updatedAt
								? formatRelativeTime(session.updatedAt)
								: "Unknown"}
						</span>
						<span {...stylex.props(styles.sessionPreview)}>
							{trimText(session.lastMessage ?? "No message preview", 110)}
						</span>
					</span>
				</button>
			))}
		</div>
	);
}

function Meta({ label, value }: { label: string; value: string }) {
	return (
		<div {...stylex.props(styles.metaItem)}>
			<span {...stylex.props(styles.metaLabel)}>{label}</span>
			<span {...stylex.props(styles.metaValue)}>{value}</span>
		</div>
	);
}

const styles = stylex.create({
	root: {
		display: "grid",
		gridTemplateColumns: "minmax(360px, 1fr) minmax(320px, 420px)",
		height: "100%",
		backgroundColor: color.background,
		color: color.textMain,
	},
	listPane: {
		minWidth: 0,
		overflow: "auto",
		borderRightWidth: 1,
		borderRightStyle: "solid",
		borderRightColor: color.border,
	},
	toolbar: {
		position: "sticky",
		top: 0,
		zIndex: 1,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		padding: "18px 20px 14px",
		backgroundColor: color.background,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: color.border,
	},
	title: {
		margin: 0,
		fontSize: 18,
		fontWeight: font.weight_6,
		letterSpacing: 0,
	},
	subtitle: {
		margin: "4px 0 0",
		fontSize: 12,
		color: color.textMuted,
	},
	group: { padding: "14px 12px 4px" },
	groupTitle: {
		padding: "0 8px 8px",
		fontSize: 11,
		fontWeight: font.weight_6,
		textTransform: "uppercase",
		color: color.textMuted,
		letterSpacing: 0,
	},
	sessionRow: {
		display: "flex",
		width: "100%",
		gap: 10,
		padding: 10,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "transparent",
		borderRadius: radius.sm,
		backgroundColor: "transparent",
		color: color.textMain,
		textAlign: "left",
		cursor: "pointer",
		":hover": { backgroundColor: color.surfaceControlHover },
	},
	sessionRowSelected: {
		backgroundColor: color.surfaceControl,
		borderColor: color.borderStrong,
		boxShadow: shadow.selectedRing,
	},
	sessionIcon: {
		display: "flex",
		width: 22,
		height: 22,
		alignItems: "center",
		justifyContent: "center",
		flexShrink: 0,
		color: color.textMuted,
	},
	sessionMain: {
		display: "flex",
		minWidth: 0,
		flex: 1,
		flexDirection: "column",
		gap: 4,
	},
	sessionTitle: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontSize: 13,
		fontWeight: font.weight_6,
	},
	sessionMeta: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minWidth: 0,
		fontSize: 11,
		color: color.textMuted,
	},
	sessionPreview: {
		fontSize: 12,
		lineHeight: "17px",
		color: color.textSoft,
	},
	dot: {
		width: 3,
		height: 3,
		borderRadius: 99,
		backgroundColor: color.textMuted,
		flexShrink: 0,
	},
	detailPane: {
		display: "flex",
		minWidth: 0,
		flexDirection: "column",
		gap: 16,
		padding: 20,
		backgroundColor: color.backgroundRaised,
	},
	detailHeader: { display: "flex", gap: 12, alignItems: "flex-start" },
	detailIcon: {
		display: "flex",
		width: 30,
		height: 30,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: radius.sm,
		backgroundColor: color.surfaceControlHover,
		color: color.textMuted,
	},
	detailTitleGroup: {
		display: "flex",
		minWidth: 0,
		flexDirection: "column",
		gap: 4,
	},
	detailKicker: { fontSize: 11, color: color.textMuted },
	detailTitle: {
		margin: 0,
		fontSize: 18,
		fontWeight: font.weight_6,
		letterSpacing: 0,
	},
	metaGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: 8,
	},
	metaItem: {
		padding: 10,
		borderRadius: radius.sm,
		backgroundColor: color.background,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.border,
	},
	metaLabel: { display: "block", fontSize: 10, color: color.textMuted },
	metaValue: {
		display: "block",
		marginTop: 4,
		fontSize: 12,
		fontWeight: font.weight_6,
	},
	pathBlock: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
	},
	pathLabel: {
		fontSize: 11,
		fontWeight: font.weight_6,
		color: color.textMuted,
		textTransform: "uppercase",
		letterSpacing: 0,
	},
	pathValue: {
		fontSize: 12,
		lineHeight: "18px",
		color: color.textMain,
		wordBreak: "break-word",
	},
	preview: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		minHeight: 120,
		padding: 12,
		borderRadius: radius.sm,
		backgroundColor: color.background,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.border,
	},
	previewText: {
		margin: 0,
		fontSize: 13,
		lineHeight: "20px",
		color: color.textSoft,
		whiteSpace: "pre-wrap",
	},
	empty: {
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		padding: 32,
		color: color.textMuted,
		fontSize: 13,
	},
	emptyDetail: {
		display: "flex",
		height: "100%",
		alignItems: "center",
		justifyContent: "center",
		flexDirection: "column",
		gap: 10,
		color: color.textMuted,
	},
});
