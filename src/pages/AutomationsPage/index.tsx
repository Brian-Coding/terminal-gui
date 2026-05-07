import * as stylex from "@stylexjs/stylex";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	IconClock,
	IconCode,
	IconEye,
	IconFilePlus,
	IconFolder,
	IconGitBranch,
	IconGlobe,
	IconPlus,
	IconRobot,
	IconSearch,
	IconTerminal,
	IconWorkflow,
} from "../../components/ui/Icons.tsx";
import {
	hasId,
	isPresent,
	lacksId,
	setRecordEntry,
	withRecordEntry,
} from "../../lib/data.ts";
import { fetchJsonOr, sendJson } from "../../lib/fetch-json.ts";
import { listenWindowEvent } from "../../lib/react-events.ts";
import {
	color,
	controlSize,
	font,
	motion,
	radius,
	shadow,
} from "../../tokens.stylex.ts";
import { InlineDirectoryPicker } from "../Terminal/InlineDirectoryPicker.tsx";

type AutomationStatus = "ready" | "scheduled" | "running";
type NodeKind =
	| "input"
	| "prompt"
	| "research"
	| "image"
	| "code"
	| "condition"
	| "output"
	| "script"
	| "note"
	| "agent"
	| "web"
	| "shape";

interface NodeKindConfig {
	label: string;
	icon: typeof IconWorkflow;
	inputs: string[];
	outputs: string[];
	tone: "emerald" | "blue" | "purple" | "pink" | "amber" | "orange" | "cyan";
}

interface AutomationFlow {
	id: string;
	name: string;
	description: string;
	schedule: string;
	nextRun: string;
	status: AutomationStatus;
	primaryPath: string;
	referencePaths: string[];
	nodes: AutomationNode[];
	edges: Array<[string, string]>;
}

interface AutomationNode {
	id: string;
	kind: NodeKind;
	title: string;
	description: string;
	x: number;
	y: number;
	file: string;
	contextPaths?: string[];
	body: string;
	output: string;
}

interface NodeDragState {
	nodeId: string;
	startClientX: number;
	startClientY: number;
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
	element: HTMLButtonElement;
	pointerId: number;
}

interface RunState {
	flowId: string;
	activeNodeId: string | null;
	completedNodeIds: string[];
	isRunning: boolean;
}

const NODE_WIDTH = 140;
const NODE_PORT_TOP = 44;
const NODE_PORT_ROW_HEIGHT = 16;

const defaultFlows: AutomationFlow[] = [createStarterWorkflow(1)];

function createStarterWorkflow(index: number): AutomationFlow {
	const id = `workflow-${Date.now().toString(36)}`;
	return {
		id,
		name: `Workflow ${index}`,
		description:
			"Draft workflow with a context step, an agent task, and a final output.",
		schedule: "Manual",
		nextRun: "Manual",
		status: "ready",
		primaryPath: "~/Desktop",
		referencePaths: [],
		edges: [
			["context", "agent"],
			["agent", "output"],
		],
		nodes: [
			{
				id: "context",
				kind: "input",
				title: "Choose context",
				description: "Pick the primary folder and supporting references.",
				x: 72,
				y: 138,
				file: `automations/${id}/00-context.md`,
				body: "Describe the files, folders, and constraints this workflow should use.",
				output: "context.md",
			},
			{
				id: "agent",
				kind: "agent",
				title: "Run agent task",
				description: "Execute the main automation step against the context.",
				x: 366,
				y: 118,
				file: `automations/${id}/10-agent.md`,
				body: "Describe the work the agent should perform. Include expected checks and output format.",
				output: "result.md",
			},
			{
				id: "output",
				kind: "output",
				title: "Save output",
				description: "Write the workflow result to the expected artifact.",
				x: 660,
				y: 142,
				file: `automations/${id}/20-output.md`,
				body: "Define where the result should be written and what the final summary should include.",
				output: "summary.md",
			},
		],
	};
}

const nodeKinds = {
	input: {
		label: "Input",
		icon: IconFilePlus,
		inputs: [],
		outputs: ["out"],
		tone: "emerald",
	},
	prompt: {
		label: "Prompt",
		icon: IconTerminal,
		inputs: ["in"],
		outputs: ["out"],
		tone: "blue",
	},
	research: {
		label: "Research",
		icon: IconSearch,
		inputs: ["topic"],
		outputs: ["findings"],
		tone: "purple",
	},
	image: {
		label: "Generate Image",
		icon: IconFolder,
		inputs: ["prompt"],
		outputs: ["image"],
		tone: "pink",
	},
	code: {
		label: "Code",
		icon: IconCode,
		inputs: ["in"],
		outputs: ["patch"],
		tone: "amber",
	},
	condition: {
		label: "Condition",
		icon: IconGitBranch,
		inputs: ["in"],
		outputs: ["pass", "fail"],
		tone: "orange",
	},
	output: {
		label: "Output",
		icon: IconEye,
		inputs: ["content"],
		outputs: [],
		tone: "cyan",
	},
	script: {
		label: "Script",
		icon: IconTerminal,
		inputs: ["in"],
		outputs: ["out"],
		tone: "amber",
	},
	note: {
		label: "Note",
		icon: IconWorkflow,
		inputs: ["in"],
		outputs: ["out"],
		tone: "blue",
	},
	agent: {
		label: "Prompt",
		icon: IconRobot,
		inputs: ["context"],
		outputs: ["result"],
		tone: "blue",
	},
	web: {
		label: "Research",
		icon: IconGlobe,
		inputs: ["query"],
		outputs: ["findings"],
		tone: "purple",
	},
	shape: {
		label: "Output",
		icon: IconCode,
		inputs: ["content"],
		outputs: ["out"],
		tone: "cyan",
	},
} satisfies Record<NodeKind, NodeKindConfig>;

