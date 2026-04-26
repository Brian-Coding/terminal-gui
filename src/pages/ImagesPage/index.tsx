import { useCallback, useEffect, useState } from "react";
import { IconCamera, IconTrash } from "../../components/ui/Icons.tsx";

interface ImageEntry {
	name: string;
	path: string;
	timestamp: number;
	size: number;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const diff = now.getTime() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	if (d.getFullYear() === now.getFullYear()) {
		return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

export function ImagesPage() {
	const [images, setImages] = useState<ImageEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [selected, setSelected] = useState<ImageEntry | null>(null);

	const fetchImages = useCallback(async () => {
		try {
			const res = await fetch("/api/images");
			const data = await res.json();
			setImages(data.images ?? []);
		} catch {
			setImages([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchImages();
	}, [fetchImages]);

	const deleteImage = useCallback(
		async (img: ImageEntry) => {
			try {
				await fetch(`/api/delete-temp?path=${encodeURIComponent(img.path)}`, {
					method: "DELETE",
				});
				setImages((prev) => prev.filter((i) => i.path !== img.path));
				if (selected?.path === img.path) setSelected(null);
			} catch {}
		},
		[selected]
	);

	return (
		<div className="flex h-full bg-inferay-black">
			{/* List */}
			<div className="flex w-80 flex-col border-r border-inferay-gray-border">
				<div className="flex h-10 items-center gap-2 border-b border-inferay-gray-border px-3">
					<IconCamera size={14} className="text-inferay-muted-gray" />
					<span className="text-[12px] font-medium text-inferay-soft-white">
						Images
					</span>
					<span className="ml-auto text-[10px] text-inferay-muted-gray">
						{images.length}
					</span>
				</div>
				<div className="flex-1 overflow-y-auto scrollbar-none">
					{loading ? (
						<div className="p-4 text-[11px] text-inferay-muted-gray">
							Loading...
						</div>
					) : images.length === 0 ? (
						<div className="p-4 text-[11px] text-inferay-muted-gray">
							No images yet. Attach an image in a chat to see it here.
						</div>
					) : (
						images.map((img) => (
							<button
								key={img.path}
								type="button"
								onClick={() => setSelected(img)}
								className={`group flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
									selected?.path === img.path
										? "bg-inferay-white/[0.06]"
										: "hover:bg-inferay-white/[0.03]"
								}`}
							>
								<img
									src={`/api/file?path=${encodeURIComponent(img.path)}`}
									alt=""
									className="h-10 w-10 shrink-0 rounded border border-inferay-gray-border object-cover"
								/>
								<div className="min-w-0 flex-1">
									<div className="truncate text-[11px] text-inferay-soft-white">
										{img.name}
									</div>
									<div className="flex gap-2 text-[10px] text-inferay-muted-gray">
										<span>{formatTime(img.timestamp)}</span>
										<span>{formatBytes(img.size)}</span>
									</div>
								</div>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										deleteImage(img);
									}}
									className="shrink-0 rounded p-1.5 text-inferay-muted-gray/50 transition-colors hover:bg-inferay-white/[0.06] hover:text-red-400 group-hover:text-inferay-muted-gray"
									title="Delete"
								>
									<IconTrash size={12} />
								</button>
							</button>
						))
					)}
				</div>
			</div>

			{/* Preview */}
			<div className="flex flex-1 items-center justify-center overflow-hidden p-6">
				{selected ? (
					<div className="flex h-full w-full flex-col items-center gap-3">
						<img
							src={`/api/file?path=${encodeURIComponent(selected.path)}`}
							alt={selected.name}
							className="max-h-[calc(100%-3rem)] max-w-full rounded-lg border border-inferay-gray-border object-contain"
						/>
						<div className="flex items-center gap-3 text-[11px] text-inferay-muted-gray">
							<span>{selected.name}</span>
							<span>{formatBytes(selected.size)}</span>
							<span>{new Date(selected.timestamp).toLocaleString()}</span>
						</div>
					</div>
				) : (
					<span className="text-[12px] text-inferay-muted-gray">
						Select an image to preview
					</span>
				)}
			</div>
		</div>
	);
}
