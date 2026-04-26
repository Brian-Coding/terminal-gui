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
} from "../../lib/terminal-utils.ts";
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
		return <IconTerminal size={size} className="text-inferay-soft-white" />;
	}
	const info = getStatusInfo(status);
	return (
		<StatusIcon
			iconType={info.iconType}
			size={size}
			className={`${info.iconColor} ${info.isActive ? "animate-pulse" : ""}`}
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
		<div className="w-48 flex-1 overflow-y-auto">
			<div className="px-2 py-2">
				<div className="electrobun-webkit-app-region-drag py-1">
					<button
						type="button"
						onClick={onCollapse}
						className="electrobun-webkit-app-region-no-drag flex items-center gap-1.5 px-1 text-inferay-muted-gray hover:text-inferay-soft-white transition-colors"
					>
						<IconPanelLeft size={12} className="rotate-180" />
						<span className="text-[9px] font-bold tracking-widest uppercase">
							Agents
						</span>
					</button>
				</div>
				{panes.map((pane) => {
					const isSelected = pane.id === selectedPaneId;
					const s = agentStatuses.get(pane.id) ?? "idle";
					return (
						<div
							key={pane.id}
							role="button"
							tabIndex={0}
							onClick={() => onSelectPane(pane.id)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") onSelectPane(pane.id);
							}}
							className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors mb-0.5 cursor-pointer ${
								isSelected ? "bg-inferay-gray" : "hover:bg-inferay-dark-gray"
							}`}
						>
							<div className="shrink-0">
								<PaneIcon pane={pane} status={s} size={13} />
							</div>
							<div className="min-w-0 flex-1">
								<p
									className={`truncate text-[11px] font-medium ${
										isSelected
											? "text-inferay-white"
											: "text-inferay-soft-white"
									}`}
									title={pane.cwd}
								>
									{getPaneTitle(pane)}
								</p>
							</div>
							<IconButton
								variant="danger"
								size="xs"
								onClick={(e) => {
									e.stopPropagation();
									onRemovePane(pane.id);
								}}
								className="shrink-0"
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
		<div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-inferay-gray-border bg-inferay-black">
			<button
				type="button"
				onClick={onExpand}
				className="flex items-center justify-center h-6 w-6 rounded-md hover:bg-inferay-dark-gray transition-colors"
				title="Expand Agents"
			>
				<IconPanelLeft size={10} className="text-inferay-muted-gray" />
			</button>
			<div className="h-3 w-px bg-inferay-gray-border mx-0.5" />
			<div className="flex items-center gap-0.5 overflow-x-auto">
				{panes.map((pane) => {
					const isSelected = pane.id === selectedPaneId;
					const s = agentStatuses.get(pane.id) ?? "idle";
					const name = getPaneTitle(pane);
					return (
						<button
							type="button"
							key={pane.id}
							onClick={() => onSelectPane(pane.id)}
							className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
								isSelected
									? "bg-inferay-gray text-inferay-white"
									: "text-inferay-muted-gray hover:bg-inferay-dark-gray hover:text-inferay-soft-white"
							}`}
							title={`${name}${pane.agentKind !== "terminal" ? ` - ${getStatusInfo(s).label}` : ""}`}
						>
							<PaneIcon pane={pane} status={s} size={12} />
							<span className="text-[10px] font-medium truncate max-w-[80px]">
								{name}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
});
