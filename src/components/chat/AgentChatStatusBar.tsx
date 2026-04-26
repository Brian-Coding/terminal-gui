import React, { useEffect, useMemo, useState } from "react";
import {
	IconEye,
	IconFilePlus,
	IconGlobe,
	IconPencil,
	IconSearch,
	IconStop,
	IconTerminal,
	IconWrench,
} from "../ui/Icons.tsx";
import type { ChatMessage } from "./agent-chat-shared.ts";
import {
	extractToolActivities,
	getStatusToolName,
	normalizeToolName,
	type ToolActivity,
} from "./chat-agent-utils.ts";

interface AgentChatStatusBarProps {
	messages: ChatMessage[];
	liveActivities?: ToolActivity[];
	isLoading: boolean;
	status: string;
	onStop: () => void;
}

function ToolStatusIcon({ toolName }: { toolName: string }) {
	const baseClass = "w-3 h-3 shrink-0";
	switch (normalizeToolName(toolName)) {
		case "read":
			return <IconEye className={baseClass} />;
		case "edit":
		case "patch":
			return <IconPencil className={baseClass} />;
		case "write":
			return <IconFilePlus className={baseClass} />;
		case "bash":
		case "exec":
			return <IconTerminal className={baseClass} />;
		case "grep":
		case "glob":
			return <IconSearch className={baseClass} />;
		case "web_search":
		case "websearch":
		case "webfetch":
			return <IconGlobe className={baseClass} />;
		default:
			return <IconWrench className={baseClass} />;
	}
}

export const AgentChatStatusBar = React.memo(function AgentChatStatusBar({
	messages,
	liveActivities = [],
	isLoading,
	status,
	onStop,
}: AgentChatStatusBarProps) {
	const [isHovered, setIsHovered] = useState(false);
	const [statusActivities, setStatusActivities] = useState<
		Array<{
			id: string;
			toolName: string;
			isStreaming: boolean;
			summary: string;
		}>
	>([]);
	const toolActivities = useMemo(
		() => extractToolActivities(messages),
		[messages]
	);
	const statusToolName = getStatusToolName(status);

	useEffect(() => {
		if (!isLoading) {
			setStatusActivities([]);
			return;
		}
		if (!statusToolName) return;
		setStatusActivities((prev) => {
			if (prev[prev.length - 1]?.toolName === statusToolName) return prev;
			return [
				...prev,
				{
					id: `status-${statusToolName}-${prev.length}`,
					toolName: statusToolName,
					isStreaming: true,
					summary: statusToolName,
				},
			].slice(-12);
		});
	}, [isLoading, statusToolName]);

	if (!isLoading) return null;
	const activityItems =
		liveActivities.length > 0
			? liveActivities
			: toolActivities.length > 0
				? toolActivities
				: statusActivities;
	const latestActivity = activityItems[activityItems.length - 1];
	const hasActivity = activityItems.length > 0 || statusToolName || isLoading;
	const displayToolName = latestActivity?.toolName ?? statusToolName;
	const displaySummary =
		latestActivity?.summary ??
		statusToolName ??
		(status === "responding" ? "Responding" : "Working...");
	const activityCount = activityItems.length;

	return (
		<div className="shrink-0 flex items-center justify-between gap-2 px-3 py-1">
			{hasActivity ? (
				<div
					className="relative"
					onMouseEnter={() => setIsHovered(true)}
					onMouseLeave={() => setIsHovered(false)}
				>
					<div className="flex items-center gap-1.5 h-6 px-2.5 rounded-md text-xs font-medium cursor-default bg-inferay-dark-gray text-inferay-soft-white hover:bg-inferay-gray transition-all border border-inferay-gray-border">
						{displayToolName && (
							<span className="text-inferay-muted-gray">
								<ToolStatusIcon toolName={displayToolName} />
							</span>
						)}
						<span className="max-w-[150px] truncate">
							{displaySummary || "Working..."}
						</span>
						{activityCount > 1 && (
							<span className="text-[9px] tabular-nums text-inferay-muted-gray">
								+{activityCount - 1}
							</span>
						)}
					</div>

					{isHovered && activityCount > 0 && (
						<div className="absolute bottom-full left-0 mb-1 min-w-[240px] max-w-[320px] rounded-lg overflow-hidden bg-inferay-dark-gray shadow-lg border border-inferay-gray-border">
							<div className="flex items-center justify-between px-2.5 py-1.5 text-[9px] font-medium uppercase tracking-wider border-b border-inferay-gray-border text-inferay-muted-gray">
								<span>Activity</span>
								<span className="tabular-nums">{activityCount}</span>
							</div>
							<div className="overflow-y-auto" style={{ maxHeight: "200px" }}>
								{activityItems.map((activity, idx) => (
									<div
										key={activity.id}
										className={`flex items-center gap-2 px-2.5 py-1.5 text-[10px] ${
											idx < activityItems.length - 1
												? "border-b border-inferay-gray-border/50"
												: ""
										}`}
									>
										<span className="shrink-0 text-inferay-muted-gray">
											<ToolStatusIcon toolName={activity.toolName} />
										</span>
										<span className="flex-1 truncate text-inferay-soft-white">
											{activity.summary}
										</span>
										{activity.isStreaming && (
											<span className="h-1.5 w-1.5 rounded-full shrink-0 bg-inferay-muted-gray" />
										)}
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="flex items-center gap-2">
					<span className="h-1.5 w-1.5 rounded-full animate-pulse bg-inferay-muted-gray" />
					<span className="text-[10px] text-inferay-muted-gray">
						Working...
					</span>
				</div>
			)}

			<button
				type="button"
				onClick={onStop}
				className="shrink-0 flex items-center gap-1.5 h-6 px-2 rounded-md text-[10px] font-medium transition-all bg-inferay-dark-gray text-inferay-soft-white hover:bg-inferay-gray border border-inferay-gray-border"
			>
				<IconStop className="w-3 h-3" />
				Stop
			</button>
		</div>
	);
});
