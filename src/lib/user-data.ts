import { homedir, platform } from "node:os";
import { join } from "node:path";

const USER_DATA_ROOT = (() => {
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
})();

export function userDataPath(...parts: string[]): string {
	return join(USER_DATA_ROOT, ...parts);
}
