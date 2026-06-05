import { agentAccountRoutes } from "./agent-accounts.ts";
import { appInfoRoutes } from "./app-info.ts";
import { chatEventRoutes } from "./chat-events.ts";
import { chatQueueRoutes } from "./chat-queues.ts";
import { checkpointRoutes } from "./checkpoint.ts";
import { clientStorageRoutes } from "./client-storage.ts";
import { configRoutes } from "./config.ts";
import { featureRoutes } from "./feature-routes.ts";
import { fileRoutes } from "./files.ts";
import { forgeRoutes } from "./forge.ts";
import { gitRoutes } from "./git.ts";
import { nativeRoutes } from "./native.ts";
import { promptRoutes } from "./prompts.ts";
import { sessionRoutes } from "./sessions.ts";
import { simulatorRoutes } from "./simulator.ts";
import { terminalRoutes } from "./terminal.ts";
import { titleRoutes } from "./title.ts";
export function buildApiRoutes() {
	return {
		...agentAccountRoutes(),
		...appInfoRoutes(),
		...configRoutes(),
		...fileRoutes(),
		...forgeRoutes(),
		...nativeRoutes(),
		...terminalRoutes(),
		...chatEventRoutes(),
		...chatQueueRoutes(),
		...clientStorageRoutes(),
		...checkpointRoutes(),
		...promptRoutes(),
		...gitRoutes(),
		...sessionRoutes(),
		...simulatorRoutes(),
		...titleRoutes(),
		...featureRoutes(),
	};
}
