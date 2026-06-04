import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { PROJECT_ROOT } from "../lib/path-utils.ts";

const LOCAL_AUTH_COOKIE = "inferay_local_auth";
const LOCAL_AUTH_TOKEN = crypto.randomUUID();

export function localAuthCookieHeader(): string {
	return `${LOCAL_AUTH_COOKIE}=${encodeURIComponent(LOCAL_AUTH_TOKEN)}; Path=/; SameSite=Strict`;
}

function isAuthorizedLocalRequest(req: Request): boolean {
	let cookieToken: string | null = null;
	const cookie = req.headers.get("cookie");
	if (cookie) {
		for (const part of cookie.split(";")) {
			const [key, ...valueParts] = part.trim().split("=");
			if (key === LOCAL_AUTH_COOKIE) {
				cookieToken = decodeURIComponent(valueParts.join("="));
				break;
			}
		}
	}
	const token = req.headers.get("x-inferay-auth") ?? cookieToken;
	return token === LOCAL_AUTH_TOKEN;
}

function isLoopbackHost(value: string | null): boolean {
	if (!value) return true;
	const raw = value.toLowerCase();
	const host = raw.startsWith("[")
		? (raw.match(/^\[([^\]]+)\]/)?.[1] ?? raw)
		: (raw.split(":")[0] ?? raw);
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host.endsWith(".localhost")
	);
}

export function isTrustedLocalOrigin(origin: string | null): boolean {
	if (!origin || origin === "null") return false;
	try {
		const url = new URL(origin);
		if (url.protocol === "views:") return true;
		return isLoopbackHost(url.host);
	} catch {
		return false;
	}
}

export function isTrustedLocalRequest(req: Request): boolean {
	const origin = req.headers.get("origin");
	const fetchSite = req.headers.get("sec-fetch-site");
	const fromAppView = origin?.startsWith("views:") ?? false;
	const trustedOrigin =
		origin === null
			? fetchSite === "same-origin" || fetchSite === "none"
			: isTrustedLocalOrigin(origin);
	return (
		isLoopbackHost(req.headers.get("host")) &&
		trustedOrigin &&
		(isAuthorizedLocalRequest(req) || fromAppView) &&
		(fromAppView || req.headers.get("sec-fetch-site") !== "cross-site")
	);
}

export function isWithinDirectory(
	pathname: string,
	directory: string
): boolean {
	const resolvedPath = resolve(pathname);
	const resolvedDirectory = resolve(directory);
	const rel = relative(resolvedDirectory, resolvedPath);
	return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
}

export function isAllowedLocalPath(pathname: string): boolean {
	return [PROJECT_ROOT, homedir()].some((root) =>
		isWithinDirectory(pathname, root)
	);
}

export function resolveAllowedLocalPath(pathname: string): string | null {
	const resolved = resolve(pathname);
	return isAllowedLocalPath(resolved) ? resolved : null;
}

export async function resolveRealAllowedLocalPath(
	pathname: string
): Promise<string | null> {
	const resolved = resolveAllowedLocalPath(pathname);
	if (!resolved) return null;
	try {
		const real = await realpath(resolved);
		return isAllowedLocalPath(real) ? real : null;
	} catch {
		return null;
	}
}

export function isSafeRelativePath(pathname: string): boolean {
	if (!pathname || pathname.includes("\0") || isAbsolute(pathname))
		return false;
	const parts = pathname.split(/[\\/]+/);
	return !parts.some((part) => part === "..");
}

export function resolveAllowedChildPath(
	directory: string,
	pathname: string
): string | null {
	if (!isSafeRelativePath(pathname)) return null;
	const resolvedDirectory = resolveAllowedLocalPath(directory);
	if (!resolvedDirectory) return null;
	const resolved = resolve(resolvedDirectory, pathname);
	return isWithinDirectory(resolved, resolvedDirectory) ? resolved : null;
}
