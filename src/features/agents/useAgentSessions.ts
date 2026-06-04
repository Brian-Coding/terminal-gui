import { useCallback } from "react";

import { fetchJsonOr } from "../../lib/fetch-json.ts";

import { usePollingResource } from "../../hooks/usePollingResource.ts";

import type { ChatAgentKind } from "./agents.ts";

interface AgentSession {
	paneId: string;
	agentKind: ChatAgentKind;
	cwd: string;
	sessionId: string | null;
	isRunning: boolean;
	clientCount: number;
	messageCount: number;
}

function areAgentSessionsEqual(prev: AgentSession[], next: AgentSession[]) {
	if (prev.length !== next.length) return false;
	for (let i = 0; i < prev.length; i++) {
		const a = prev[i]!;
		const b = next[i]!;
		if (
			a.paneId !== b.paneId ||
			a.agentKind !== b.agentKind ||
			a.cwd !== b.cwd ||
			a.sessionId !== b.sessionId ||
			a.isRunning !== b.isRunning ||
			a.clientCount !== b.clientCount ||
			a.messageCount !== b.messageCount
		)
			return false;
	}
	return true;
}

export function useAgentSessions(pollInterval = 3000) {
	const fetchSessions = useCallback(async (signal?: AbortSignal) => {
		const data = await fetchJsonOr<{ sessions?: AgentSession[] }>(
			"/api/terminal/agent-sessions",
			{},
			{ signal }
		);
		return data.sessions || [];
	}, []);
	const { data: sessions, refetch } = usePollingResource(
		fetchSessions,
		pollInterval,
		[] as AgentSession[],
		{ deferInitialFetch: true, isEqual: areAgentSessionsEqual }
	);
	return { sessions, refetch };
}
