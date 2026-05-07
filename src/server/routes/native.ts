import { platform } from "node:os";
import { badRequest, tryRoute } from "../../lib/route-helpers.ts";
import { resolveAllowedLocalPath } from "../security.ts";
import { resolveNativeCoreBinary } from "../services/native-core.ts";
import { computeNativeDiff } from "../services/native-diff.ts";

async function openPath(path: string, reveal: boolean) {
	const os = platform();
	const command =
		os === "darwin"
			? reveal
				? ["open", "-R", path]
				: ["open", path]
			: os === "win32"
				? reveal
					? ["explorer.exe", `/select,${path}`]
					: ["explorer.exe", path]
				: ["xdg-open", reveal ? path.replace(/\/[^/]*$/, "") || path : path];
	const proc = Bun.spawn(command, {
		stdout: "ignore",
		stderr: "ignore",
	});
	const exitCode = await proc.exited;
	return exitCode === 0;
}

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
							available: Boolean(resolveNativeCoreBinary()),
						},
						{ status: 503 }
					);
				}

				return Response.json({ ok: true, diff });
			}),
		},
		"/api/native/open-path": {
			POST: tryRoute(async (req) => {
				const body = (await req.json()) as {
					path?: string;
					reveal?: boolean;
				};
				if (typeof body.path !== "string" || !body.path.trim()) {
					return badRequest("Missing path");
				}
				const resolvedPath = resolveAllowedLocalPath(body.path);
				if (!resolvedPath) {
					return Response.json({ error: "Access denied" }, { status: 403 });
				}
				const ok = await openPath(resolvedPath, Boolean(body.reveal));
				return Response.json({ ok });
			}),
		},
	};
}
