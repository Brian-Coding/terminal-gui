import React, { useState } from "react";
import { Icons } from "./Icons";

type TerminalLine = {
	type: "command" | "output" | "error" | "success" | "info";
	content: string;
	timestamp?: string;
};

type TerminalPane = {
	id: number;
	name: string;
	history: TerminalLine[];
	cwd: string;
};

const terminalPanes: TerminalPane[] = [
	{
		id: 1,
		name: "zsh",
		cwd: "~/projects/my-app",
		history: [
			{ type: "command", content: "npm run typecheck", timestamp: "0:41" },
			{ type: "output", content: "$ tsc --noEmit" },
			{ type: "success", content: "✓ No type errors found" },
			{
				type: "command",
				content: "npm run test -- --watch=false",
				timestamp: "0:35",
			},
			{ type: "output", content: "$ jest --watch=false" },
			{ type: "info", content: "PASS src/hooks/useAuth.test.ts" },
			{ type: "info", content: "PASS src/lib/api.test.ts" },
			{ type: "info", content: "PASS src/components/UserProfile.test.tsx" },
			{ type: "output", content: "" },
			{ type: "success", content: "Test Suites: 3 passed, 3 total" },
			{ type: "success", content: "Tests:       12 passed, 12 total" },
			{ type: "output", content: "Time:        2.847s" },
		],
	},
	{
		id: 2,
		name: "zsh",
		cwd: "~/projects/my-app",
		history: [
			{ type: "command", content: "git status", timestamp: "0:28" },
			{ type: "output", content: "On branch main" },
			{ type: "output", content: "Changes to be committed:" },
			{
				type: "success",
				content: "  modified:   src/components/UserProfile.tsx",
			},
			{ type: "success", content: "  modified:   src/hooks/useAuth.ts" },
			{ type: "success", content: "  new file:   src/lib/RetryStrategy.ts" },
			{ type: "output", content: "" },
			{ type: "output", content: "Changes not staged for commit:" },
			{ type: "error", content: "  modified:   src/lib/api.ts" },
			{ type: "error", content: "  modified:   src/types/types.ts" },
		],
	},
];

function SingleTerminalPane({
	pane,
	isActive,
	onSelect,
}: {
	pane: TerminalPane;
	isActive: boolean;
	onSelect: () => void;
}) {
	const [inputValue, setInputValue] = useState("");
	const getLineColor = (type: TerminalLine["type"]) => {
		switch (type) {
			case "command":
				return "text-surgent-text";
			case "error":
				return "text-red-400";
			case "success":
				return "text-green-400";
			case "info":
				return "text-blue-400";
			default:
				return "text-surgent-text-3";
		}
	};

	return (
		<div
			className={`flex-1 min-w-0 flex flex-col bg-black ${isActive ? "" : "opacity-70"}`}
			onClick={onSelect}
		>
			{/* Pane content */}
			<div className="flex-1 overflow-y-auto p-2 font-mono text-[10px] leading-relaxed space-y-0.5">
				{pane.history.map((line, i) => (
					<div
						key={i}
						className={`flex items-start gap-2 ${getLineColor(line.type)}`}
					>
						{line.type === "command" ? (
							<>
								<span className="text-surgent-accent shrink-0 select-none">
									❯
								</span>
								<span className="flex-1 font-medium">{line.content}</span>
								{line.timestamp && (
									<span className="text-surgent-text-3 text-[8px] tabular-nums shrink-0">
										{line.timestamp}
									</span>
								)}
							</>
						) : (
							<>
								<span className="w-3 shrink-0" />
								<span className="flex-1 whitespace-pre-wrap">
									{line.content}
								</span>
							</>
						)}
					</div>
				))}
			</div>

			{/* Input line - each pane gets its own input */}
			<div
				className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-t border-surgent-border bg-surgent-bg/50"
				onClick={(e) => e.stopPropagation()}
			>
				<span className="text-surgent-accent text-[10px] select-none">❯</span>
				<input
					type="text"
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					onFocus={onSelect}
					placeholder="Enter command..."
					className="flex-1 bg-transparent text-[10px] font-mono text-surgent-text outline-none placeholder:text-surgent-text-3"
				/>
			</div>
		</div>
	);
}

