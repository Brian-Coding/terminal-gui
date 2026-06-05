import { tryRoute } from "../../lib/route-helpers.ts";
import { readChatEvents } from "../services/chat-events.ts";

export function chatEventRoutes() {
	return {
		"/api/chat-events/:paneId": {
			GET: tryRoute(async (req: Request & { params: { paneId: string } }) => {
				const url = new URL(req.url);
				const after = Number(url.searchParams.get("after") ?? "0") || 0;
				const limit = Math.min(
					Math.max(Number(url.searchParams.get("limit") ?? "500") || 500, 1),
					1000
				);
				return Response.json({
					events: await readChatEvents(req.params.paneId, after, limit),
				});
			}),
		},
	};
}
