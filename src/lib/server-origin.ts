const DEFAULT_SERVER_ORIGIN = "http://127.0.0.1:4001";
const SERVER_ORIGIN_QUERY_PARAM = "serverOrigin";

function isLoopbackHost(value: string): boolean {
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

function isAllowedServerOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			isLoopbackHost(url.host)
		);
	} catch {
		return false;
	}
}

export function getServerOrigin(): string {
	if (typeof window === "undefined") {
		return DEFAULT_SERVER_ORIGIN;
	}

	if (
		window.location.protocol === "http:" ||
		window.location.protocol === "https:"
	) {
		return window.location.origin;
	}

	const embeddedServerOrigin = new URLSearchParams(window.location.search).get(
		SERVER_ORIGIN_QUERY_PARAM
	);
	if (embeddedServerOrigin && isAllowedServerOrigin(embeddedServerOrigin)) {
		return embeddedServerOrigin;
	}

	return DEFAULT_SERVER_ORIGIN;
}

export function resolveServerUrl(path: string): string {
	return new URL(path, getServerOrigin()).toString();
}

export function getServerWebSocketUrl(path = "/ws"): string {
	const origin = new URL(getServerOrigin());
	const protocol = origin.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${origin.host}${path.startsWith("/") ? path : `/${path}`}`;
}