const paletteKinds = [
	"input",
	"prompt",
	"research",
	"image",
	"code",
	"condition",
	"output",
] as const satisfies readonly NodeKind[];

function getNodeConfig(kind: unknown): NodeKindConfig {
	if (typeof kind === "string" && kind in nodeKinds) {
		return nodeKinds[kind as NodeKind];
	}
	return nodeKinds.prompt;
}

function getInputPortY(node: AutomationNode): number {
	return node.y + NODE_PORT_TOP;
}

function getOutputPortY(node: AutomationNode): number {
	const config = getNodeConfig(node.kind);
	return (
		node.y +
		NODE_PORT_TOP +
		Math.max(0, config.inputs.length) * NODE_PORT_ROW_HEIGHT
	);
}

function statusLabel(status: AutomationStatus) {
	if (status === "running") return "Running";
	if (status === "scheduled") return "Scheduled";
	return "Ready";
}

function isTextEditingTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	const tagName = target.tagName.toLowerCase();
	return (
		target.isContentEditable ||
		tagName === "input" ||
		tagName === "select" ||
		tagName === "textarea"
	);
}

export function AutomationsPage() {
	const [flows, setFlows] = useState<AutomationFlow[]>(defaultFlows);
	const [selectedFlowId, setSelectedFlowId] = useState(defaultFlows[0]!.id);
	const [selectedNodeId, setSelectedNodeId] = useState(
		defaultFlows[0]!.nodes[0]!.id
	);
	const [showGrid, setShowGrid] = useState(false);
	const [isPickingFolders, setIsPickingFolders] = useState(false);
	const [folderSelections, setFolderSelections] = useState<
		Record<string, string[]>
	>({});
	const [dragState, setDragState] = useState<NodeDragState | null>(null);
	const [runState, setRunState] = useState<RunState | null>(null);
	const flowsRef = useRef(flows);
	const dragStateRef = useRef<NodeDragState | null>(null);
	const dragCleanupRef = useRef<(() => void) | null>(null);
	const dragFrameRef = useRef<number | null>(null);
	const edgePathRefs = useRef(new Map<string, SVGPathElement>());
	const runTimerRef = useRef<number | null>(null);

	const selectedFlow =
		flows.find(hasId.bind(null, selectedFlowId)) ?? flows[0]!;
	const selectedNode =
		selectedFlow.nodes.find(hasId.bind(null, selectedNodeId)) ??
		selectedFlow.nodes[0]!;
	const selectedFlowPaths = [
		selectedFlow.primaryPath,
		...selectedFlow.referencePaths,
	];
	const selectedNodeContextPaths =
		folderSelections[selectedNode.id] ??
		selectedNode.contextPaths ??
		selectedFlowPaths;
	const primaryPath = selectedNodeContextPaths[0] ?? selectedFlow.primaryPath;
	const referencePaths = selectedNodeContextPaths.slice(1);
	const selectedNodeIndex = selectedFlow.nodes.findIndex(
		hasId.bind(null, selectedNode.id)
	);
	const incomingNodes = selectedFlow.edges
		.filter(([, toId]) => toId === selectedNode.id)
		.map(([fromId]) => selectedFlow.nodes.find(hasId.bind(null, fromId)))
		.filter(isPresent);
	const outgoingNodes = selectedFlow.edges
		.filter(([fromId]) => fromId === selectedNode.id)
		.map(([, toId]) => selectedFlow.nodes.find(hasId.bind(null, toId)))
		.filter(isPresent);

	useEffect(() => {
		flowsRef.current = flows;
	}, [flows]);

	useEffect(() => {
		return () => {
			if (runTimerRef.current !== null) {
				window.clearTimeout(runTimerRef.current);
			}
			if (dragFrameRef.current !== null) {
				window.cancelAnimationFrame(dragFrameRef.current);
			}
			dragCleanupRef.current?.();
		};
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		const load = async () => {
			const payload = await fetchJsonOr<{ flows?: AutomationFlow[] }>(
				"/api/automations",
				{ flows: [] }
			);
			if (
				signal.aborted ||
				!Array.isArray(payload.flows) ||
				payload.flows.length < 1
			) {
				return;
			}
			setFlows(payload.flows);
			setSelectedFlowId((current) =>
				payload.flows!.some(hasId.bind(null, current))
					? current
					: payload.flows![0]!.id
			);
			setSelectedNodeId((current) => {
				const activeFlow =
					payload.flows!.find(hasId.bind(null, selectedFlowId)) ??
					payload.flows![0]!;
				return activeFlow.nodes.some(hasId.bind(null, current))
					? current
					: (activeFlow.nodes[0]?.id ?? "");
			});
		};
		void load();
		return controller.abort.bind(controller);
	}, [selectedFlowId]);

	const persistFlows = async (nextFlows: AutomationFlow[]) => {
		setFlows(nextFlows);
		flowsRef.current = nextFlows;
		await sendJson("/api/automations", { flows: nextFlows }, { method: "PUT" });
	};

	const updateSelectedFlow = async (
		updater: (flow: AutomationFlow) => AutomationFlow
	) => {
		const nextFlows = flows.map((flow) =>
			flow.id === selectedFlow.id ? updater(flow) : flow
		);
		await persistFlows(nextFlows);
	};

	const edgeLines = useMemo(() => {
		return selectedFlow.edges.flatMap(([fromId, toId]) => {
			const from = selectedFlow.nodes.find(hasId.bind(null, fromId));
			const to = selectedFlow.nodes.find(hasId.bind(null, toId));
			if (!from || !to) return [];
			return [
				{
					id: `${fromId}-${toId}`,
					fromId,
					toId,
					fromNode: from,
					toNode: to,
					x1: from.x + NODE_WIDTH,
					y1: getOutputPortY(from),
					x2: to.x,
					y2: getInputPortY(to),
				},
			];
		});
	}, [selectedFlow]);

	const buildEdgePath = (
		edge: (typeof edgeLines)[number],
		override?: { nodeId: string; x: number; y: number }
	) => {
		const x1 =
			override && edge.fromId === override.nodeId
				? override.x + NODE_WIDTH
				: edge.x1;
		const y1 =
			override && edge.fromId === override.nodeId
				? getOutputPortY({ ...edge.fromNode, x: override.x, y: override.y })
				: edge.y1;
		const x2 = override && edge.toId === override.nodeId ? override.x : edge.x2;
		const y2 =
			override && edge.toId === override.nodeId
				? getInputPortY({ ...edge.toNode, x: override.x, y: override.y })
				: edge.y2;
		return `M ${x1} ${y1} C ${x1 + 72} ${y1}, ${x2 - 72} ${y2}, ${x2} ${y2}`;
	};

	const selectFlow = (flow: AutomationFlow) => {
		setSelectedFlowId(flow.id);
		setSelectedNodeId(flow.nodes[0]?.id ?? "");
		setIsPickingFolders(false);
	};

	const handleAddWorkflow = async () => {
		const flow = createStarterWorkflow(flows.length + 1);
		const nextFlows = [...flows, flow];
		await persistFlows(nextFlows);
		setSelectedFlowId(flow.id);
		setSelectedNodeId(flow.nodes[0]!.id);
		setIsPickingFolders(false);
	};

	const handleAddNode = async (kind: NodeKind = "prompt") => {
		const config = nodeKinds[kind];
		const node: AutomationNode = {
			id: `${kind}-${Date.now()}`,
			kind,
			title: config.label,
			description: `Configure this ${config.label.toLowerCase()} step.`,
			x: 440,
			y: 210,
			file: `automations/${selectedFlow.id}/${selectedFlow.nodes.length
				.toString()
				.padStart(2, "0")}-${kind}.md`,
			body: "",
			output: config.outputs[0] ?? "done",
		};
		await updateSelectedFlow((flow) => ({
			...flow,
			nodes: [...flow.nodes, node],
		}));
		setSelectedNodeId(node.id);
	};

	const handleDeleteSelectedNode = useCallback(async () => {
		if (selectedFlow.nodes.length <= 1) return;

		const selectedIndex = selectedFlow.nodes.findIndex(
			(node) => node.id === selectedNode.id
		);
		if (selectedIndex === -1) return;

		const fallbackNode =
			selectedFlow.nodes[selectedIndex + 1] ??
			selectedFlow.nodes[selectedIndex - 1];
		if (!fallbackNode) return;

		const nextFlows = flows.map((flow) => {
			if (flow.id !== selectedFlow.id) return flow;
			return {
				...flow,
				edges: flow.edges.filter(
					([fromId, toId]) =>
						fromId !== selectedNode.id && toId !== selectedNode.id
				),
				nodes: flow.nodes.filter(lacksId.bind(null, selectedNode.id)),
			};
		});

		setSelectedNodeId(fallbackNode.id);
		if (runState?.flowId === selectedFlow.id) {
			setRunState(null);
		}
		await persistFlows(nextFlows);
	}, [flows, persistFlows, runState?.flowId, selectedFlow, selectedNode.id]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				(event.key !== "Delete" && event.key !== "Backspace") ||
				isTextEditingTarget(event.target)
			) {
				return;
			}
			event.preventDefault();
			void handleDeleteSelectedNode();
		};

		return listenWindowEvent("keydown", handleKeyDown);
	}, [handleDeleteSelectedNode]);

	const handleRunOnce = () => {
		if (runTimerRef.current !== null) {
			window.clearTimeout(runTimerRef.current);
		}
		const nodes = selectedFlow.nodes;
		if (nodes.length < 1) return;

		const runStep = (index: number, completedNodeIds: string[]) => {
			const activeNode = nodes[index];
			if (!activeNode) {
				setRunState({
					flowId: selectedFlow.id,
					activeNodeId: null,
					completedNodeIds,
					isRunning: false,
				});
				return;
			}
			setSelectedNodeId(activeNode.id);
			setRunState({
				flowId: selectedFlow.id,
				activeNodeId: activeNode.id,
				completedNodeIds,
				isRunning: true,
			});
			runTimerRef.current = window.setTimeout(() => {
				runStep(index + 1, [...completedNodeIds, activeNode.id]);
			}, 900);
		};

		runStep(0, []);
	};

	const updateSelectedNodeBody = async (body: string) => {
		await updateSelectedFlow((flow) => ({
			...flow,
			nodes: flow.nodes.map((node) =>
				node.id === selectedNode.id ? { ...node, body } : node
			),
		}));
	};

	const updateSelectedNodeContextPaths = async (paths: string[]) => {
		setFolderSelections(withRecordEntry(selectedNode.id, paths));
		await updateSelectedFlow((flow) => ({
			...flow,
			nodes: flow.nodes.map((node) =>
				node.id === selectedNode.id ? { ...node, contextPaths: paths } : node
			),
		}));
	};

	const updateNodePosition = (nodeId: string, x: number, y: number) => {
		const nextFlows = flowsRef.current.map((flow) =>
			flow.id === selectedFlow.id
				? {
						...flow,
						nodes: flow.nodes.map((node) =>
							node.id === nodeId
								? { ...node, x: Math.max(0, x), y: Math.max(0, y) }
								: node
						),
					}
				: flow
		);
		flowsRef.current = nextFlows;
		setFlows(nextFlows);
		return nextFlows;
	};

	const handleNodePointerDown = (
		event: ReactPointerEvent<HTMLButtonElement>,
		node: AutomationNode
	) => {
		event.preventDefault();
		dragCleanupRef.current?.();
		const element = event.currentTarget;
		element.setPointerCapture(event.pointerId);
		setSelectedNodeId(node.id);
		const nextDragState = {
			nodeId: node.id,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startX: node.x,
			startY: node.y,
			currentX: node.x,
			currentY: node.y,
			element,
			pointerId: event.pointerId,
		};
		dragStateRef.current = nextDragState;
		setDragState(nextDragState);

		const handlePointerMove = (moveEvent: PointerEvent) => {
			const currentDragState = dragStateRef.current;
			if (
				!currentDragState ||
				currentDragState.nodeId !== node.id ||
				moveEvent.pointerId !== currentDragState.pointerId
			) {
				return;
			}
			const deltaX = moveEvent.clientX - currentDragState.startClientX;
			const deltaY = moveEvent.clientY - currentDragState.startClientY;
			currentDragState.currentX = Math.max(0, currentDragState.startX + deltaX);
			currentDragState.currentY = Math.max(0, currentDragState.startY + deltaY);
			if (dragFrameRef.current !== null) return;
			dragFrameRef.current = window.requestAnimationFrame(() => {
				dragFrameRef.current = null;
				const latestDragState = dragStateRef.current;
				if (!latestDragState || latestDragState.nodeId !== node.id) return;
				latestDragState.element.style.left = `${latestDragState.currentX}px`;
				latestDragState.element.style.top = `${latestDragState.currentY}px`;
				for (const edge of edgeLines) {
					if (
						edge.fromId !== latestDragState.nodeId &&
						edge.toId !== latestDragState.nodeId
					) {
						continue;
					}
					edgePathRefs.current.get(edge.id)?.setAttribute(
						"d",
						buildEdgePath(edge, {
							nodeId: latestDragState.nodeId,
							x: latestDragState.currentX,
							y: latestDragState.currentY,
						})
					);
				}
			});
		};

		const finishNodeDrag = (finishEvent: PointerEvent) => {
			const currentDragState = dragStateRef.current;
			if (
				!currentDragState ||
				currentDragState.nodeId !== node.id ||
				finishEvent.pointerId !== currentDragState.pointerId
			) {
				return;
			}
			dragCleanupRef.current?.();
			if (dragFrameRef.current !== null) {
				window.cancelAnimationFrame(dragFrameRef.current);
				dragFrameRef.current = null;
			}
			if (element.hasPointerCapture(currentDragState.pointerId)) {
				element.releasePointerCapture(currentDragState.pointerId);
			}
			const nextFlows = updateNodePosition(
				currentDragState.nodeId,
				currentDragState.currentX,
				currentDragState.currentY
			);
			dragStateRef.current = null;
			setDragState(null);
			void sendJson(
				"/api/automations",
				{ flows: nextFlows },
				{ method: "PUT" }
			);
		};

		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", finishNodeDrag);
		window.addEventListener("pointercancel", finishNodeDrag);
		dragCleanupRef.current = () => {
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", finishNodeDrag);
			window.removeEventListener("pointercancel", finishNodeDrag);
			dragCleanupRef.current = null;
		};
	};

	return (
		<div {...stylex.props(styles.root)}>
			<section {...stylex.props(styles.leftPane)}>
				<div {...stylex.props(styles.header)}>
					<div {...stylex.props(styles.titleBlock)}>
						<span {...stylex.props(styles.kicker)}>Automations</span>
						<h1 {...stylex.props(styles.title)}>Markdown Orchestrator</h1>
					</div>
					<button
						type="button"
						onClick={() => void handleAddWorkflow()}
						title="New workflow"
						{...stylex.props(styles.iconAction)}
					>
						<IconPlus size={13} />
					</button>
				</div>

				<div {...stylex.props(styles.flowList)}>
					{flows.map((flow) => (
						<button
							key={flow.id}
							type="button"
							onClick={() => selectFlow(flow)}
							{...stylex.props(
								styles.flowCard,
								flow.id === selectedFlow.id && styles.flowCardSelected
							)}
						>
							<span {...stylex.props(styles.flowTitleRow)}>
								<span {...stylex.props(styles.flowName)}>{flow.name}</span>
								<AutomationStatusPill status={flow.status} />
							</span>
							<span {...stylex.props(styles.flowDescription)}>
								{flow.description}
							</span>
							<span {...stylex.props(styles.flowMeta)}>
								<span>
									<IconClock size={11} />
									{flow.nextRun}
								</span>
								<span>{flow.nodes.length} steps</span>
							</span>
						</button>
					))}
				</div>
			</section>

			<section {...stylex.props(styles.canvasPane)}>
				<div {...stylex.props(styles.canvasToolbar)}>
					<div {...stylex.props(styles.toolbarTitle)}>
						<IconWorkflow size={14} />
						<span>{selectedFlow.name}</span>
					</div>
					<span {...stylex.props(styles.scheduleText)}>
						{selectedFlow.schedule}
					</span>
					<span {...stylex.props(styles.spacer)} />
					<button
						type="button"
						onClick={() => setShowGrid(!showGrid)}
						{...stylex.props(styles.smallButton)}
					>
						Grid
					</button>
					<button
						type="button"
						onClick={handleRunOnce}
						{...stylex.props(styles.primaryButton)}
					>
						{runState?.flowId === selectedFlow.id && runState.isRunning
							? "Running"
							: "Run once"}
					</button>
				</div>

				<div
					{...stylex.props(styles.canvas, showGrid && styles.canvasGrid)}
					aria-label="Automation note canvas"
					role="region"
				>
					<svg
						{...stylex.props(styles.edgeLayer)}
						aria-hidden="true"
						width="980"
						height="520"
					>
						{edgeLines.map((edge) => (
							<path
								key={edge.id}
								ref={(element) => {
									if (element) edgePathRefs.current.set(edge.id, element);
									else edgePathRefs.current.delete(edge.id);
								}}
								d={buildEdgePath(edge)}
								{...stylex.props(styles.edge)}
							/>
						))}
					</svg>

					{selectedFlow.nodes.map((node) => {
						const nodeConfig = getNodeConfig(node.kind);
						const Icon = nodeConfig.icon;
						const isRunActive =
							runState?.flowId === selectedFlow.id &&
							runState.activeNodeId === node.id;
						const isRunComplete =
							runState?.flowId === selectedFlow.id &&
							runState.completedNodeIds.includes(node.id);
						return (
							<button
								key={node.id}
								type="button"
								onPointerDown={(event) => handleNodePointerDown(event, node)}
								{...stylex.props(
									styles.nodeCard,
									styles[`nodeTone${nodeConfig.tone}`],
									node.id === selectedNode.id && styles.nodeCardSelected,
									dragState?.nodeId === node.id && styles.nodeCardDragging,
									isRunActive && styles.nodeCardRunning,
									isRunComplete && styles.nodeCardComplete
								)}
								style={{ left: node.x, top: node.y }}
							>
								<span {...stylex.props(styles.nodeHeader)}>
									<span
										{...stylex.props(
											styles.nodeIcon,
											styles[`nodeIcon${nodeConfig.tone}`]
										)}
									>
										<Icon size={13} />
									</span>
									<span {...stylex.props(styles.nodeTitle)}>{node.title}</span>
								</span>
								<span {...stylex.props(styles.nodePorts)}>
									{nodeConfig.inputs.map((input) => (
										<span key={input} {...stylex.props(styles.nodeInputPort)}>
											<span {...stylex.props(styles.portDot)} />
											{input}
										</span>
									))}
									{nodeConfig.outputs.map((output) => (
										<span key={output} {...stylex.props(styles.nodeOutputPort)}>
											{isRunActive
												? "running"
												: isRunComplete
													? "complete"
													: output}
											<span {...stylex.props(styles.portDot)} />
										</span>
									))}
								</span>
							</button>
						);
					})}
					<div {...stylex.props(styles.nodePalette)}>
						<span {...stylex.props(styles.paletteLabel)}>Add</span>
						{paletteKinds.map((kind) => {
							const config = nodeKinds[kind];
							const Icon = config.icon;
							return (
								<button
									key={kind}
									type="button"
									onClick={() => handleAddNode(kind)}
									{...stylex.props(styles.paletteButton)}
								>
									<Icon size={12} />
									{config.label}
								</button>
							);
						})}
					</div>
				</div>
			</section>

			<aside {...stylex.props(styles.detailPane)}>
				<div {...stylex.props(styles.detailHeader)}>
					<span {...stylex.props(styles.kicker)}>Selected note</span>
					<h2 {...stylex.props(styles.detailTitle)}>{selectedNode.title}</h2>
					<p {...stylex.props(styles.detailDescription)}>
						{selectedNode.description}
					</p>
				</div>

				<div {...stylex.props(styles.detailSection)}>
					<div {...stylex.props(styles.panelHeader)}>
						<span>Step context</span>
						<button
							type="button"
							onClick={() => setIsPickingFolders(!isPickingFolders)}
							{...stylex.props(styles.linkButton)}
						>
							{isPickingFolders ? "Close" : "Choose repos"}
						</button>
					</div>
					<div {...stylex.props(styles.pathStack)}>
						<div {...stylex.props(styles.contextPath)}>
							<span {...stylex.props(styles.pathLabel)}>Primary</span>
							<span>{primaryPath}</span>
						</div>
						{referencePaths.map((path) => (
							<div key={path} {...stylex.props(styles.contextPath)}>
								<span {...stylex.props(styles.pathLabel)}>Additional</span>
								<span>{path}</span>
							</div>
						))}
					</div>
					{isPickingFolders && (
						<div {...stylex.props(styles.pickerWrap)}>
							<InlineDirectoryPicker
								multiSelect
								showStartButton={false}
								onSelect={(path) => {
									if (!path) return;
									void updateSelectedNodeContextPaths([path]);
									setIsPickingFolders(false);
								}}
								onSelectionChange={(setRecordEntry<string[]>).bind(
									null,
									setFolderSelections,
									selectedNode.id
								)}
								onMultiSelect={(paths) => {
									void updateSelectedNodeContextPaths(paths);
									setIsPickingFolders(false);
								}}
								onCancel={() => setIsPickingFolders(false)}
							/>
						</div>
					)}
				</div>

				<div {...stylex.props(styles.detailSection)}>
					<div {...stylex.props(styles.panelHeader)}>
						<span>Markdown file</span>
						<span {...stylex.props(styles.outputCount)}>
							{selectedNode.kind}
						</span>
					</div>
					<div {...stylex.props(styles.filePath)}>
						<IconFolder size={12} />
						{selectedNode.file}
					</div>
					<div {...stylex.props(styles.markdownCard)}>
						<span {...stylex.props(styles.markdownHeading)}>What it does</span>
						<textarea
							value={selectedNode.body}
							onChange={(event) => {
								void updateSelectedNodeBody(event.target.value);
							}}
							placeholder="Write the markdown instructions for this automation step..."
							{...stylex.props(styles.bodyEditor)}
						/>
					</div>
				</div>

				<div {...stylex.props(styles.detailSection)}>
					<div {...stylex.props(styles.panelHeader)}>
						<span>Step flow</span>
						<span {...stylex.props(styles.outputCount)}>
							{selectedNodeIndex + 1} of {selectedFlow.nodes.length}
						</span>
					</div>
					<div {...stylex.props(styles.flowPath)}>
						<div {...stylex.props(styles.flowPathGroup)}>
							<span {...stylex.props(styles.pathLabel)}>Receives from</span>
							{incomingNodes.length > 0 ? (
								incomingNodes.map((node) => (
									<span key={node.id} {...stylex.props(styles.flowPathNode)}>
										{node.title}
									</span>
								))
							) : (
								<span {...stylex.props(styles.emptyFlowPath)}>Start step</span>
							)}
						</div>
						<div {...stylex.props(styles.flowPathGroup)}>
							<span {...stylex.props(styles.pathLabel)}>Runs as</span>
							<span {...stylex.props(styles.flowPathNode)}>
								{selectedNode.kind === "agent"
									? "Inferay agent"
									: selectedNode.kind === "web"
										? "Web fetch"
										: selectedNode.kind === "script"
											? "Script"
											: "Markdown step"}
							</span>
						</div>
						<div {...stylex.props(styles.flowPathGroup)}>
							<span {...stylex.props(styles.pathLabel)}>Sends to</span>
							{outgoingNodes.length > 0 ? (
								outgoingNodes.map((node) => (
									<span key={node.id} {...stylex.props(styles.flowPathNode)}>
										{node.title}
									</span>
								))
							) : (
								<span {...stylex.props(styles.emptyFlowPath)}>
									Final output
								</span>
							)}
						</div>
					</div>
				</div>
			</aside>
		</div>
	);
}

