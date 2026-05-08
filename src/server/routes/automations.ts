import { atomicWriteJson } from "../../lib/atomic-write.ts";
import { badRequest, tryRoute } from "../../lib/route-helpers.ts";
import { userDataPath } from "../../lib/user-data.ts";
import { runAgentOnce } from "../services/agent-once.ts";

const AUTOMATIONS_FILE = userDataPath("automations.json");

interface AutomationStore {
	flows: unknown[];
}

async function loadAutomations(): Promise<AutomationStore> {
	const file = Bun.file(AUTOMATIONS_FILE);
	if (!(await file.exists())) return { flows: [] };
	const data = JSON.parse(await file.text()) as Partial<AutomationStore>;
	return { flows: Array.isArray(data.flows) ? data.flows : [] };
}

async function saveAutomations(store: AutomationStore): Promise<void> {
	await atomicWriteJson(AUTOMATIONS_FILE, store, 2);
}

export function automationRoutes() {
	return {
		"/api/automations": {
			GET: tryRoute(async () => {
				return Response.json(await loadAutomations());
			}),
			PUT: tryRoute(async (req) => {
				const body = (await req.json()) as Partial<AutomationStore>;
				const store = {
					flows: Array.isArray(body.flows) ? body.flows : [],
				};
				await saveAutomations(store);
				return Response.json(store);
			}),
		},
		"/api/automations/run": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as {
					prompt?: string;
					cwd?: string;
					timeoutMs?: number;
				};
				if (!body.prompt) return badRequest("prompt is required");
				const result = await runAgentOnce({
					agentKind: "claude",
					prompt: body.prompt,
					cwd: body.cwd || process.cwd(),
					timeoutMs: body.timeoutMs ?? 120_000,
				});
				return Response.json({ result });
			}),
		},
	};
}
