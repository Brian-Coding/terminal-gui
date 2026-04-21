import { checkpointRoutes } from "./checkpoint.ts";
import { configRoutes } from "./config.ts";
import { fileRoutes } from "./files.ts";
import { gitRoutes } from "./git.ts";
import { nativeRoutes } from "./native.ts";
import { promptRoutes } from "./prompts.ts";
import { terminalRoutes } from "./terminal.ts";
export function buildApiRoutes() {
	return {
		...configRoutes(),
		...fileRoutes(),
		...nativeRoutes(),
		...terminalRoutes(),
		...checkpointRoutes(),
		...promptRoutes(),
		...gitRoutes(),
	};
}
