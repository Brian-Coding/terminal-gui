import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button.tsx";
import { DropdownButton } from "../../components/ui/DropdownButton.tsx";
import { IconMessageCircle, IconPlus } from "../../components/ui/Icons.tsx";
import { getAgentIcon } from "../../features/agents/agent-ui.tsx";
import {
	appendPaneToGroup,
	dispatchTerminalShellChange,
	loadCanonicalTerminalState,
	mutateCanonicalTerminalState,
	type TerminalGroupModel,
	type TerminalPaneModel,
} from "../../features/terminal/terminal-utils.ts";
import { fetchJsonOr } from "../../lib/fetch-json.ts";
import { basename, formatRelativeTime, trimText } from "../../lib/format.ts";
import { listenWindowEvent } from "../../lib/react-events.ts";
import { writeStoredValue } from "../../lib/stored-json.ts";
import { color, font, radius } from "../../tokens.stylex.ts";

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
	const [workspaces, setWorkspaces] = useState<TerminalGroupModel[]>([]);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const [next, terminalState] = await Promise.all([
				loadSessions(),
				loadCanonicalTerminalState(),
			]);
			setSessions(next);
			setWorkspaces(terminalState?.groups ?? []);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const id = window.setInterval(() => void refresh(), 2000);
		const cleanupShell = listenWindowEvent("terminal-shell-change", () => {
			void refresh();
		});
		const refreshOnFocus = () => void refresh();
		window.addEventListener("focus", refreshOnFocus);
		return () => {
			window.clearInterval(id);
			cleanupShell();
			window.removeEventListener("focus", refreshOnFocus);
		};
	}, [refresh]);

	const groupedSessions = useMemo(() => {
		const active = sessions.filter((session) => session.inCurrentWorkspace);
		const archived = sessions.filter((session) => !session.inCurrentWorkspace);
		return { active, archived };
	}, [sessions]);

	const restoreSession = useCallback(
		async (session: LocalSessionInfo, targetGroupId?: string) => {
			await mutateCanonicalTerminalState(
				(state) => {
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
					const selectedGroupId =
						targetGroupId ?? state.selectedGroupId ?? state.groups[0]?.id;
					if (!selectedGroupId) return null;
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
			dispatchTerminalShellChange({
				source: "view",
				reason: "restore-session",
			});
			window.location.hash = "#/terminal";
		},
		[]
	);

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
				</div>
				<SessionGroup
					title="In Workspace"
					sessions={groupedSessions.active}
					workspaces={workspaces}
					onOpen={restoreSession}
				/>
				<SessionGroup
					title="Archived"
					sessions={groupedSessions.archived}
					workspaces={workspaces}
					onOpen={restoreSession}
				/>
				{!loading && sessions.length === 0 ? (
					<div {...stylex.props(styles.empty)}>
						<IconMessageCircle size={18} />
						<span>No saved sessions</span>
					</div>
				) : null}
			</section>
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
	workspaces: TerminalGroupModel[];
	onOpen: (session: LocalSessionInfo, targetGroupId?: string) => void;
}) {
	if (sessions.length === 0) return null;
	return (
		<div {...stylex.props(styles.group)}>
			<div {...stylex.props(styles.groupTitle)}>{title}</div>
			{sessions.map((session) => (
				<div key={session.paneId} {...stylex.props(styles.sessionRow)}>
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
					<SessionAction
						session={session}
						workspaces={workspaces}
						onOpen={onOpen}
					/>
				</div>
			))}
		</div>
	);
}

function SessionAction({
	session,
	workspaces,
	onOpen,
}: {
	session: LocalSessionInfo;
	workspaces: TerminalGroupModel[];
	onOpen: (session: LocalSessionInfo, targetGroupId?: string) => void;
}) {
	if (session.inCurrentWorkspace) {
		return (
			<div {...stylex.props(styles.actionWrap)}>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={() => onOpen(session)}
				>
					<IconPlus size={12} />
					<span>Open in Grid</span>
				</Button>
			</div>
		);
	}
	const options = workspaces.map((workspace) => ({
		id: workspace.id,
		label: workspace.name,
		detail: `${workspace.panes.length} panes`,
	}));
	return (
		<div {...stylex.props(styles.actionWrap)}>
			<DropdownButton
				value={null}
				options={options}
				onChange={(groupId) => onOpen(session, groupId)}
				placeholder="Add to Grid"
				icon={<IconPlus size={12} />}
				minWidth={180}
				menuPlacement="auto"
			/>
		</div>
	);
}

const styles = stylex.create({
	root: {
		display: "block",
		height: "100%",
		backgroundColor: color.background,
		color: color.textMain,
	},
	listPane: {
		minWidth: 0,
		overflow: "auto",
		height: "100%",
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
		alignItems: "center",
		gap: 10,
		padding: "10px 12px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "transparent",
		borderRadius: radius.sm,
		backgroundColor: "transparent",
		color: color.textMain,
		textAlign: "left",
		":hover": { backgroundColor: color.surfaceControlHover },
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
	actionWrap: {
		display: "flex",
		flexShrink: 0,
		width: 180,
		justifyContent: "flex-end",
	},
	dot: {
		width: 3,
		height: 3,
		borderRadius: 99,
		backgroundColor: color.textMuted,
		flexShrink: 0,
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
});
