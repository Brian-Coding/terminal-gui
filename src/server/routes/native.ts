import { badRequest, tryRoute } from "../../lib/route-helpers.ts";
import {
	computeNativeDiff,
	resolveNativeDiffBinary,
} from "../services/native-diff.ts";

export function nativeRoutes() {
	return {
		"/api/native/diff": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as {
					before?: string;
					after?: string;
				};
				if (typeof body.before !== "string" || typeof body.after !== "string") {
					return badRequest("Missing before/after diff payload");
				}

				const diff = await computeNativeDiff(body.before, body.after);
				if (!diff) {
					return Response.json(
						{
							ok: false,
							error: "Native diff unavailable",
							available: Boolean(resolveNativeDiffBinary()),
						},
						{ status: 503 }
					);
				}

				return Response.json({ ok: true, diff });
			}),
		},
	};
}
