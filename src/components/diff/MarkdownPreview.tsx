import { memo, useEffect, useRef, useState } from "react";
import {
	type MdBlock,
	type MdInlineToken,
	type MdListItem,
	parseBlocks,
	parseInline,
} from "../../lib/markdown.ts";

let mermaidPromise: Promise<unknown> | null = null;
function loadMermaid(): Promise<unknown> {
	if (mermaidPromise) return mermaidPromise;
	mermaidPromise = new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
		script.onload = () => {
			const m = (window as Record<string, unknown>).mermaid as {
				initialize: (cfg: Record<string, unknown>) => void;
			};
			m.initialize({
				startOnLoad: false,
				theme: "dark",
				themeVariables: {
					darkMode: true,
					background: "transparent",
					primaryColor: "var(--color-inferay-gray-border)",
					primaryTextColor: "var(--color-inferay-soft-white)",
					primaryBorderColor: "var(--color-inferay-gray-border-bold)",
					lineColor: "var(--color-inferay-muted-gray)",
					secondaryColor: "var(--color-inferay-gray)",
					tertiaryColor: "var(--color-inferay-dark-gray)",
					fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
					fontSize: "11px",
				},
			});
			resolve(m);
		};
		script.onerror = reject;
		document.head.appendChild(script);
	});
	return mermaidPromise;
}