function AutomationStatusPill({ status }: { status: AutomationStatus }) {
	const statusStyle =
		status === "scheduled"
			? styles.statusScheduled
			: status === "running"
				? styles.statusRunning
				: styles.statusReady;

	return (
		<span {...stylex.props(styles.statusPill, statusStyle)}>
			<span {...stylex.props(styles.statusDot)} />
			{statusLabel(status)}
		</span>
	);
}

const styles = stylex.create({
	root: {
		backgroundColor: color.background,
		color: color.textMain,
		display: "grid",
		gridTemplateColumns: "280px minmax(520px, 1fr) 300px",
		height: "100%",
		minWidth: 0,
		overflow: "hidden",
	},
	leftPane: {
		borderRightColor: color.border,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		display: "flex",
		flexDirection: "column",
		minHeight: 0,
		overflow: "hidden",
	},
	header: {
		alignItems: "center",
		borderBottomColor: color.border,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		gap: controlSize._3,
		paddingBlock: controlSize._3,
		paddingInline: controlSize._3,
	},
	titleBlock: {
		flex: 1,
		minWidth: 0,
	},
	kicker: {
		color: color.textMuted,
		display: "block",
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		textTransform: "uppercase",
	},
	title: {
		color: color.textMain,
		fontSize: font.size_5,
		fontWeight: font.weight_6,
		lineHeight: 1.25,
		margin: 0,
		marginTop: controlSize._0_5,
	},
	iconAction: {
		alignItems: "center",
		backgroundColor: {
			default: color.surfaceControl,
			":hover": color.surfaceControlHover,
		},
		borderColor: color.border,
		borderRadius: radius.md,
		borderStyle: "solid",
		borderWidth: 1,
		color: color.textSoft,
		display: "flex",
		height: controlSize._7,
		justifyContent: "center",
		width: controlSize._7,
	},
	flowList: {
		display: "flex",
		flexDirection: "column",
		gap: controlSize._2,
		overflowY: "auto",
		padding: controlSize._3,
	},
	flowCard: {
		backgroundColor: {
			default: color.surfaceTranslucent,
			":hover": color.surfaceControl,
		},
		borderColor: color.border,
		borderRadius: radius.lg,
		borderStyle: "solid",
		borderWidth: 1,
		display: "flex",
		flexDirection: "column",
		gap: controlSize._2,
		padding: controlSize._3,
		textAlign: "left",
		transitionDuration: motion.durationBase,
		transitionProperty: "background-color, border-color, box-shadow",
		transitionTimingFunction: motion.ease,
	},
	flowCardSelected: {
		backgroundColor: color.controlActive,
		borderColor: color.borderStrong,
		boxShadow: shadow.selectedRing,
	},
	flowTitleRow: {
		alignItems: "center",
		display: "flex",
		gap: controlSize._2,
		justifyContent: "space-between",
	},
	flowName: {
		color: color.textMain,
		fontSize: font.size_3,
		fontWeight: font.weight_6,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	flowDescription: {
		color: color.textMuted,
		fontSize: font.size_2,
		lineHeight: 1.4,
	},
	flowMeta: {
		alignItems: "center",
		color: color.textFaint,
		display: "flex",
		fontSize: font.size_1,
		gap: controlSize._2,
		justifyContent: "space-between",
	},
	panelHeader: {
		alignItems: "center",
		color: color.textMuted,
		display: "flex",
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		justifyContent: "space-between",
		textTransform: "uppercase",
	},
	linkButton: {
		backgroundColor: "transparent",
		color: {
			default: color.textSoft,
			":hover": color.textMain,
		},
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		textTransform: "none",
	},
	outputCount: {
		color: color.textFaint,
		fontFamily: font.familyMono,
		fontSize: font.size_1,
		textTransform: "none",
	},
	canvasPane: {
		display: "flex",
		flexDirection: "column",
		minHeight: 0,
		minWidth: 0,
		overflow: "hidden",
	},
	canvasToolbar: {
		alignItems: "center",
		borderBottomColor: color.border,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		gap: controlSize._2,
		height: controlSize._10,
		paddingInline: controlSize._3,
	},
	toolbarTitle: {
		alignItems: "center",
		color: color.textMain,
		display: "flex",
		fontSize: font.size_3,
		fontWeight: font.weight_6,
		gap: controlSize._2,
	},
	scheduleText: {
		color: color.textMuted,
		fontFamily: font.familyMono,
		fontSize: font.size_1,
	},
	spacer: {
		flex: 1,
	},
	smallButton: {
		backgroundColor: {
			default: color.surfaceControl,
			":hover": color.surfaceControlHover,
		},
		borderColor: color.border,
		borderRadius: radius.md,
		borderStyle: "solid",
		borderWidth: 1,
		color: color.textSoft,
		fontSize: font.size_1,
		height: controlSize._6,
		paddingInline: controlSize._2,
	},
	primaryButton: {
		backgroundColor: {
			default: color.textMain,
			":hover": color.textSoft,
		},
		borderRadius: radius.md,
		color: color.background,
		fontSize: font.size_1,
		fontWeight: font.weight_6,
		height: controlSize._6,
		paddingInline: controlSize._3,
	},
	canvas: {
		backgroundColor: "#050505",
		flex: 1,
		minHeight: 0,
		overflow: "auto",
		position: "relative",
	},
	canvasGrid: {
		backgroundImage:
			"radial-gradient(circle at 1px 1px, rgba(255,255,255,0.055) 1px, transparent 0)",
		backgroundSize: "32px 32px",
	},
	edgeLayer: {
		height: 520,
		left: 0,
		pointerEvents: "none",
		position: "absolute",
		top: 0,
		width: 980,
	},
	edge: {
		fill: "none",
		stroke: color.borderControl,
		strokeWidth: 1.5,
	},
	nodeCard: {
		backgroundColor: {
			default: "rgba(12, 12, 14, 0.94)",
			":hover": "rgba(18, 18, 20, 0.96)",
		},
		borderColor: color.border,
		borderRadius: radius.lg,
		borderStyle: "solid",
		borderWidth: 1,
		boxShadow: shadow.popover,
		cursor: "grab",
		display: "flex",
		flexDirection: "column",
		minHeight: 78,
		padding: 0,
		position: "absolute",
		textAlign: "left",
		touchAction: "none",
		transitionDuration: motion.durationBase,
		transitionProperty: "background-color, border-color, transform",
		transitionTimingFunction: motion.ease,
		userSelect: "none",
		width: 140,
	},
	nodeToneemerald: {
		backgroundColor:
			"color-mix(in srgb, var(--color-inferay-success) 5%, #050505)",
		borderColor: color.successBorder,
	},
	nodeToneblue: {
		backgroundColor: "color-mix(in srgb, #3b82f6 7%, #050505)",
		borderColor: "rgba(59, 130, 246, 0.5)",
	},
	nodeTonepurple: {
		backgroundColor: "color-mix(in srgb, #a855f7 8%, #050505)",
		borderColor: "rgba(168, 85, 247, 0.5)",
	},
	nodeTonepink: {
		backgroundColor: "color-mix(in srgb, #ec4899 8%, #050505)",
		borderColor: "rgba(236, 72, 153, 0.5)",
	},
	nodeToneamber: {
		backgroundColor: "color-mix(in srgb, #f59e0b 7%, #050505)",
		borderColor: "rgba(245, 158, 11, 0.5)",
	},
	nodeToneorange: {
		backgroundColor: "color-mix(in srgb, #f97316 7%, #050505)",
		borderColor: "rgba(249, 115, 22, 0.5)",
	},
	nodeTonecyan: {
		backgroundColor: "color-mix(in srgb, #06b6d4 7%, #050505)",
		borderColor: "rgba(6, 182, 212, 0.55)",
	},
	nodeCardSelected: {
		borderColor: color.focusRing,
		boxShadow: shadow.focusRing,
	},
	nodeCardDragging: {
		borderColor: color.textSoft,
		cursor: "grabbing",
		zIndex: 2,
	},
	nodeCardRunning: {
		borderColor: color.warningBorder,
		boxShadow: shadow.focusRing,
	},
	nodeCardComplete: {
		borderColor: color.successBorder,
	},
	nodeHeader: {
		alignItems: "center",
		borderBottomColor: color.borderSubtle,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		gap: controlSize._1_5,
		minWidth: 0,
		paddingBlock: controlSize._1_5,
		paddingInline: controlSize._2,
	},
	nodeIcon: {
		alignItems: "center",
		borderRadius: radius.sm,
		color: color.textMain,
		display: "flex",
		flexShrink: 0,
		height: controlSize._4,
		justifyContent: "center",
		width: controlSize._4,
	},
	nodeIconemerald: {
		backgroundColor: color.success,
	},
	nodeIconblue: {
		backgroundColor: "#3b82f6",
	},
	nodeIconpurple: {
		backgroundColor: "#a855f7",
	},
	nodeIconpink: {
		backgroundColor: "#ec4899",
	},
	nodeIconamber: {
		backgroundColor: "#f59e0b",
	},
	nodeIconorange: {
		backgroundColor: "#f97316",
	},
	nodeIconcyan: {
		backgroundColor: "#06b6d4",
	},
	nodeTitle: {
		color: color.textMain,
		fontSize: font.size_1,
		fontWeight: font.weight_6,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	nodePorts: {
		display: "flex",
		flexDirection: "column",
		gap: controlSize._1,
		paddingBlock: controlSize._1_5,
		paddingInline: controlSize._2,
	},
	nodeInputPort: {
		alignItems: "center",
		color: color.textMuted,
		display: "flex",
		fontSize: font.size_1,
		gap: controlSize._1,
		marginLeft: "-0.875rem",
	},
	nodeOutputPort: {
		alignItems: "center",
		color: color.textMuted,
		display: "flex",
		fontSize: font.size_1,
		gap: controlSize._1,
		justifyContent: "flex-end",
		marginRight: "-0.875rem",
	},
	portDot: {
		backgroundColor: color.background,
		borderColor: color.borderControl,
		borderRadius: radius.pill,
		borderStyle: "solid",
		borderWidth: 2,
		display: "inline-flex",
		height: controlSize._2,
		width: controlSize._2,
	},
	nodePalette: {
		alignItems: "center",
		backdropFilter: "blur(12px)",
		backgroundColor: "rgba(5, 5, 5, 0.92)",
		borderTopColor: color.border,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		bottom: 0,
		display: "flex",
		gap: controlSize._1,
		left: 0,
		paddingBlock: controlSize._2,
		paddingInline: controlSize._3,
		position: "absolute",
		right: 0,
		zIndex: 3,
	},
	paletteLabel: {
		color: color.textMuted,
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		marginRight: controlSize._2,
		textTransform: "uppercase",
	},
	paletteButton: {
		alignItems: "center",
		backgroundColor: {
			default: color.surfaceInset,
			":hover": color.surfaceControl,
		},
		borderColor: color.border,
		borderRadius: radius.md,
		borderStyle: "solid",
		borderWidth: 1,
		color: color.textSoft,
		display: "flex",
		fontSize: font.size_1,
		gap: controlSize._1_5,
		height: controlSize._7,
		paddingInline: controlSize._2,
	},
	detailPane: {
		borderLeftColor: color.border,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		display: "flex",
		flexDirection: "column",
		minHeight: 0,
		overflow: "auto",
	},
	detailHeader: {
		borderBottomColor: color.border,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		padding: controlSize._3,
	},
	detailTitle: {
		color: color.textMain,
		fontSize: font.size_5,
		fontWeight: font.weight_6,
		lineHeight: 1.25,
		margin: 0,
		marginTop: controlSize._1,
	},
	detailDescription: {
		color: color.textMuted,
		fontSize: font.size_2,
		lineHeight: 1.45,
		margin: 0,
		marginTop: controlSize._2,
	},
	detailSection: {
		borderBottomColor: color.border,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		flexDirection: "column",
		gap: controlSize._2,
		padding: controlSize._3,
	},
	pathStack: {
		display: "flex",
		flexDirection: "column",
		gap: controlSize._1,
	},
	contextPath: {
		backgroundColor: color.surfaceInset,
		borderColor: color.borderSubtle,
		borderRadius: radius.md,
		borderStyle: "solid",
		borderWidth: 1,
		color: color.textSoft,
		display: "flex",
		flexDirection: "column",
		fontFamily: font.familyMono,
		fontSize: font.size_1,
		gap: controlSize._0_5,
		minWidth: 0,
		overflow: "hidden",
		paddingBlock: controlSize._1_5,
		paddingInline: controlSize._2,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	pathLabel: {
		color: color.textFaint,
		fontFamily: "inherit",
		fontSize: font.size_0_5,
		textTransform: "uppercase",
	},
	pickerWrap: {
		backgroundColor: color.surfaceTranslucent,
		borderColor: color.border,
		borderRadius: radius.lg,
		borderStyle: "solid",
		borderWidth: 1,
		maxHeight: 320,
		overflow: "auto",
		padding: controlSize._2,
	},
	filePath: {
		alignItems: "center",
		backgroundColor: color.surfaceInset,
		borderColor: color.borderSubtle,
		borderRadius: radius.md,
		borderStyle: "solid",
		borderWidth: 1,
		color: color.textSoft,
		display: "flex",
		fontFamily: font.familyMono,
		fontSize: font.size_1,
		gap: controlSize._2,
		padding: controlSize._2,
	},
	markdownCard: {
		backgroundColor: color.surfaceTranslucent,
		borderColor: color.border,
		borderRadius: radius.lg,
		borderStyle: "solid",
		borderWidth: 1,
		color: color.textMuted,
		fontSize: font.size_2,
		lineHeight: 1.5,
		padding: controlSize._3,
	},
	markdownHeading: {
		color: color.textMain,
		display: "block",
		fontSize: font.size_1,
		fontWeight: font.weight_6,
		marginBottom: controlSize._1,
		textTransform: "uppercase",
	},
	bodyEditor: {
		backgroundColor: color.surfaceInset,
		borderColor: color.borderSubtle,
		borderRadius: radius.md,
		borderStyle: "solid",
		borderWidth: 1,
		color: color.textMain,
		fontFamily: font.familyMono,
		fontSize: font.size_2,
		lineHeight: 1.5,
		minHeight: 148,
		outline: {
			default: "none",
			":focus": "none",
		},
		padding: controlSize._2,
		resize: "vertical",
		width: "100%",
	},
	flowPath: {
		display: "flex",
		flexDirection: "column",
		gap: controlSize._2,
	},
	flowPathGroup: {
		backgroundColor: color.surfaceInset,
		borderColor: color.borderSubtle,
		borderRadius: radius.md,
		borderStyle: "solid",
		borderWidth: 1,
		display: "flex",
		flexDirection: "column",
		gap: controlSize._1,
		padding: controlSize._2,
	},
	flowPathNode: {
		color: color.textMain,
		fontSize: font.size_2,
		fontWeight: font.weight_5,
		lineHeight: 1.35,
	},
	emptyFlowPath: {
		color: color.textFaint,
		fontSize: font.size_2,
		lineHeight: 1.35,
	},
	statusPill: {
		alignItems: "center",
		borderRadius: radius.pill,
		borderStyle: "solid",
		borderWidth: 1,
		display: "inline-flex",
		flexShrink: 0,
		fontSize: font.size_1,
		fontWeight: font.weight_5,
		gap: controlSize._1,
		paddingBlock: controlSize._0_5,
		paddingInline: controlSize._2,
	},
	statusDot: {
		backgroundColor: "currentColor",
		borderRadius: radius.pill,
		height: controlSize._1,
		width: controlSize._1,
	},
	statusScheduled: {
		backgroundColor: color.warningWash,
		borderColor: color.warningBorder,
		color: color.warning,
	},
	statusRunning: {
		backgroundColor: color.accentWash,
		borderColor: color.accentBorder,
		color: color.accent,
	},
	statusReady: {
		backgroundColor: color.surfaceControl,
		borderColor: color.border,
		color: color.textMuted,
	},
});
