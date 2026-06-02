import { useCallback } from "react";
import { useAsyncResource } from "../../hooks/useAsyncResource";

export interface GitCommit {
	hash: string;
	message: string;
	author: string;
	authorEmail: string;
	authorAvatarUrl: string;
	date: string;
	parents: string[];
	refs: string[];
}

export interface GraphNode extends GitCommit {
	column: number;
	color: string;
}

export interface GraphRail {
	column: number;
	color: string;
}

export interface GraphTransition {
	fromColumn: number;
	toColumn: number;
	color: string;
}

export interface GraphRow {
	row: number;
	rails: GraphRail[];
	transitions: GraphTransition[];
}

interface GraphData {
	commits: GraphNode[];
	rows: GraphRow[];
}

const EMPTY_GRAPH: GraphData = { commits: [], rows: [] };

export function useGitGraph(cwd: string | undefined, limit = 50) {
	const fetchGraph = useCallback(() => {
		if (!cwd) return null;
		return (async () => {
			const res = await fetch(
				`/api/git/graph?cwd=${encodeURIComponent(cwd)}&limit=${limit}`
			);
			if (!res.ok) throw new Error("Failed to fetch git graph");
			const json = await res.json();
			return {
				commits: (json.commits || []) as GraphNode[],
				rows: (json.rows || []) as GraphRow[],
			};
		})();
	}, [cwd, limit]);
	const { data, loading, error, refresh } = useAsyncResource<GraphData>(
		fetchGraph,
		EMPTY_GRAPH
	);
	return { commits: data.commits, rows: data.rows, loading, error, refresh };
}

interface CommitFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
}

interface CommitDetails {
	hash: string;
	message: string;
	author: string;
	date: string;
	files: CommitFile[];
}

export function useCommitDetails(
	cwd: string | undefined,
	hash: string | undefined
) {
	const fetchCommitDetails = useCallback(() => {
		if (!cwd || !hash) return null;
		return (async () => {
			const res = await fetch(
				`/api/git/commit-details?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`
			);
			if (!res.ok) throw new Error("Failed to fetch commit details");
			const json = await res.json();
			return (json.details || null) as CommitDetails | null;
		})();
	}, [cwd, hash]);
	const { data, loading, error, refresh } =
		useAsyncResource<CommitDetails | null>(fetchCommitDetails, null);
	return { details: data, loading, error, refresh };
}
