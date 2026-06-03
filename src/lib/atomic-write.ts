import { renameSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const writeQueues = new Map<string, Promise<void>>();

/**
 * Atomically write JSON data to a file.
 * Writes to a .tmp sibling first, then renames into place.
 * Prevents partial/corrupt writes on crash or slow I/O (Windows/OneDrive).
 */
export async function atomicWriteJson(
	filePath: string,
	data: unknown,
	indent?: number
): Promise<void> {
	const previous = writeQueues.get(filePath) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(async () => {
			const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
			await mkdir(dirname(filePath), { recursive: true });
			await Bun.write(tmpPath, JSON.stringify(data, null, indent));
			renameSync(tmpPath, filePath);
		});
	writeQueues.set(filePath, next);
	try {
		await next;
	} finally {
		if (writeQueues.get(filePath) === next) {
			writeQueues.delete(filePath);
		}
	}
}
