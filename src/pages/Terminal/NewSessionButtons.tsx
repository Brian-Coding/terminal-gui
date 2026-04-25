import { memo } from "react";
import { getAgentIcon } from "../../lib/agent-ui.tsx";
import { getAgentDefinition, NEW_PANE_AGENT_KINDS } from "../../lib/agents.ts";
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
	return (
		<div className="flex flex-wrap justify-center gap-2">
			{NEW_PANE_AGENT_KINDS.map((kind) => {
				const label = getAgentDefinition(kind).label;
				const isSelected = kind === selectedKind;
				return (
					<button
						key={kind}
						type="button"
						onClick={() => onAddPane(kind)}
						className={`flex h-7 items-center gap-1.5 rounded-lg border border-inferay-border px-3 text-xs font-medium transition-all ${
							isSelected
								? "text-inferay-text"
								: "text-inferay-text-3 hover:text-inferay-text-2"
						}`}
						style={{
							backgroundColor: isSelected
								? "var(--color-inferay-surface-2)"
								: "var(--color-inferay-surface)",
						}}
					>
						{kind !== "terminal" && getAgentIcon(kind, 12)}
						{labelPrefix ? `${labelPrefix} ${label}` : label}
					</button>
				);
			})}
		</div>
	);
});
