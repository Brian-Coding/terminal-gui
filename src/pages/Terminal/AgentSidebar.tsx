import * as stylex from "@stylexjs/stylex";
import { memo } from "react";
import { IconButton } from "../../components/ui/IconButton.tsx";
import {
	IconPanelLeft,
	IconTerminal,
	IconX,
} from "../../components/ui/Icons.tsx";
import {
	getPaneTitle,
	getStatusInfo,
	type TerminalPaneModel,
} from "../../features/terminal/terminal-utils.ts";
import {
	APP_REGION_DRAG_CLASS,
	APP_REGION_NO_DRAG_CLASS,
} from "../../lib/app-theme.ts";
import { stopPropagationAndCall } from "../../lib/react-events.ts";
import {
	color,
	controlSize,
	font,
	motion,
	radius,
} from "../../tokens.stylex.ts";
import { StatusIcon } from "./StatusIcon.tsx";

function PaneIcon({
	pane,
	status,
	size,
}: {
	pane: TerminalPaneModel;
	status: string;
	size: number;
}) {
	if (pane.agentKind === "terminal") {
		return (
			<IconTerminal
				size={size}
				className={stylex.props(styles.terminalIcon).className}
			/>
		);
	}
	const info = getStatusInfo(status);
	return (
		<StatusIcon
			iconType={info.iconType}
			size={size}
			tone={info.tone}
			active={info.isActive}
		/>
	);
}

export const AgentSidebar = memo(function AgentSidebar({
	panes,
	selectedPaneId,
	agentStatuses,
	onSelectPane,
	onRemovePane,
	onCollapse,
}: {
	panes: TerminalPaneModel[];
	selectedPaneId: string | null;
	agentStatuses: Map<string, string>;
	onSelectPane: (id: string) => void;
	onRemovePane: (id: string) => void;
	onCollapse: () => void;
}) {
	return (
		<div {...stylex.props(styles.sidebar)}>
			<div {...stylex.props(styles.sidebarInner)}>
				<div
					{...stylex.props(styles.dragStrip)}
					className={`${APP_REGION_DRAG_CLASS} ${stylex.props(styles.dragStrip).className ?? ""}`}
				>
					<button
						type="button"
						onClick={onCollapse}
						{...stylex.props(styles.collapseButton)}
						className={`${APP_REGION_NO_DRAG_CLASS} ${stylex.props(styles.collapseButton).className ?? ""}`}
					>
						<IconPanelLeft
							size={12}
							className={stylex.props(styles.rotateHalfTurn).className}
						/>
						<span {...stylex.props(styles.sectionLabel)}>Agents</span>
					</button>
				</div>
				{panes.map((pane) => {
					const isSelected = pane.id === selectedPaneId;
					const s = agentStatuses.get(pane.id) ?? "idle";
					return (
						<div key={pane.id} {...stylex.props(styles.paneRowShell)}>
							<button
								type="button"
								onClick={onSelectPane.bind(null, pane.id)}
								{...stylex.props(
									styles.paneRow,
									isSelected ? styles.paneRowSelected : styles.paneRowIdle
								)}
							>
								<div {...stylex.props(styles.noShrink)}>
									<PaneIcon pane={pane} status={s} size={13} />
								</div>
								<div {...stylex.props(styles.paneTextWrap)}>
									<p
										{...stylex.props(
											styles.paneTitle,
											isSelected ? styles.paneTitleSelected : null
										)}
										title={pane.cwd}
									>
										{getPaneTitle(pane)}
									</p>
								</div>
							</button>
							<IconButton
								variant="danger"
								size="xs"
								onClick={stopPropagationAndCall.bind(
									null,
									onRemovePane.bind(null, pane.id)
								)}
								className={stylex.props(styles.noShrink).className}
							>
								<IconX size={10} />
							</IconButton>
						</div>
					);
				})}
			</div>
		</div>
	);
});

