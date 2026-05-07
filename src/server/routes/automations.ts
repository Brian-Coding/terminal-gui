import { atomicWriteJson } from "../../lib/atomic-write.ts";
import { tryRoute } from "../../lib/route-helpers.ts";
import { userDataPath } from "../../lib/user-data.ts";

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
	};
}
