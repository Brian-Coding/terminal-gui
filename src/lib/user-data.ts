import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

function resolveUserDataRoot(): string {
	if (process.env.INFERAY_USER_DATA_DIR) {
		return resolve(process.env.INFERAY_USER_DATA_DIR);
	}
	if (platform() === "darwin") {
		return join(homedir(), "Library", "Application Support", "Inferay");
	}
	if (platform() === "win32") {
		return join(process.env.APPDATA || homedir(), "Inferay");
	}
	return join(
		process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
		"inferay"
	);
}

export const USER_DATA_ROOT = resolveUserDataRoot();

export function userDataPath(...parts: string[]): string {
	return join(USER_DATA_ROOT, ...parts);
}
