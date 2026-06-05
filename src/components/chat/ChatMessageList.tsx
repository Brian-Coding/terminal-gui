import * as stylex from "@stylexjs/stylex";
import { useVirtualizer } from "@tanstack/react-virtual";
import React, {
	useCallback,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import type { CheckpointInfo } from "../../features/chat/agent-chat-shared.ts";
import {
	color,
	controlSize,
	font,
	motion,
	radius,
} from "../../tokens.stylex.ts";
import { ThinkingIndicator } from "../ui/DotMatrixLoader.tsx";
import {
	IconCheck,
	IconChevronDown,
	IconClock,
	IconCopy,
} from "../ui/Icons.tsx";
import { GroupedEditDiff, MiniEditDiff } from "./ChatEditDiff.tsx";
import { AskUserQuestionCard, Markdown } from "./ChatRichContent.tsx";
import {
	buildRenderItems,
	getEditToolPayload,
	getToolOutputSummary,
	type RenderChatMessage,
	type RenderItem,
} from "./chat-message-render-utils.ts";
import { renderTextPills } from "./chat-token-decorators.tsx";

type ChatMessage = RenderChatMessage;

export type ChatVirtualizerControls = {
	scrollToEnd: (behavior?: ScrollBehavior) => void;
	isAtEnd: () => boolean;
	getDistanceFromEnd: () => number;
};

type ChatRenderRow =
	| RenderItem
	| { type: "thinking"; key: string; startTime: number };

function getRowKey(row: ChatRenderRow | undefined, index: number) {
	if (!row) return `row-${index}`;
	if (row.type === "thinking") return row.key;
	if (row.type === "edit-group") {
		return `edit-group:${index}:${row.filePath}:${row.edits.map((edit) => edit.id).join(":")}`;
	}
	return `${row.message.id}:${index}`;
}

function ToolOutputHighlight({ content }: { content: string }) {
	const summary = getToolOutputSummary(content);
	if (summary.type === "edit" || summary.type === "file-content") {
		return (
			<>
				<span {...stylex.props(styles.toolMuted)}>{summary.fileName}</span>
				{"\n"}
				<span {...stylex.props(styles.toolAccent)}>{summary.value}</span>
			</>
		);
	}
	if (summary.type === "command") {
		return <span {...stylex.props(styles.toolAccent)}>$ {summary.value}</span>;
	}
	if (summary.type === "pattern") {
		return <span {...stylex.props(styles.toolAccent)}>/{summary.value}/</span>;
	}
	if (summary.type === "accent") {
		return <span {...stylex.props(styles.toolAccent)}>{summary.value}</span>;
	}
	if (summary.type === "url") {
		return (
			<a
				href={summary.value}
				target="_blank"
				rel="noopener noreferrer"
				{...stylex.props(styles.toolLink)}
			>
				{summary.value}
			</a>
		);
	}
	return <>{summary.value}</>;
}

function CheckpointMarker({
	checkpoint,
	onRevert,
}: {
	checkpoint: CheckpointInfo;
	onRevert: (id: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	return (
		<div {...stylex.props(styles.checkpointCard)}>
			<div
				{...stylex.props(styles.checkpointHeader)}
				style={{
					borderBottom: expanded
						? "1px solid var(--color-inferay-gray-border)"
						: "none",
				}}
			>
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					{...stylex.props(styles.checkpointToggle)}
				>
					<IconChevronDown
						size={11}
						{...stylex.props(
							styles.checkpointChevron,
							!expanded && styles.rotateClosed
						)}
					/>
					<IconClock
						size={11}
						{...stylex.props(
							styles.checkpointIcon,
							checkpoint.reverted && styles.revertedIcon
						)}
					/>
					<span {...stylex.props(styles.checkpointTitle)}>
						{checkpoint.changedFileCount} file
						{checkpoint.changedFileCount !== 1 ? "s" : ""} changed
					</span>
				</button>
				<span {...stylex.props(styles.spacer)} />
				{!checkpoint.reverted ? (
					<button
						type="button"
						onClick={() => onRevert(checkpoint.id)}
						{...stylex.props(styles.undoButton)}
					>
						Undo
					</button>
				) : (
					<span {...stylex.props(styles.revertedLabel)}>reverted</span>
				)}
			</div>
			{expanded && (
				<div {...stylex.props(styles.checkpointFiles)}>
					{checkpoint.changedFiles.map((f) => (
						<div key={f.path} {...stylex.props(styles.checkpointFile)}>
							<span
								style={{
									color:
										f.action === "created"
											? "#22c55e"
											: f.action === "deleted"
												? "#ef4444"
												: "#eab308",
								}}
							>
								{f.action === "created"
									? "+"
									: f.action === "deleted"
										? "-"
										: "~"}
							</span>
							<span {...stylex.props(styles.toolMuted)}>
								{f.path.split("/").pop()}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

const Bubble = React.memo(function Bubble({
	msg,
	collapsed,
	onToggle,
	onSendMessage,
	onMdFileClick,
	slashCommandNames,
}: {
	msg: ChatMessage;
	collapsed: boolean;
	onToggle: (id: string) => void;
	onSendMessage?: (text: string) => void;
	onMdFileClick?: (path: string) => void;
	slashCommandNames: readonly string[];
}) {
	const [copied, setCopied] = useState(false);
	const editPayload = useMemo(
		() =>
			msg.role === "tool" && msg.toolName === "Edit" && msg.content
				? getEditToolPayload(msg.content)
				: null,
		[msg.content, msg.role, msg.toolName]
	);
	const userMessageDisplay = useMemo(() => {
		if (msg.role !== "user") return null;
		let imagePaths = msg.images ?? [];
		let displayContent = msg.content;
		if (
			imagePaths.length === 0 &&
			msg.content.includes("Here are the images at these paths:")
		) {
			const parts = msg.content.split("Here are the images at these paths:\n");
			displayContent = parts[0]?.trim() ?? "";
			const pathLines = parts[1]?.split("\n").filter((p) => p.trim()) ?? [];
			imagePaths = pathLines.filter((p) => p.includes("/.tmp/"));
		}
		return {
			contentNodes: displayContent
				? renderTextPills(displayContent, slashCommandNames)
				: null,
			imagePaths,
		};
	}, [msg.content, msg.images, msg.role, slashCommandNames]);
	const handleCopyMessage = useCallback(() => {
		if (!msg.content) return;
		navigator.clipboard
			.writeText(msg.content)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => setCopied(false));
	}, [msg.content]);

	if (msg.role === "user") {
		const commandMatch = msg.content.match(/^\/([a-zA-Z0-9_-]+)(\s|$)/);
		if (
			commandMatch?.[1] &&
			slashCommandNames.some(
				(command) => command.toLowerCase() === commandMatch[1]!.toLowerCase()
			)
		) {
			return null;
		}
		if (!userMessageDisplay) return null;
		return (
			<div {...stylex.props(styles.userRow)}>
				<div {...stylex.props(styles.userBubble)}>
					{userMessageDisplay.imagePaths.length > 0 && (
						<div {...stylex.props(styles.userImages)}>
							{userMessageDisplay.imagePaths.map((imgPath) => (
								<img
									key={imgPath}
									src={`/api/file?path=${encodeURIComponent(imgPath)}`}
									alt=""
									{...stylex.props(styles.userImage)}
								/>
							))}
						</div>
					)}
					{userMessageDisplay.contentNodes && (
						<p {...stylex.props(styles.userText)}>
							{userMessageDisplay.contentNodes}
						</p>
					)}
				</div>
			</div>
		);
	}

	if (msg.role === "system") {
		const runningMatch = msg.content.match(/^Running \/(.+)\.\.\.$/);
		if (runningMatch?.[1]) {
			const commandName = runningMatch[1];
			return (
				<div {...stylex.props(styles.systemRunRow)}>
					<div {...stylex.props(styles.systemRunPill)}>
						<span {...stylex.props(styles.runningCommand)}>/{commandName}</span>
					</div>
				</div>
			);
		}
		return <p {...stylex.props(styles.systemText)}>{msg.content}</p>;
	}

	if (msg.role === "btw") {
		return (
			<div {...stylex.props(styles.btwCard)}>
				<div {...stylex.props(styles.btwHeader)}>
					<span {...stylex.props(styles.btwLabel)}>btw</span>
					{msg.btwQuestion && (
						<span {...stylex.props(styles.btwQuestion)}>
							- {msg.btwQuestion}
						</span>
					)}
				</div>
				<div {...stylex.props(styles.btwBody)}>
					{msg.content ? (
						<Markdown
							text={msg.content}
							onMdFileClick={onMdFileClick}
							streaming={msg.isStreaming}
						/>
					) : msg.isStreaming ? (
						<div {...stylex.props(styles.btwDots)}>
							<span {...stylex.props(styles.smallDot)} />
							<span {...stylex.props(styles.smallDot, styles.dot2)} />
							<span {...stylex.props(styles.smallDot, styles.dot3)} />
						</div>
					) : null}
				</div>
			</div>
		);
	}

	if (msg.role === "tool") {
		if (msg.toolName === "AskUserQuestion") {
			return (
				<AskUserQuestionCard
					content={msg.content}
					isStreaming={msg.isStreaming}
					onSendMessage={onSendMessage}
				/>
			);
		}
		if (editPayload) {
			return (
				<MiniEditDiff
					oldStr={editPayload.oldString}
					newStr={editPayload.newString}
					filePath={editPayload.filePath}
					isStreaming={msg.isStreaming}
				/>
			);
		}
		return (
			<div>
				<button
					type="button"
					onClick={() => onToggle(msg.id)}
					{...stylex.props(styles.toolToggle)}
				>
					<IconChevronDown
						size={7}
						{...stylex.props(collapsed && styles.rotateClosed)}
					/>
					<span {...stylex.props(styles.toolName)}>{msg.toolName}</span>
				</button>
				{!collapsed && msg.content && (
					<pre {...stylex.props(styles.toolOutput)}>
						<ToolOutputHighlight content={msg.content} />
					</pre>
				)}
			</div>
		);
	}

	return (
		<div {...stylex.props(styles.assistantMessage)}>
			<Markdown
				text={msg.content}
				onMdFileClick={onMdFileClick}
				streaming={msg.isStreaming}
			/>
			{!msg.isStreaming && msg.content.trim() ? (
				<div {...stylex.props(styles.messageActionRow)}>
					<button
						type="button"
						onClick={handleCopyMessage}
						title={copied ? "Copied" : "Copy message"}
						aria-label={copied ? "Copied message" : "Copy message"}
						{...stylex.props(
							styles.copyMessageButton,
							copied && styles.copyMessageButtonCopied
						)}
					>
						{copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
						<span>{copied ? "Copied" : "Copy"}</span>
					</button>
				</div>
			) : null}
		</div>
	);
});

export const ChatMessageList = React.memo(function ChatMessageList({
	messages,
	scrollElementRef,
	virtualizerControlsRef,
	expandedTools,
	toggleTool,
	checkpoints,
	revertCheckpoint,
	isLoading,
	startTime,
	handleSendMessage,
	onMdFileClick,
	slashCommandNames,
}: {
	messages: ChatMessage[];
	scrollElementRef: React.RefObject<HTMLDivElement | null>;
	virtualizerControlsRef?: React.Ref<ChatVirtualizerControls | null>;
	expandedTools: Set<string>;
	toggleTool: (id: string) => void;
	checkpoints: CheckpointInfo[];
	revertCheckpoint: (id: string) => void;
	isLoading: boolean;
	startTime?: number | null;
	handleSendMessage?: (text: string) => void;
	onMdFileClick?: (path: string) => void;
	slashCommandNames: readonly string[];
}) {
	const renderItems = useMemo(() => buildRenderItems(messages), [messages]);
	const renderRows = useMemo<ChatRenderRow[]>(() => {
		if (!isLoading || !startTime) return renderItems;
		return [...renderItems, { type: "thinking", key: "thinking", startTime }];
	}, [isLoading, renderItems, startTime]);
	const getVirtualRowKey = useCallback(
		(index: number) => getRowKey(renderRows[index], index),
		[renderRows]
	);
	const rowVirtualizer = useVirtualizer({
		count: renderRows.length,
		getScrollElement: () => scrollElementRef.current,
		getItemKey: getVirtualRowKey,
		estimateSize: () => 148,
		overscan: 8,
		gap: 8,
	});
	const virtualRows = rowVirtualizer.getVirtualItems();
	const renderedVirtualRows =
		virtualRows.length > 0 || renderRows.length === 0
			? virtualRows
			: [
					{
						index: renderRows.length - 1,
						key: `fallback-${renderRows.length - 1}`,
						start: Math.max(0, rowVirtualizer.getTotalSize() - 148),
					},
				];
	const checkpointsByMessageId = useMemo(() => {
		const byMessageId = new Map<string, CheckpointInfo>();
		for (const checkpoint of checkpoints) {
			if (checkpoint.afterMessageId) {
				byMessageId.set(checkpoint.afterMessageId, checkpoint);
			}
		}
		return byMessageId;
	}, [checkpoints]);

	useImperativeHandle(
		virtualizerControlsRef,
		() => ({
			scrollToEnd: (behavior = "smooth") => {
				if (renderRows.length === 0) return;
				rowVirtualizer.scrollToIndex(renderRows.length - 1, {
					align: "end",
					behavior,
				});
			},
			isAtEnd: () => {
				const el = scrollElementRef.current;
				if (!el) return true;
				return el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
			},
			getDistanceFromEnd: () => {
				const el = scrollElementRef.current;
				if (!el) return 0;
				return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
			},
		}),
		[renderRows.length, rowVirtualizer, scrollElementRef]
	);

	useLayoutEffect(() => {
		if (renderRows.length === 0) return;
		const raf = requestAnimationFrame(() => {
			rowVirtualizer.scrollToIndex(renderRows.length - 1, { align: "end" });
		});
		return () => cancelAnimationFrame(raf);
	}, [renderRows.length, rowVirtualizer]);

	return (
		<div
			{...stylex.props(styles.messageList)}
			style={{ height: rowVirtualizer.getTotalSize() }}
		>
			{renderedVirtualRows.map((virtualRow) => {
				const index = virtualRow.index;
				const item = renderRows[index];
				if (!item) return null;
				if (item.type === "thinking") {
					return (
						<div
							key={getRowKey(item, index)}
							data-index={index}
							ref={rowVirtualizer.measureElement}
							{...stylex.props(styles.messageRow)}
							style={{ transform: `translateY(${virtualRow.start}px)` }}
						>
							<ThinkingIndicator startTime={item.startTime} />
						</div>
					);
				}
				if (item.type === "edit-group") {
					return (
						<div
							key={getRowKey(item, index)}
							data-index={index}
							ref={rowVirtualizer.measureElement}
							{...stylex.props(styles.messageRow)}
							style={{ transform: `translateY(${virtualRow.start}px)` }}
						>
							<GroupedEditDiff filePath={item.filePath} edits={item.edits} />
						</div>
					);
				}
				const msg = item.message;
				const checkpoint =
					msg.role === "assistant" && !msg.isStreaming
						? checkpointsByMessageId.get(msg.id)
						: undefined;
				return (
					<div
						key={getRowKey(item, index)}
						data-index={index}
						ref={rowVirtualizer.measureElement}
						{...stylex.props(styles.messageRow)}
						style={{ transform: `translateY(${virtualRow.start}px)` }}
					>
						<Bubble
							msg={msg}
							collapsed={!expandedTools.has(msg.id)}
							onToggle={toggleTool}
							onSendMessage={handleSendMessage}
							onMdFileClick={onMdFileClick}
							slashCommandNames={slashCommandNames}
						/>
						{checkpoint && (
							<CheckpointMarker
								checkpoint={checkpoint}
								onRevert={revertCheckpoint}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
});

const styles = stylex.create({
	toolMuted: {
		color: color.textMuted,
	},
	toolAccent: {
		color: color.accent,
	},
	toolLink: {
		color: color.accent,
		textDecorationColor: {
			default: color.accentBorder,
			":hover": color.accent,
		},
		textDecorationLine: "underline",
	},
	checkpointCard: {
		backgroundColor: color.backgroundRaised,
		borderColor: color.border,
		borderRadius: radius.sm,
		borderStyle: "solid",
		borderWidth: 1,
		marginBlock: controlSize._1,
		overflow: "hidden",
	},
	checkpointHeader: {
		alignItems: "center",
		display: "flex",
		gap: controlSize._1,
		minHeight: controlSize._5,
		paddingBlock: controlSize._0_5,
		paddingInline: controlSize._1_5,
	},
	checkpointToggle: {
		alignItems: "center",
		color: color.textSoft,
		display: "flex",
		flex: 1,
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		gap: controlSize._1,
		minWidth: 0,
		textAlign: "left",
		transitionDuration: motion.durationBase,
		transitionProperty: "opacity",
		transitionTimingFunction: motion.ease,
		":hover": {
			opacity: 0.8,
		},
	},
	undoButton: {
		borderRadius: radius.sm,
		color: color.textMuted,
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		paddingBlock: 0,
		paddingInline: controlSize._1,
		transitionDuration: motion.durationBase,
		transitionProperty: "color, opacity",
		transitionTimingFunction: motion.ease,
		":hover": {
			color: color.textSoft,
		},
		":disabled": {
			opacity: 0.4,
		},
	},
	revertedLabel: {
		borderRadius: radius.md,
		color: color.textMuted,
		fontSize: font.size_2,
		fontStyle: "italic",
		paddingBlock: 1,
		paddingInline: controlSize._1_5,
	},
	checkpointFiles: {
		display: "flex",
		flexDirection: "column",
		gap: controlSize._0_5,
		paddingBottom: controlSize._2,
		paddingInline: controlSize._2,
		paddingTop: controlSize._1,
	},
	checkpointFile: {
		alignItems: "center",
		display: "flex",
		fontFamily: font.familyMono,
		fontSize: font.size_1,
		gap: controlSize._1_5,
		paddingInline: controlSize._1,
	},
	checkpointChevron: {
		flexShrink: 0,
		opacity: 0.4,
		transitionDuration: motion.durationBase,
		transitionProperty: "transform",
	},
	rotateClosed: {
		transform: "rotate(-90deg)",
	},
	checkpointIcon: {
		flexShrink: 0,
		opacity: 0.4,
		color: color.textMuted,
	},
	revertedIcon: {
		color: color.danger,
	},
	checkpointTitle: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		opacity: 0.8,
	},
	spacer: {
		flex: 1,
	},
	userRow: {
		display: "flex",
		justifyContent: "flex-end",
	},
	userBubble: {
		maxWidth: "85%",
		borderRadius: radius.lg,
		borderBottomRightRadius: radius.xs,
		paddingBlock: controlSize._1_5,
		paddingInline: controlSize._2_5,
	},
	userImages: {
		display: "flex",
		flexWrap: "wrap",
		gap: controlSize._1_5,
		marginBottom: controlSize._1_5,
	},
	userImage: {
		maxWidth: "8rem",
		maxHeight: "6rem",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.borderControl,
		borderRadius: radius.sm,
		objectFit: "cover",
	},
	userText: {
		whiteSpace: "pre-wrap",
		overflowWrap: "break-word",
		fontSize: font.size_3,
	},
	systemRunRow: {
		display: "flex",
		justifyContent: "center",
		paddingBlock: controlSize._1,
	},
	systemRunPill: {
		display: "inline-flex",
		alignItems: "center",
		gap: controlSize._2_5,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.accentBorder,
		borderRadius: radius.lg,
		backgroundColor: color.accentWash,
		paddingBlock: controlSize._1_5,
		paddingInline: controlSize._3,
	},
	runningCommand: {
		color: color.accent,
		fontFamily: font.familyMono,
		fontSize: font.size_4,
		fontWeight: font.weight_5,
	},
	dot2: {
		animationDelay: "0.1s",
	},
	dot3: {
		animationDelay: "0.2s",
	},
	systemText: {
		color: color.textMuted,
		fontSize: font.size_2,
		textAlign: "center",
	},
	btwCard: {
		borderWidth: 1,
		borderStyle: "dashed",
		borderColor: color.accentBorder,
		borderRadius: radius.lg,
		backgroundColor: color.accentWash,
		paddingBlock: controlSize._2,
		paddingInline: controlSize._3,
	},
	btwHeader: {
		display: "flex",
		alignItems: "center",
		gap: controlSize._1_5,
		marginBottom: controlSize._1_5,
	},
	btwLabel: {
		color: color.accent,
		fontSize: font.size_1,
		fontWeight: font.weight_6,
		letterSpacing: "0.08em",
		textTransform: "uppercase",
	},
	btwQuestion: {
		color: color.textMuted,
		fontFamily: font.familyMono,
		fontSize: font.size_2,
	},
	btwBody: {
		color: color.textSoft,
		fontSize: font.size_3,
		lineHeight: 1.6,
	},
	btwDots: {
		display: "flex",
		alignItems: "center",
		gap: controlSize._0_5,
		paddingBlock: controlSize._1,
	},
	smallDot: {
		width: controlSize._1,
		height: controlSize._1,
		borderRadius: radius.pill,
		backgroundColor: color.accent,
		animationName: stylex.keyframes({
			"50%": {
				transform: "translateY(-2px)",
			},
		}),
		animationDuration: "0.6s",
		animationIterationCount: "infinite",
	},
	toolToggle: {
		display: "flex",
		alignItems: "center",
		gap: controlSize._1,
		color: color.textMuted,
		fontSize: font.size_2,
	},
	toolName: {
		fontFamily: font.familyMono,
		fontSize: font.size_1,
	},
	toolOutput: {
		maxHeight: "7rem",
		overflow: "auto",
		whiteSpace: "pre-wrap",
		overflowWrap: "break-word",
		borderRadius: radius.sm,
		backgroundColor: color.backgroundRaised,
		color: color.textMuted,
		fontFamily: font.familyMono,
		fontSize: font.size_1,
		lineHeight: 1.6,
		marginTop: "0.125rem",
		paddingBlock: controlSize._1,
		paddingInline: controlSize._2,
	},
	assistantMessage: {
		position: "relative",
		width: "100%",
		minWidth: 0,
		overflowWrap: "break-word",
		color: color.textSoft,
		fontSize: font.size_3,
		lineHeight: 1.6,
	},
	messageActionRow: {
		display: "flex",
		justifyContent: "flex-end",
		marginTop: controlSize._1,
	},
	copyMessageButton: {
		alignItems: "center",
		backgroundColor: {
			default: color.transparent,
			":hover": color.surfaceControl,
		},
		borderRadius: radius.sm,
		color: {
			default: color.textMuted,
			":hover": color.textSoft,
		},
		display: "inline-flex",
		fontSize: font.size_2,
		fontWeight: font.weight_5,
		gap: controlSize._1,
		minHeight: controlSize._6,
		paddingBlock: controlSize._0_5,
		paddingInline: controlSize._1_5,
		transitionDuration: motion.durationBase,
		transitionProperty: "background-color, color",
		transitionTimingFunction: motion.ease,
	},
	copyMessageButtonCopied: {
		backgroundColor: color.successWash,
		color: color.success,
	},
	messageList: {
		boxSizing: "border-box",
		minHeight: "100%",
		minWidth: 0,
		paddingBlock: `${controlSize._4} ${controlSize._8}`,
		paddingInline: controlSize._5,
		position: "relative",
		width: "100%",
	},
	messageRow: {
		boxSizing: "border-box",
		left: controlSize._5,
		position: "absolute",
		right: controlSize._5,
		top: controlSize._4,
	},
});
