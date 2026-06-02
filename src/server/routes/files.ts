import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { PROJECT_ROOT } from "../../lib/path-utils.ts";
import { tryRoute } from "../../lib/route-helpers.ts";
import {
	isAllowedLocalPath,
	isWithinDirectory,
	resolveRealAllowedLocalPath,
} from "../security.ts";

const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".ico",
]);

const TMP_DIR = resolve(PROJECT_ROOT, "data/.tmp");
const MAX_TEMP_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_SERVED_FILE_BYTES = 20 * 1024 * 1024;

export function fileRoutes() {
	return {
		"/api/files/search": {
			GET: tryRoute(async (req) => {
				const url = new URL(req.url);
				const cwd = url.searchParams.get("cwd") || PROJECT_ROOT;
				const query = (url.searchParams.get("q") || "").toLowerCase();
				const limit = Math.min(
					Number(url.searchParams.get("limit") || "20") || 20,
					50
				);

				const resolvedCwd = resolve(cwd);
				if (!isAllowedLocalPath(resolvedCwd)) {
					return Response.json({ error: "Invalid directory" }, { status: 400 });
				}

				const results: { name: string; path: string; isDir: boolean }[] = [];
				const seen = new Set<string>();
				const SKIP = new Set(["node_modules", "build", "dist"]);

				async function searchDir(dir: string, depth: number) {
					if (depth > 4 || results.length >= limit) return;
					try {
						const entries = await readdir(dir, { withFileTypes: true });
						for (const entry of entries) {
							if (results.length >= limit) break;
							if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
							const full = join(dir, entry.name);
							const rel = relative(resolvedCwd, full);
							if (seen.has(rel)) continue;
							if (
								!query ||
								entry.name.toLowerCase().includes(query) ||
								rel.toLowerCase().includes(query)
							) {
								seen.add(rel);
								results.push({
									name: entry.name,
									path: rel,
									isDir: entry.isDirectory(),
								});
							}
							if (entry.isDirectory() && depth < 4) {
								await searchDir(full, depth + 1);
							}
						}
					} catch {}
				}

				await searchDir(resolvedCwd, 0);
				return Response.json({ cwd: resolvedCwd, results });
			}),
		},

		"/api/upload-temp": {
			POST: tryRoute(async (req) => {
				const formData = await req.formData();
				const file = formData.get("file") as File | null;
				if (!file)
					return Response.json({ error: "No file provided" }, { status: 400 });
				if (file.size > MAX_TEMP_UPLOAD_BYTES) {
					return Response.json({ error: "File too large" }, { status: 413 });
				}
				const ext = file.name
					.substring(file.name.lastIndexOf("."))
					.toLowerCase();
				if (!IMAGE_EXTENSIONS.has(ext)) {
					return Response.json(
						{ error: "Unsupported file type" },
						{ status: 400 }
					);
				}
				await mkdir(TMP_DIR, { recursive: true });
				const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
				const filePath = resolve(TMP_DIR, `${Date.now()}-${safeName}`);
				if (!isWithinDirectory(filePath, TMP_DIR)) {
					return Response.json({ error: "Invalid file name" }, { status: 400 });
				}
				await Bun.write(filePath, file);
				return Response.json({ path: filePath });
			}),
		},

		"/api/images": {
			GET: tryRoute(async () => {
				await mkdir(TMP_DIR, { recursive: true });
				const entries = await readdir(TMP_DIR);
				const images: {
					name: string;
					path: string;
					timestamp: number;
					size: number;
				}[] = [];
				for (const entry of entries) {
					const ext = entry.substring(entry.lastIndexOf(".")).toLowerCase();
					if (!IMAGE_EXTENSIONS.has(ext)) continue;
					const full = resolve(TMP_DIR, entry);
					const info = await stat(full);
					const dashIdx = entry.indexOf("-");
					const ts =
						dashIdx > 0 ? Number(entry.substring(0, dashIdx)) : info.mtimeMs;
					images.push({
						name: dashIdx > 0 ? entry.substring(dashIdx + 1) : entry,
						path: full,
						timestamp: ts,
						size: info.size,
					});
				}
				images.sort((a, b) => b.timestamp - a.timestamp);
				return Response.json({ images });
			}),
		},

		"/api/delete-temp": {
			DELETE: tryRoute(async (req) => {
				const url = new URL(req.url);
				const filePath = url.searchParams.get("path");
				if (!filePath)
					return Response.json({ error: "No path provided" }, { status: 400 });
				const resolved = resolve(filePath);
				if (!isWithinDirectory(resolved, TMP_DIR))
					return Response.json({ error: "Access denied" }, { status: 403 });
				const { unlink } = await import("node:fs/promises");
				await unlink(resolved);
				return Response.json({ ok: true });
			}),
		},

		"/api/file": {
			GET: tryRoute(async (req) => {
				const url = new URL(req.url);
				const filePath = url.searchParams.get("path");
				if (!filePath) {
					return Response.json({ error: "No path provided" }, { status: 400 });
				}

				const resolvedPath = await resolveRealAllowedLocalPath(filePath);
				if (!resolvedPath) {
					return Response.json({ error: "Access denied" }, { status: 403 });
				}
				if (
					!isWithinDirectory(resolvedPath, TMP_DIR) &&
					!isWithinDirectory(resolvedPath, PROJECT_ROOT)
				) {
					return Response.json({ error: "Access denied" }, { status: 403 });
				}
				const ext = resolvedPath
					.substring(resolvedPath.lastIndexOf("."))
					.toLowerCase();
				if (!IMAGE_EXTENSIONS.has(ext)) {
					return Response.json(
						{ error: "Unsupported file type" },
						{ status: 400 }
					);
				}

				if (!existsSync(resolvedPath)) {
					return Response.json({ error: "File not found" }, { status: 404 });
				}

				const file = Bun.file(resolvedPath);
				if (file.size > MAX_SERVED_FILE_BYTES) {
					return Response.json({ error: "File too large" }, { status: 413 });
				}
				return new Response(file, {
					headers: {
						"Content-Type": file.type || "application/octet-stream",
						"Cache-Control": "no-store",
					},
				});
			}),
		},
	};
}