export const CollapsedAgentBar = memo(function CollapsedAgentBar({
	panes,
	selectedPaneId,
	agentStatuses,
	onSelectPane,
	onExpand,
}: {
	panes: TerminalPaneModel[];
	selectedPaneId: string | null;
	agentStatuses: Map<string, string>;
	onSelectPane: (id: string) => void;
	onExpand: () => void;
}) {
	return (
		<div {...stylex.props(styles.collapsedBar)}>
			<button
				type="button"
				onClick={onExpand}
				{...stylex.props(styles.expandButton)}
				title="Expand Agents"
			>
				<IconPanelLeft
					size={10}
					className={stylex.props(styles.mutedIcon).className}
				/>
			</button>
			<div {...stylex.props(styles.collapsedDivider)} />
			<div {...stylex.props(styles.collapsedList)}>
				{panes.map((pane) => {
					const isSelected = pane.id === selectedPaneId;
					const s = agentStatuses.get(pane.id) ?? "idle";
					const name = getPaneTitle(pane);
					return (
						<button
							type="button"
							key={pane.id}
							onClick={onSelectPane.bind(null, pane.id)}
							{...stylex.props(
								styles.collapsedPane,
								isSelected
									? styles.collapsedPaneSelected
									: styles.collapsedPaneIdle
							)}
							title={`${name}${pane.agentKind !== "terminal" ? ` - ${getStatusInfo(s).label}` : ""}`}
						>
							<PaneIcon pane={pane} status={s} size={12} />
							<span {...stylex.props(styles.collapsedTitle)}>{name}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
});

const styles = stylex.create({
	sidebar: {
		flex: 1,
		overflowY: "auto",
		width: 192,
	},
	sidebarInner: {
		padding: controlSize._2,
	},
	dragStrip: {
		paddingBlock: controlSize._1,
	},
	collapseButton: {
		alignItems: "center",
		color: {
			default: color.textMuted,
			":hover": color.textSoft,
		},
		display: "flex",
		gap: controlSize._1_5,
		paddingInline: controlSize._1,
		transitionDuration: motion.durationBase,
		transitionProperty: "color",
		transitionTimingFunction: motion.ease,
	},
	rotateHalfTurn: {
		transform: "rotate(180deg)",
	},
	terminalIcon: {
		color: color.textSoft,
		flexShrink: 0,
	},
	mutedIcon: {
		color: color.textMuted,
	},
	noShrink: {
		flexShrink: 0,
	},
	sectionLabel: {
		fontSize: font.size_1,
		fontWeight: font.weight_6,
		letterSpacing: 0,
		textTransform: "uppercase",
	},
	paneRowShell: {
		alignItems: "center",
		display: "flex",
		gap: controlSize._1,
		marginBottom: controlSize._0_5,
	},
	paneRow: {
		alignItems: "center",
		borderWidth: 0,
		borderRadius: radius.md,
		color: "inherit",
		cursor: "pointer",
		display: "flex",
		font: "inherit",
		gap: controlSize._2,
		paddingBlock: controlSize._1_5,
		paddingInline: controlSize._2,
		textAlign: "left",
		transitionDuration: motion.durationBase,
		transitionProperty: "background-color, color",
		transitionTimingFunction: motion.ease,
		width: "100%",
	},
	paneRowIdle: {
		backgroundColor: {
			default: "transparent",
			":hover": color.backgroundRaised,
		},
	},
	paneRowSelected: {
		backgroundColor: color.controlActive,
	},
	paneTextWrap: {
		flex: 1,
		minWidth: 0,
	},
	paneTitle: {
		color: color.textSoft,
		fontSize: font.size_4,
		fontWeight: font.weight_5,
		margin: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	paneTitleSelected: {
		color: color.textMain,
	},
	collapsedBar: {
		alignItems: "center",
		backgroundColor: color.background,
		borderBottomColor: color.border,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		flexShrink: 0,
		gap: controlSize._1,
		paddingBlock: controlSize._1,
		paddingInline: controlSize._2,
	},
	expandButton: {
		alignItems: "center",
		borderRadius: radius.md,
		display: "flex",
		height: controlSize._6,
		justifyContent: "center",
		transitionDuration: motion.durationBase,
		transitionProperty: "background-color",
		transitionTimingFunction: motion.ease,
		width: controlSize._6,
		":hover": {
			backgroundColor: color.backgroundRaised,
		},
	},
	collapsedDivider: {
		backgroundColor: color.border,
		height: controlSize._3,
		marginInline: controlSize._0_5,
		width: 1,
	},
	collapsedList: {
		alignItems: "center",
		display: "flex",
		gap: controlSize._0_5,
		overflowX: "auto",
	},
	collapsedPane: {
		alignItems: "center",
		borderRadius: radius.md,
		display: "flex",
		gap: controlSize._1_5,
		paddingBlock: controlSize._1,
		paddingInline: controlSize._2,
		transitionDuration: motion.durationBase,
		transitionProperty: "background-color, color",
		transitionTimingFunction: motion.ease,
	},
	collapsedPaneIdle: {
		color: {
			default: color.textMuted,
			":hover": color.textSoft,
		},
		backgroundColor: {
			default: "transparent",
			":hover": color.backgroundRaised,
		},
	},
	collapsedPaneSelected: {
		backgroundColor: color.controlActive,
		color: color.textMain,
	},
	collapsedTitle: {
		fontSize: font.size_2,
		fontWeight: font.weight_5,
		maxWidth: 80,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
});