export function TerminalPanel({
	isExpanded,
	onToggle,
}: {
	isExpanded: boolean;
	onToggle: () => void;
}) {
	const [activePane, setActivePane] = useState(0);
	const [splitView, setSplitView] = useState(true);
	const [isMaximized, setIsMaximized] = useState(false);

	if (!isExpanded) {
		// Collapsed state - minimal bar
		return (
			<div className="border-t border-surgent-border bg-surgent-bg">
				<button
					onClick={onToggle}
					className="w-full flex items-center gap-2 px-3 py-1 hover:bg-surgent-surface/50 transition-colors"
				>
					<span className="text-surgent-text-3">
						<Icons.Terminal />
					</span>
					<span className="text-[9px] font-medium text-surgent-text-2">
						Terminal
					</span>
					<span className="flex-1" />
					<span className="text-[8px] text-surgent-text-3 tabular-nums">
						2 shells
					</span>
					<span className="text-surgent-text-3">
						<Icons.Chevron />
					</span>
				</button>
			</div>
		);
	}

	const panelHeight = isMaximized ? "h-[400px]" : "h-[180px]";

	return (
		<div
			className={`border-t border-surgent-border bg-black flex flex-col ${panelHeight}`}
		>
			{/* Header */}
			<div className="flex items-center h-7 border-b border-surgent-border bg-surgent-bg shrink-0">
				{/* Tab bar */}
				<div className="flex items-center flex-1 min-w-0">
					{terminalPanes.map((pane, i) => (
						<button
							key={pane.id}
							onClick={() => setActivePane(i)}
							className={`flex items-center gap-1.5 px-2 h-full border-r border-surgent-border transition-colors ${
								activePane === i || splitView
									? "bg-black text-surgent-text"
									: "bg-surgent-bg text-surgent-text-3 hover:text-surgent-text-2"
							}`}
						>
							<span className="text-surgent-text-3">
								<Icons.Terminal />
							</span>
							<span className="text-[9px] font-medium">{pane.name}</span>
							<span className="text-[8px] text-surgent-text-3 font-mono truncate max-w-[70px]">
								{pane.cwd}
							</span>
						</button>
					))}
					{/* New terminal button */}
					<button className="flex items-center justify-center w-6 h-full text-surgent-text-3 hover:text-surgent-text-2 hover:bg-surgent-surface/50 transition-colors">
						<Icons.Plus />
					</button>
				</div>

				{/* Actions */}
				<div className="flex items-center gap-0.5 px-1.5">
					{/* Split view toggle */}
					<button
						onClick={() => setSplitView(!splitView)}
						className={`p-1 rounded-md transition-colors ${
							splitView
								? "text-surgent-text bg-surgent-surface border border-surgent-border"
								: "text-surgent-text-3 hover:text-surgent-text-2 hover:bg-surgent-surface/50 border border-transparent"
						}`}
						title="Split view"
					>
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect x="3" y="3" width="18" height="18" rx="2" />
							<line x1="12" y1="3" x2="12" y2="21" />
						</svg>
					</button>
					{/* Maximize/Restore */}
					<button
						onClick={() => setIsMaximized(!isMaximized)}
						className="p-1 rounded-md text-surgent-text-3 hover:text-surgent-text-2 hover:bg-surgent-surface/50 transition-colors border border-transparent"
						title={isMaximized ? "Restore" : "Maximize"}
					>
						{isMaximized ? <Icons.Collapse /> : <Icons.Expand />}
					</button>
					{/* Clear */}
					<button
						className="p-1 rounded-md text-surgent-text-3 hover:text-surgent-text-2 hover:bg-surgent-surface/50 transition-colors border border-transparent"
						title="Clear"
					>
						<Icons.Close />
					</button>
					{/* Minimize */}
					<button
						onClick={onToggle}
						className="p-1 rounded-md text-surgent-text-3 hover:text-surgent-text-2 hover:bg-surgent-surface/50 transition-colors border border-transparent"
						title="Minimize"
					>
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
					</button>
				</div>
			</div>

			{/* Terminal content area */}
			<div className="flex-1 flex min-h-0 overflow-hidden">
				{splitView ? (
					<>
						{terminalPanes.map((pane, i) => (
							<React.Fragment key={pane.id}>
								{i > 0 && <div className="w-px bg-surgent-border shrink-0" />}
								<SingleTerminalPane
									pane={pane}
									isActive={activePane === i}
									onSelect={() => setActivePane(i)}
								/>
							</React.Fragment>
						))}
					</>
				) : (
					<SingleTerminalPane
						pane={terminalPanes[activePane]}
						isActive={true}
						onSelect={() => {}}
					/>
				)}
			</div>
		</div>
	);
}
