import { tryRoute } from "../../lib/route-helpers.ts";
import { listLocalSessions } from "../services/sessions.ts";

export function sessionRoutes() {
	return {
		"/api/sessions": {
			GET: tryRoute(async () =>
				Response.json({ sessions: await listLocalSessions() })
			),
		},
	};
}
