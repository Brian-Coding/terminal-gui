import React, { useMemo, useState } from "react";
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
} from "./chat-agent-utils.ts";

interface AgentChatStatusBarProps {
	messages: ChatMessage[];
	isLoading: boolean;
	status: string;
	onStop: () => void;
}

function ToolStatusIcon({ toolName }: { toolName: string }) {
	const baseClass = "w-3 h-3 shrink-0";
	switch (toolName.toLowerCase()) {
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
	isLoading,
	status,
	onStop,
}: AgentChatStatusBarProps) {
	const [isHovered, setIsHovered] = useState(false);
	const toolActivities = useMemo(
		() => extractToolActivities(messages),
		[messages]
	);

	if (!isLoading) return null;
	const latestActivity = toolActivities[toolActivities.length - 1];
	const statusToolName = getStatusToolName(status);
	const hasActivity = toolActivities.length > 0 || statusToolName;
	const displayToolName = latestActivity?.toolName ?? statusToolName;
	const displaySummary = latestActivity?.summary ?? statusToolName;
	const activityCount = toolActivities.length;

	return (
		<div className="shrink-0 flex items-center justify-between gap-2 px-3 py-1">
			{hasActivity ? (
				<div
					className="relative"
					onMouseEnter={() => setIsHovered(true)}
					onMouseLeave={() => setIsHovered(false)}
				>
					<div className="flex items-center gap-1.5 h-6 px-2.5 rounded-md text-xs font-medium cursor-default bg-inferay-surface-2 text-inferay-text-2 hover:bg-inferay-surface-3 transition-all border border-inferay-border">
						{displayToolName && (
							<span className="text-inferay-text-3">
								<ToolStatusIcon toolName={displayToolName} />
							</span>
						)}
						<span className="max-w-[150px] truncate">
							{displaySummary || "Working..."}
						</span>
						{activityCount > 1 && (
							<span className="text-[9px] tabular-nums text-inferay-text-3">
								+{activityCount - 1}
							</span>
						)}
					</div>

					{isHovered && activityCount > 0 && (
						<div className="absolute bottom-full left-0 mb-1 min-w-[240px] max-w-[320px] rounded-lg overflow-hidden bg-inferay-surface shadow-lg border border-inferay-border">
							<div className="flex items-center justify-between px-2.5 py-1.5 text-[9px] font-medium uppercase tracking-wider border-b border-inferay-border text-inferay-text-3">
								<span>Activity</span>
								<span className="tabular-nums">{activityCount}</span>
							</div>
							<div className="overflow-y-auto" style={{ maxHeight: "200px" }}>
								{toolActivities.map((activity, idx) => (
									<div
										key={activity.id}
										className={`flex items-center gap-2 px-2.5 py-1.5 text-[10px] ${
											idx < toolActivities.length - 1
												? "border-b border-inferay-border/50"
												: ""
										}`}
									>
										<span className="shrink-0 text-inferay-text-3">
											<ToolStatusIcon toolName={activity.toolName} />
										</span>
										<span className="flex-1 truncate text-inferay-text-2">
											{activity.summary}
										</span>
										{activity.isStreaming && (
											<span className="h-1.5 w-1.5 rounded-full shrink-0 bg-inferay-text-3" />
										)}
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="flex items-center gap-2">
					<span className="h-1.5 w-1.5 rounded-full animate-pulse bg-inferay-text-3" />
					<span className="text-[10px] text-inferay-text-3">Working...</span>
				</div>
			)}

			<button
				type="button"
				onClick={onStop}
				className="shrink-0 flex items-center gap-1.5 h-6 px-2 rounded-md text-[10px] font-medium transition-all bg-inferay-surface-2 text-inferay-text-2 hover:bg-inferay-surface-3 border border-inferay-border"
			>
				<IconStop className="w-3 h-3" />
				Stop
			</button>
		</div>
	);
});
