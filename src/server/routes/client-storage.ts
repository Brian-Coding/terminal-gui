import { tryRoute } from "../../lib/route-helpers.ts";
import {
	applyClientStorageEntries,
	loadClientStorageEntries,
	normalizeEntries,
} from "../services/client-storage.ts";

async function applyClientStorageRequest(req: Request): Promise<Response> {
	const body = await req.json();
	const entries = normalizeEntries(body?.entries);
	await applyClientStorageEntries(entries);
	return Response.json({ ok: true });
}

export function clientStorageRoutes() {
	return {
		"/api/client-storage": {
			GET: tryRoute(async () => {
				const entries = await loadClientStorageEntries();
				return Response.json({ entries });
			}),
			POST: tryRoute(applyClientStorageRequest),
			PUT: tryRoute(applyClientStorageRequest),
		},
	};
}
