import {
	autoDetectSimulatorProjectFolders,
	bootSimulator,
	buildInstallLaunchProject,
	getBaguetteStatus,
	getSimulatorProjectFolders,
	listSimulatorProjects,
	listSimulators,
	openSimulatorApp,
	openXcodeProject,
	pickSimulatorProjectFolder,
	setSimulatorProjectFolders,
	shutdownSimulator,
	startBaguetteServer,
} from "../services/simulator-service.ts";

function darwinOnly(routes: Record<string, unknown>) {
	return process.platform === "darwin" ? routes : {};
}

function errorResponse(error: string, status = 500) {
	return Response.json({ ok: false, error }, { status });
}

async function requireBody(req: Request, ...keys: string[]) {
	const body = await req.json();
	for (const key of keys) {
		if (!body?.[key]) return errorResponse(`${key} required`, 400);
	}
	return body;
}

function tryRoute(handler: (req: Request) => Promise<Response> | Response) {
	return async (req: Request) => {
		try {
			return await handler(req);
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error.message : "Simulator request failed"
			);
		}
	};
}

export function simulatorRoutes() {
	return darwinOnly({
		"/api/simulator/list": {
			GET: tryRoute(async () =>
				Response.json({ ok: true, devices: await listSimulators() })
			),
		},
		"/api/simulator/projects": {
			GET: tryRoute(async () =>
				Response.json({ ok: true, projects: await listSimulatorProjects() })
			),
		},
		"/api/simulator/project-folders": {
			GET: tryRoute(async () =>
				Response.json({
					ok: true,
					folders: await getSimulatorProjectFolders(),
				})
			),
			PUT: tryRoute(async (req) => {
				const body = (await req.json()) as { folders?: unknown };
				if (!Array.isArray(body.folders)) {
					return errorResponse("folders must be an array", 400);
				}
				const folders = body.folders.filter(
					(item): item is string => typeof item === "string"
				);
				return Response.json({
					ok: true,
					folders: await setSimulatorProjectFolders(folders),
				});
			}),
		},
		"/api/simulator/project-folders/pick": {
			POST: tryRoute(async () =>
				Response.json({
					ok: true,
					folder: await pickSimulatorProjectFolder(),
				})
			),
		},
		"/api/simulator/project-folders/detect": {
			POST: tryRoute(async () =>
				Response.json({
					ok: true,
					folders: await autoDetectSimulatorProjectFolders(),
				})
			),
		},
		"/api/simulator/baguette/status": {
			GET: tryRoute(async () => Response.json(await getBaguetteStatus())),
		},
		"/api/simulator/baguette/start": {
			POST: tryRoute(async () => Response.json(await startBaguetteServer())),
		},
		"/api/simulator/boot": {
			POST: tryRoute(async (req) => {
				const body = await requireBody(req, "udid");
				if (body instanceof Response) return body;
				const result = await bootSimulator(body.udid);
				return result.ok
					? Response.json({ ok: true })
					: errorResponse(result.error || "Failed to boot simulator");
			}),
		},
		"/api/simulator/shutdown": {
			POST: tryRoute(async (req) => {
				const body = await requireBody(req, "udid");
				if (body instanceof Response) return body;
				const result = await shutdownSimulator(body.udid);
				return result.ok
					? Response.json({ ok: true })
					: errorResponse(result.error || "Failed to shutdown simulator");
			}),
		},
		"/api/simulator/open": {
			POST: tryRoute(async (req) => {
				const { udid } = await req.json();
				await openSimulatorApp(udid);
				return Response.json({ ok: true });
			}),
		},
		"/api/simulator/open-xcode": {
			POST: tryRoute(async (req) => {
				const body = await requireBody(req, "appPath");
				if (body instanceof Response) return body;
				const projectPath = await openXcodeProject(body.appPath);
				return projectPath
					? Response.json({ ok: true, projectPath })
					: errorResponse("No .xcodeproj found", 404);
			}),
		},
		"/api/simulator/build-launch": {
			POST: tryRoute(async (req) => {
				const body = await requireBody(req, "udid", "appPath");
				if (body instanceof Response) return body;
				const result = await buildInstallLaunchProject({
					appPath: body.appPath,
					udid: body.udid,
					scheme: body.scheme,
				});
				return result.ok
					? Response.json(result)
					: errorResponse(result.error || "Build and launch failed");
			}),
		},
	});
}
