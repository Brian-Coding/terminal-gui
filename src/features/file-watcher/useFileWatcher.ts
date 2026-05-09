import { useEffect, useRef } from "react";
import type { DiffRequest } from "../../features/git/useGitDiff.ts";
import { sendJson } from "../../lib/fetch-json.ts";
import { wsClient } from "../../lib/websocket.ts";

interface UseFileWatcherOptions {
	enabled: boolean;
	cwd: string | undefined;
	paneId: string | undefined;
	currentFile: string | undefined;
	loadDiff: (req: DiffRequest) => void;
	setSelectedFile: (path: string, staged: boolean) => void;
	onDiffLoaded: () => void;
}

export function useFileWatcher({
	enabled,
	cwd,
	paneId,
	currentFile,
	loadDiff,
	setSelectedFile,
	onDiffLoaded,
}: UseFileWatcherOptions) {
	const pendingScrollRef = useRef(false);
	const enabledRef = useRef(enabled);
	const cwdRef = useRef(cwd);
	const currentFileRef = useRef(currentFile);
	const loadDiffRef = useRef(loadDiff);
	const setSelectedFileRef = useRef(setSelectedFile);

	enabledRef.current = enabled;
	cwdRef.current = cwd;
	currentFileRef.current = currentFile;
	loadDiffRef.current = loadDiff;
	setSelectedFileRef.current = setSelectedFile;

	useEffect(() => {
		if (!enabled || !cwd) return;

		void sendJson("/api/git/watch", { cwd }, { method: "POST" });

		return () => {
			void sendJson("/api/git/unwatch", { cwd }, { method: "POST" });
		};
	}, [enabled, cwd]);

	useEffect(() => {
		if (!cwd || !paneId) return;

		const handleMessage = (msg: {
			type: string;
			cwd?: string;
			file?: string;
		}) => {
			if (!enabledRef.current) return;
			if (
				msg.type !== "file:changed" ||
				msg.cwd !== cwdRef.current ||
				!msg.file
			)
				return;

			setTimeout(() => {
				if (!enabledRef.current || !cwdRef.current) return;
				const changedFile = msg.file!;
				pendingScrollRef.current = true;
				loadDiffRef.current({
					cwd: cwdRef.current,
					file: changedFile,
					staged: false,
				});
				if (currentFileRef.current !== changedFile) {
					setSelectedFileRef.current(changedFile, false);
				}
			}, 400);
		};

		return wsClient.onMessage(handleMessage as (msg: unknown) => void);
	}, [cwd, paneId]);

	return {
		pendingScrollRef,
		checkPendingScroll: () => {
			if (pendingScrollRef.current) {
				pendingScrollRef.current = false;
				onDiffLoaded();
			}
		},
	};
}
