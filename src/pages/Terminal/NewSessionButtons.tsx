import { memo } from "react";
import { getAgentIcon } from "../../lib/agent-ui.tsx";
import { getAgentDefinition } from "../../lib/agents.ts";
import type { AgentKind } from "../../lib/terminal-utils.ts";

interface NewSessionButtonsProps {
	labelPrefix?: string;
	selectedKind?: AgentKind;
	onAddPane: (kind: AgentKind) => void;
}

export const NewSessionButtons = memo(function NewSessionButtons({
	labelPrefix,
	selectedKind,
	onAddPane,
}: NewSessionButtonsProps) {
	const agentKinds = ["claude", "codex"] as const;
	return (
		<div className="flex flex-wrap items-center justify-center gap-1.5">
			{agentKinds.map((kind) => {
				const label = getAgentDefinition(kind).label;
				const isSelected = kind === selectedKind;
				return (
					<button
						key={kind}
						type="button"
						onClick={() => onAddPane(kind)}
						className={`flex h-6 items-center gap-1.5 rounded-md border border-transparent px-2 text-[11px] font-medium transition-colors ${
							isSelected
								? "text-inferay-white"
								: "text-inferay-muted-gray hover:bg-inferay-white/[0.06] hover:text-inferay-soft-white"
						}`}
						style={{
							backgroundColor: isSelected
								? "rgba(255,255,255,0.08)"
								: "transparent",
						}}
					>
						{getAgentIcon(kind, 12)}
						{labelPrefix ? `${labelPrefix} ${label}` : label}
					</button>
				);
			})}
		</div>
	);
});
