import { useCallback, useRef } from "react";
import type { DiffCacheEntry, ParsedDiff } from "../services/diff-worker";

async function computeDiffViaNative(
	before: string,
	after: string
): Promise<ParsedDiff> {
	const response = await fetch("/api/native/diff", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ before, after }),
	});

	const result = (await response.json()) as {
		ok?: boolean;
		diff?: ParsedDiff;
		error?: string;
	};

	if (!response.ok || !result.ok || !result.diff) {
		throw new Error(result.error || "Native diff request failed");
	}

	return result.diff;
}

export interface UseDiffCacheOptions {
	chatId: string;
}

export interface DiffCacheAPI {
	computeDiff: (
		filePath: string,
		before: string,
		after: string
	) => Promise<ParsedDiff>;
	getCachedDiff: (filePath: string) => Promise<DiffCacheEntry | null>;
	getCachedDiffSync: (filePath: string) => DiffCacheEntry | null;
	clearCache: () => void;
	hasCachedDiff: (filePath: string) => boolean;
}

export function useDiffCache({
	chatId: _chatId,
}: UseDiffCacheOptions): DiffCacheAPI {
	const localCacheRef = useRef<Map<string, DiffCacheEntry>>(new Map());

	const computeDiff = useCallback(
		async (
			filePath: string,
			before: string,
			after: string
		): Promise<ParsedDiff> => {
			const nativeDiff = await computeDiffViaNative(before, after);
			localCacheRef.current.set(filePath, {
				before,
				after,
				filePath,
				parsedDiff: nativeDiff,
			});
			return nativeDiff;
		},
		[]
	);

	const getCachedDiff = useCallback(
		async (filePath: string): Promise<DiffCacheEntry | null> => {
			return localCacheRef.current.get(filePath) ?? null;
		},
		[]
	);

	const getCachedDiffSync = useCallback(
		(filePath: string): DiffCacheEntry | null => {
			return localCacheRef.current.get(filePath) ?? null;
		},
		[]
	);

	const clearCache = useCallback(() => {
		localCacheRef.current.clear();
	}, []);

	const hasCachedDiff = useCallback((filePath: string): boolean => {
		return localCacheRef.current.has(filePath);
	}, []);

	return {
		computeDiff,
		getCachedDiff,
		getCachedDiffSync,
		clearCache,
		hasCachedDiff,
	};
}
