import { useCallback, useEffect, useState } from "react";

export interface GitCommit {
	hash: string;
	message: string;
	author: string;
	date: string;
	parents: string[];
	refs: string[];
}

export interface GraphNode extends GitCommit {
	column: number;
	color: string;
}

// Colors for different branches in the graph
const BRANCH_COLORS = [
	"#f97316", // orange-500
	"#22c55e", // green-500
	"#3b82f6", // blue-500
	"#a855f7", // purple-500
	"#ec4899", // pink-500
	"#14b8a6", // teal-500
	"#eab308", // yellow-500
	"#ef4444", // red-500
];

function assignColumns(commits: GitCommit[]): GraphNode[] {
	if (!commits.length) return [];

	// Map hash -> commit for quick lookup
	const hashToCommit = new Map<string, GitCommit>();
	for (const c of commits) hashToCommit.set(c.hash, c);

	// Track which column each commit occupies
	const hashToColumn = new Map<string, number>();
	const hashToColor = new Map<string, string>();
	const activeColumns: (string | null)[] = []; // which hash is using each column

	const result: GraphNode[] = [];

	for (const commit of commits) {
		let column = -1;
		let color = BRANCH_COLORS[0]!;

		// Check if any parent already assigned a column to this commit
		// This happens when we're continuing an existing branch
		for (let i = 0; i < activeColumns.length; i++) {
			if (activeColumns[i] === commit.hash) {
				column = i;
				color =
					hashToColor.get(commit.hash) ||
					BRANCH_COLORS[i % BRANCH_COLORS.length]!;
				break;
			}
		}

		// If not already assigned, find a free column
		if (column === -1) {
			for (let i = 0; i < activeColumns.length; i++) {
				if (activeColumns[i] === null) {
					column = i;
					break;
				}
			}
			if (column === -1) {
				column = activeColumns.length;
				activeColumns.push(null);
			}
			color = BRANCH_COLORS[column % BRANCH_COLORS.length]!;
		}

		hashToColumn.set(commit.hash, column);
		hashToColor.set(commit.hash, color);

		// Clear this commit's slot
		activeColumns[column] = null;

		// Assign columns to parents
		const parents = commit.parents;
		if (parents.length > 0) {
			// First parent continues in same column
			const firstParent = parents[0]!;
			if (!hashToColumn.has(firstParent)) {
				activeColumns[column] = firstParent;
				hashToColor.set(firstParent, color);
			}

			// Additional parents (merge commits) get new columns
			for (let i = 1; i < parents.length; i++) {
				const parent = parents[i]!;
				if (hashToColumn.has(parent)) continue;

				// Find a free column for this parent
				let parentCol = -1;
				for (let j = 0; j < activeColumns.length; j++) {
					if (activeColumns[j] === null) {
						parentCol = j;
						break;
					}
				}
				if (parentCol === -1) {
					parentCol = activeColumns.length;
					activeColumns.push(null);
				}
				activeColumns[parentCol] = parent;
				hashToColor.set(
					parent,
					BRANCH_COLORS[parentCol % BRANCH_COLORS.length]!
				);
			}
		}

		result.push({
			...commit,
			column,
			color,
		});
	}

	return result;
}

export function useGitGraph(cwd: string | undefined, limit = 50) {
	const [commits, setCommits] = useState<GraphNode[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchGraph = useCallback(async () => {
		if (!cwd) {
			setCommits([]);
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
			const nodes = assignColumns(data.commits || []);
			setCommits(nodes);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			setCommits([]);
		} finally {
			setLoading(false);
		}
	}, [cwd, limit]);

	useEffect(() => {
		fetchGraph();
	}, [fetchGraph]);

	return { commits, loading, error, refresh: fetchGraph };
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
