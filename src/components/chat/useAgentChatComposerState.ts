import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AttachedImageInfo,
	QueuedMessageInfo,
} from "../../features/chat/agent-chat-shared.ts";
import {
	loadFileBackedQueue,
	loadStoredQueue,
	saveStoredQueue,
} from "../../features/chat/chat-session-store.ts";
import { CHAT_QUEUE_KEY_PREFIX } from "../../lib/client-storage-keys.ts";
import { CLIENT_STORAGE_CHANGED_EVENT } from "../../lib/client-storage-sync.ts";
import { hasPath, lacksId } from "../../lib/data.ts";
import { listenWindowEvent } from "../../lib/react-events.ts";
import { wsClient } from "../../lib/websocket.ts";

interface MarkdownPreviewState {
	show: boolean;
	path: string;
	content: string | null;
	loading: boolean;
	error: string | null;
}

type FilePreviewMessage =
	| { type: "file:content"; content: string }
	| { type: "file:error"; error?: string };

let queueIdCounter = 0;

function nextQueueId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now()}-${++queueIdCounter}`;
}

function isFilePreviewMessage(msg: unknown): msg is FilePreviewMessage {
	if (!msg || typeof msg !== "object") return false;
	const type = (msg as { type?: unknown }).type;
	if (type === "file:content") {
		return typeof (msg as { content?: unknown }).content === "string";
	}
	return (
		type === "file:error" &&
		((msg as { error?: unknown }).error === undefined ||
			typeof (msg as { error?: unknown }).error === "string")
	);
}

function areQueuedMessagesEqual(
	prev: QueuedMessageInfo[],
	next: QueuedMessageInfo[]
) {
	if (prev.length !== next.length) return false;
	for (let i = 0; i < prev.length; i++) {
		const a = prev[i]!;
		const b = next[i]!;
		if (
			a.id !== b.id ||
			a.text !== b.text ||
			a.displayText !== b.displayText ||
			(a.images?.length ?? 0) !== (b.images?.length ?? 0)
		) {
			return false;
		}
		const imagesA = a.images ?? [];
		const imagesB = b.images ?? [];
		for (let j = 0; j < imagesA.length; j++) {
			if (imagesA[j] !== imagesB[j]) return false;
		}
	}
	return true;
}

function parseQueuedMessages(
	value: string | null | undefined
): QueuedMessageInfo[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as QueuedMessageInfo[]) : [];
	} catch {
		return [];
	}
}

export function useAgentChatComposerState(paneId: string, enabled = true) {
	const [isDragOver, setIsDragOver] = useState(false);
	const [attachedImages, setAttachedImages] = useState<AttachedImageInfo[]>([]);
	const attachedImagesRef = useRef(attachedImages);
	attachedImagesRef.current = attachedImages;
	const queueRef = useRef<QueuedMessageInfo[]>(
		loadStoredQueue<QueuedMessageInfo>(paneId)
	);
	const queueRevisionRef = useRef(0);
	const [queuedMessages, setQueuedMessagesState] = useState<
		QueuedMessageInfo[]
	>(() => queueRef.current);
	const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
	const [editingQueueText, setEditingQueueText] = useState("");
	const [mdPreview, setMdPreview] = useState<MarkdownPreviewState>({
		show: false,
		path: "",
		content: null,
		loading: false,
		error: null,
	});

	const handleMdFileClick = useCallback((filePath: string) => {
		setMdPreview({
			show: true,
			path: filePath,
			content: null,
			loading: true,
			error: null,
		});
		wsClient.send({ type: "file:read", path: filePath });
	}, []);

	useEffect(() => {
		if (!enabled) return;
		let active = true;
		const next = loadStoredQueue<QueuedMessageInfo>(paneId);
		const shouldApplyStoredQueue =
			queueRef.current.length === 0 ||
			next.length > 0 ||
			areQueuedMessagesEqual(queueRef.current, next);
		if (shouldApplyStoredQueue) {
			queueRef.current = next;
			setQueuedMessagesState(next);
		}
		const revisionAtLoad = queueRevisionRef.current;
		void loadFileBackedQueue<QueuedMessageInfo>(paneId).then(
			(fileBackedQueue) => {
				if (!active || fileBackedQueue === null) return;
				if (queueRevisionRef.current !== revisionAtLoad) return;
				if (areQueuedMessagesEqual(queueRef.current, fileBackedQueue)) return;
				queueRevisionRef.current++;
				queueRef.current = fileBackedQueue;
				setQueuedMessagesState(fileBackedQueue);
				saveStoredQueue(paneId, fileBackedQueue);
			}
		);
		return () => {
			active = false;
		};
	}, [enabled, paneId]);

	useEffect(() => {
		if (!enabled || !mdPreview.loading) return;
		const handleMessage = (msg: unknown) => {
			if (!isFilePreviewMessage(msg)) return;
			if (msg.type === "file:content") {
				setMdPreview((prev) => ({
					...prev,
					content: msg.content,
					loading: false,
				}));
			} else if (msg.type === "file:error") {
				setMdPreview((prev) => ({
					...prev,
					error: msg.error || "Failed to read file",
					loading: false,
				}));
			}
		};
		return wsClient.onMessage(handleMessage);
	}, [enabled, mdPreview.loading]);

	const setQueuedMessages = useCallback(
		(messages: QueuedMessageInfo[]) => {
			if (areQueuedMessagesEqual(queueRef.current, messages)) return;
			queueRevisionRef.current++;
			queueRef.current = messages;
			setQueuedMessagesState(messages);
			saveStoredQueue(paneId, messages);
		},
		[paneId]
	);

	useEffect(() => {
		if (!enabled) return;
		return listenWindowEvent(CLIENT_STORAGE_CHANGED_EVENT, (event) => {
			const detail = (
				event as CustomEvent<{ key?: string; value?: string | null }>
			).detail;
			if (detail?.key !== `${CHAT_QUEUE_KEY_PREFIX}${paneId}`) return;
			const next = parseQueuedMessages(detail.value);
			if (areQueuedMessagesEqual(queueRef.current, next)) return;
			queueRevisionRef.current++;
			queueRef.current = next;
			setQueuedMessagesState(next);
		});
	}, [enabled, paneId]);

	const queueMessage = useCallback(
		(text: string, displayText: string, images?: string[]) => {
			setQueuedMessages([
				...queueRef.current,
				{
					id: nextQueueId(),
					text,
					displayText,
					images: images?.length ? images : undefined,
				},
			]);
		},
		[setQueuedMessages]
	);

	const shiftQueuedMessage = useCallback(() => {
		const [next = null, ...rest] = queueRef.current;
		setQueuedMessages(rest);
		return next;
	}, [setQueuedMessages]);

	const removeQueuedMessage = useCallback(
		(id: string) => {
			if (!queueRef.current.some((item) => item.id === id)) return;
			setQueuedMessages(queueRef.current.filter(lacksId.bind(null, id)));
			if (editingQueueId === id) {
				setEditingQueueId(null);
				setEditingQueueText("");
			}
		},
		[editingQueueId, setQueuedMessages]
	);

	const updateQueuedMessage = useCallback(
		(id: string, text: string) => {
			const existing = queueRef.current.find((item) => item.id === id);
			if (!existing || existing.text === text) return;
			setQueuedMessages(
				queueRef.current.map((item) =>
					item.id === id ? { ...item, text, displayText: text } : item
				)
			);
		},
		[setQueuedMessages]
	);

	const startQueuedMessageEdit = useCallback((id: string, text: string) => {
		setEditingQueueId(id);
		setEditingQueueText(text);
	}, []);

	const cancelQueuedMessageEdit = useCallback(() => {
		setEditingQueueId(null);
		setEditingQueueText("");
	}, []);

	const saveQueuedMessageEdit = useCallback(
		(id: string) => {
			const trimmed = editingQueueText.trim();
			if (trimmed) updateQueuedMessage(id, trimmed);
			cancelQueuedMessageEdit();
		},
		[cancelQueuedMessageEdit, editingQueueText, updateQueuedMessage]
	);

	const attachImage = useCallback(async (file: File) => {
		try {
			const fd = new FormData();
			fd.append("file", file);
			const res = await fetch("/api/upload-temp", {
				method: "POST",
				body: fd,
			});
			const data = await res.json();
			if (data.path) {
				const previewUrl = URL.createObjectURL(file);
				setAttachedImages((prev) => [
					...prev,
					{ name: file.name, path: data.path, previewUrl },
				]);
			}
		} catch {}
	}, []);

	const removeAttachedImage = useCallback((path: string) => {
		setAttachedImages((prev) => {
			const target = prev.find(hasPath.bind(null, path));
			if (!target) return prev;
			URL.revokeObjectURL(target.previewUrl);
			return prev.filter((item) => item.path !== path);
		});
	}, []);

	const clearAttachedImages = useCallback(() => {
		setAttachedImages((prev) => {
			if (prev.length === 0) return prev;
			for (const img of prev) URL.revokeObjectURL(img.previewUrl);
			return [];
		});
	}, []);

	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			for (const file of Array.from(e.dataTransfer.files)) {
				if (file.type.startsWith("image/")) await attachImage(file);
			}
		},
		[attachImage]
	);

	const handlePaste = useCallback(
		async (e: React.ClipboardEvent) => {
			for (const item of Array.from(e.clipboardData.items)) {
				if (item.type.startsWith("image/")) {
					e.preventDefault();
					const file = item.getAsFile();
					if (file) await attachImage(file);
					return;
				}
			}
		},
		[attachImage]
	);

	useEffect(
		() => () => {
			for (const img of attachedImagesRef.current) {
				URL.revokeObjectURL(img.previewUrl);
			}
		},
		[]
	);

	return {
		isDragOver,
		setIsDragOver,
		attachedImages,
		queuedMessages,
		queueMessage,
		shiftQueuedMessage,
		removeQueuedMessage,
		updateQueuedMessage,
		editingQueueId,
		editingQueueText,
		setEditingQueueText,
		startQueuedMessageEdit,
		cancelQueuedMessageEdit,
		saveQueuedMessageEdit,
		mdPreview,
		setMdPreview,
		handleMdFileClick,
		attachImage,
		removeAttachedImage,
		clearAttachedImages,
		handleDrop,
		handlePaste,
	};
}
