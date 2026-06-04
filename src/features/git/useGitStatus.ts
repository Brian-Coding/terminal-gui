import { useCallback, useMemo } from "react";
import { postJson } from "../../lib/fetch-json.ts";
import { usePollingResource } from "../../hooks/usePollingResource.ts";
import type { GitProjectStatus } from "./types.ts";

function areGitStatusesEqual(
	prev: GitProjectStatus[],
	next: GitProjectStatus[]
) {
	if (prev.length !== next.length) return false;
	for (let i = 0; i < prev.length; i++) {
		const a = prev[i]!;
		const b = next[i]!;
		if (
			a.cwd !== b.cwd ||
			a.name !== b.name ||
			a.branch !== b.branch ||
			a.upstream !== b.upstream ||
			a.ahead !== b.ahead ||
			a.behind !== b.behind ||
			a.stagedCount !== b.stagedCount ||
			a.unstagedCount !== b.unstagedCount ||
			a.untrackedCount !== b.untrackedCount ||
			a.files.length !== b.files.length
		)
			return false;
		for (let j = 0; j < a.files.length; j++) {
			const af = a.files[j]!;
			const bf = b.files[j]!;
			if (
				af.status !== bf.status ||
				af.staged !== bf.staged ||
				af.path !== bf.path ||
				af.originalPath !== bf.originalPath ||
				af.additions !== bf.additions ||
				af.deletions !== bf.deletions
			)
				return false;
		}
	}
	return true;
}

export function useGitStatus(cwds: string[], options?: { enabled?: boolean }) {
	const enabled = options?.enabled ?? cwds.length > 0;
	const fetcher = useCallback(
		async () => {
			if (cwds.length === 0) return [];
			return postJson<GitProjectStatus[]>("/api/git/statuses", { cwds });
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[cwds]
	);

	const {
		data: projects,
		setData,
		refetch,
	} = usePollingResource<GitProjectStatus[]>(fetcher, 5000, [], {
		deferInitialFetch: true,
		enabled,
		isEqual: areGitStatusesEqual,
	});

	const projectMap = useMemo(() => {
		const map = new Map<string, GitProjectStatus>();
		for (const p of projects) map.set(p.cwd, p);
		return map;
	}, [projects]);

	// Apply an optimistic update to a single project's status. Used to make
	// stage / unstage feel instant — the actual git command runs in the
	// background and a subsequent refetch reconciles with server truth.
	const applyOptimistic = useCallback(
		(cwd: string, mutator: (project: GitProjectStatus) => GitProjectStatus) => {
			setData((prev) => prev.map((p) => (p.cwd === cwd ? mutator(p) : p)));
		},
		[setData]
	);

	return { projects, projectMap, refetch, applyOptimistic };
}
