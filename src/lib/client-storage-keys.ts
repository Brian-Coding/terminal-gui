export const TERMINAL_STATE_STORAGE_KEY = "inferay-terminal-state";

const SYNCED_STORAGE_KEYS = new Set([
	TERMINAL_STATE_STORAGE_KEY,
	"commit-graph-columns-v5",
	"editor-selected-pane",
	"git-watched-dirs",
	"main-sidebar-width",
	"sidebar-collapsed",
	"terminal-editor-zen",
	"terminal-layout-mode",
	"terminal-main-view",
]);

const SYNCED_STORAGE_PREFIXES = [
	"git-change-checkpoint:",
	"inferay-",
	"inferay.",
];

export function shouldSyncClientStorageKey(key: string): boolean {
	return (
		SYNCED_STORAGE_KEYS.has(key) ||
		SYNCED_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
	);
}
