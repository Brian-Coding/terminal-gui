import { useCallback, useEffect, useState } from "react";

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

export function useGitGraph(cwd: string | undefined, limit = 50) {
	const [commits, setCommits] = useState<GraphNode[]>([]);
	const [rows, setRows] = useState<GraphRow[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchGraph = useCallback(async () => {
		if (!cwd) {
			setCommits([]);
			setRows([]);
			return;
		}

		setLoading(true);
		setError(null);

		try {
			const res = await fetch(
				`/api/git/graph?cwd=${encodeURIComponent(cwd)}&limit=${limit}`
			);
			if (!res.ok) {
				throw new Error("Failed to fetch git graph");
			}
			const data = await res.json();
			setCommits((data.commits || []) as GraphNode[]);
			setRows((data.rows || []) as GraphRow[]);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			setCommits([]);
			setRows([]);
		} finally {
			setLoading(false);
		}
	}, [cwd, limit]);

	useEffect(() => {
		fetchGraph();
	}, [fetchGraph]);

	return { commits, rows, loading, error, refresh: fetchGraph };
}

export interface CommitFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
}

export interface CommitDetails {
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
	const [details, setDetails] = useState<CommitDetails | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchDetails = useCallback(async () => {
		if (!cwd || !hash) {
			setDetails(null);
			return;
		}

		setLoading(true);
		setError(null);

		try {
			const res = await fetch(
				`/api/git/commit-details?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`
			);
			if (!res.ok) {
				throw new Error("Failed to fetch commit details");
			}
			const data = await res.json();
			setDetails(data.details || null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			setDetails(null);
		} finally {
			setLoading(false);
		}
	}, [cwd, hash]);

	useEffect(() => {
		fetchDetails();
	}, [fetchDetails]);

	return { details, loading, error, refresh: fetchDetails };
}