function MermaidBlock({ code }: { code: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		loadMermaid()
			.then(() => {
				if (cancelled || !ref.current) return;
				const m = (window as Record<string, unknown>).mermaid as {
					render: (id: string, code: string) => Promise<{ svg: string }>;
				};
				return m.render(id, code);
			})
			.then((result) => {
				if (cancelled || !ref.current || !result) return;
				ref.current.innerHTML = result.svg;
			})
			.catch((err) => {
				if (!cancelled) setError(String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [code]);

	if (error)
		return (
			<div className="rounded-md border border-inferay-gray-border bg-inferay-dark-gray p-3">
				<pre className="text-[10px] text-red-400 whitespace-pre-wrap">
					{error}
				</pre>
			</div>
		);

	return (
		<div
			ref={ref}
			className="flex items-center justify-center rounded-md border border-inferay-gray-border bg-inferay-dark-gray p-4 overflow-x-auto"
		/>
	);
}

function InlineTokens({ tokens }: { tokens: MdInlineToken[] }) {
	return (
		<>
			{tokens.map((tok, i) => (
				<InlineToken key={i} token={tok} />
			))}
		</>
	);
}

function InlineToken({ token }: { token: MdInlineToken }) {
	switch (token.type) {
		case "linebreak":
			return <br />;

		case "image":
			return (
				<img
					src={token.href}
					alt={token.alt ?? ""}
					className="max-w-full rounded-md my-1 inline-block"
				/>
			);

		case "link":
			return (
				<a
					href={token.href}
					className="text-inferay-accent underline underline-offset-2 decoration-inferay-accent/40 hover:decoration-inferay-accent"
					target="_blank"
					rel="noopener noreferrer"
				>
					{token.children ? (
						<InlineTokens tokens={token.children} />
					) : (
						token.text
					)}
				</a>
			);

		case "code":
			return (
				<code className="rounded bg-inferay-dark-gray border border-inferay-gray-border px-1.5 py-0.5 text-[10px] font-diff text-inferay-white">
					{token.text}
				</code>
			);

		case "bold-italic":
			return (
				<strong className="font-bold text-inferay-white">
					<em className="italic">
						{token.children ? (
							<InlineTokens tokens={token.children} />
						) : (
							token.text
						)}
					</em>
				</strong>
			);

		case "bold":
			return (
				<strong className="font-semibold text-inferay-white">
					{token.children ? (
						<InlineTokens tokens={token.children} />
					) : (
						token.text
					)}
				</strong>
			);

		case "italic":
			return (
				<em className="italic text-inferay-soft-white">
					{token.children ? (
						<InlineTokens tokens={token.children} />
					) : (
						token.text
					)}
				</em>
			);

		case "strikethrough":
			return (
				<del className="line-through text-inferay-muted-gray">
					{token.children ? (
						<InlineTokens tokens={token.children} />
					) : (
						token.text
					)}
				</del>
			);
		default:
			return <>{token.text}</>;
	}
}

function Inline({ text }: { text: string }) {
	const tokens = parseInline(text);
	return <InlineTokens tokens={tokens} />;
}

const HEADING_CLASSES: Record<number, string> = {
	1: "text-[18px] font-bold text-inferay-white pb-2 mt-6 first:mt-0 border-b border-inferay-gray-border",
	2: "text-[15px] font-semibold text-inferay-white pb-1.5 mt-5 first:mt-0 border-b border-inferay-gray-border",
	3: "text-[13px] font-semibold text-inferay-white mt-4 first:mt-0",
	4: "text-[12px] font-semibold text-inferay-white mt-3 first:mt-0",
	5: "text-[11px] font-semibold text-inferay-white mt-2 first:mt-0",
	6: "text-[10px] font-semibold text-inferay-soft-white uppercase tracking-wide mt-2 first:mt-0",
};

function ListItemRenderer({ item }: { item: MdListItem }) {
	return (
		<li className="text-[11px] text-inferay-soft-white leading-relaxed">
			{item.checked !== undefined && (
				<span className="mr-1.5 inline-flex">
					{item.checked ? (
						<span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border border-inferay-accent/50 bg-inferay-accent/15 text-[8px] text-inferay-accent">
							✓
						</span>
					) : (
						<span className="inline-flex h-3.5 w-3.5 rounded border border-inferay-gray-border" />
					)}
				</span>
			)}
			<Inline text={item.content} />
			{item.children.length > 0 && (
				<ul className="mt-1 list-disc pl-5 space-y-0.5">
					{item.children.map((child, j) => (
						<ListItemRenderer key={j} item={child} />
					))}
				</ul>
			)}
		</li>
	);
}

function BlockRenderer({ block }: { block: MdBlock }) {
	switch (block.type) {
		case "heading":
			return (
				<div className={HEADING_CLASSES[block.level ?? 1]}>
					<Inline text={block.content} />
				</div>
			);

		case "mermaid":
			return <MermaidBlock code={block.content} />;

		case "code":
			return (
				<div className="relative group">
					{block.lang && (
						<span className="absolute top-1.5 right-2 text-[8px] font-diff uppercase tracking-wider text-inferay-muted-gray/40">
							{block.lang}
						</span>
					)}
					<pre className="overflow-x-auto rounded-md border border-inferay-gray-border bg-inferay-dark-gray p-3">
						<code className="text-[10px] font-diff text-inferay-soft-white leading-[18px] whitespace-pre">
							{block.content}
						</code>
					</pre>
				</div>
			);

		case "blockquote": {
			const innerBlocks = parseBlocks(block.content);
			return (
				<div className="border-l-2 border-inferay-accent/30 pl-4 py-0.5">
					{innerBlocks.map((inner, j) => (
						<BlockRenderer key={j} block={inner} />
					))}
				</div>
			);
		}

		case "hr":
			return <hr className="border-inferay-gray-border my-4" />;

		case "table":
			if (!block.rows?.length) return null;
			return (
				<div className="overflow-x-auto rounded-md border border-inferay-gray-border">
					<table className="w-full text-[10px]">
						<thead>
							<tr className="border-b border-inferay-gray-border bg-inferay-dark-gray">
								{block.rows[0]?.map((cell, j) => (
									<th
										key={j}
										className="px-3 py-2 text-left font-medium text-inferay-white whitespace-nowrap"
									>
										<Inline text={cell} />
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.slice(1).map((row, k) => (
								<tr
									key={k}
									className="border-b border-inferay-gray-border/50 last:border-0"
								>
									{row.map((cell, j) => (
										<td key={j} className="px-3 py-1.5 text-inferay-soft-white">
											<Inline text={cell} />
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);

		case "checklist":
			return (
				<ul className="space-y-1 pl-1">
					{(block.items ?? []).map((item, k) => (
						<ListItemRenderer key={k} item={item} />
					))}
				</ul>
			);

		case "ul":
			return (
				<ul className="list-disc pl-5 space-y-0.5">
					{(block.items ?? []).map((item, k) => (
						<ListItemRenderer key={k} item={item} />
					))}
				</ul>
			);

		case "ol":
			return (
				<ol className="list-decimal pl-5 space-y-0.5">
					{(block.items ?? []).map((item, k) => (
						<ListItemRenderer key={k} item={item} />
					))}
				</ol>
			);

		case "paragraph":
			return (
				<p className="text-[11px] text-inferay-soft-white leading-relaxed">
					<Inline text={block.content} />
				</p>
			);
	}
}

export const MarkdownPreview = memo(function MarkdownPreview({
	content,
}: {
	content: string;
}) {
	const blocks = parseBlocks(content);
	return (
		<div className="space-y-3">
			{blocks.map((block, i) => (
				<BlockRenderer key={i} block={block} />
			))}
		</div>
	);
});
