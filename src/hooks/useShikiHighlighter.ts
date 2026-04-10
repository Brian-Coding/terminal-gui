/**
 * Shiki Syntax Highlighter Hook
 *
 * Provides lazy syntax highlighting for visible lines only.
 * Caches highlighted lines for instant re-renders during scroll.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	type BundledLanguage,
	type BundledTheme,
	type Highlighter,
	createHighlighter,
} from "shiki";

// Map file extensions to Shiki language IDs
const EXTENSION_TO_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	json: "json",
	md: "markdown",
	css: "css",
	scss: "scss",
	html: "html",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	sql: "sql",
	graphql: "graphql",
	vue: "vue",
	svelte: "svelte",
	php: "php",
	lua: "lua",
	r: "r",
	scala: "scala",
	dart: "dart",
	zig: "zig",
};

// Singleton highlighter instance
let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLanguages = new Set<string>();

async function getHighlighter(): Promise<Highlighter> {
	if (highlighterInstance) return highlighterInstance;
	if (highlighterPromise) return highlighterPromise;

	highlighterPromise = createHighlighter({
		themes: ["github-dark-default"],
		langs: [], // Load languages on demand
	});

	highlighterInstance = await highlighterPromise;
	return highlighterInstance;
}

function getLanguageFromPath(filePath: string): BundledLanguage | null {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return null;
	return EXTENSION_TO_LANG[ext] ?? null;
}

export interface HighlightedLine {
	lineNum: number;
	html: string;
}

export interface UseShikiHighlighterOptions {
	/** File path for language detection */
	filePath: string;
	/** All lines to potentially highlight */
	lines: string[];
	/** Currently visible line indices (start, end) */
	visibleRange: [number, number];
	/** Theme to use */
	theme?: BundledTheme;
	/** Whether highlighting is enabled */
	enabled?: boolean;
}

export interface ShikiHighlighterAPI {
	/** Get highlighted HTML for a specific line (returns plain text if not yet highlighted) */
	getHighlightedLine: (lineIdx: number) => string;
	/** Whether the highlighter is ready */
	isReady: boolean;
	/** Current language being used */
	language: string | null;
}

export function useShikiHighlighter({
	filePath,
	lines,
	visibleRange,
	theme = "github-dark-default",
	enabled = true,
}: UseShikiHighlighterOptions): ShikiHighlighterAPI {
	const [isReady, setIsReady] = useState(false);
	const cacheRef = useRef<Map<number, string>>(new Map());
	const highlighterRef = useRef<Highlighter | null>(null);
	const langRef = useRef<BundledLanguage | null>(null);

	// Detect language from file path
	const language = getLanguageFromPath(filePath);

	// Initialize highlighter
	useEffect(() => {
		if (!enabled || !language) {
			setIsReady(true); // Ready but won't highlight
			return;
		}

		let cancelled = false;

		async function init() {
			try {
				const hl = await getHighlighter();
				if (cancelled) return;

				// Load language if not already loaded
				if (!loadedLanguages.has(language!)) {
					await hl.loadLanguage(language!);
					loadedLanguages.add(language!);
				}

				highlighterRef.current = hl;
				langRef.current = language;
				setIsReady(true);
			} catch (err) {
				console.warn("Failed to initialize Shiki highlighter:", err);
				setIsReady(true); // Continue without highlighting
			}
		}

		init();

		return () => {
			cancelled = true;
		};
	}, [enabled, language]);

	// Highlight visible lines when range changes
	useEffect(() => {
		if (!isReady || !highlighterRef.current || !langRef.current) return;

		const [start, end] = visibleRange;
		const hl = highlighterRef.current;
		const lang = langRef.current;

		// Highlight lines that aren't cached yet
		for (let i = start; i <= end && i < lines.length; i++) {
			if (cacheRef.current.has(i)) continue;

			const line = lines[i];
			if (!line) continue;

			try {
				// Highlight single line
				const html = hl.codeToHtml(line, {
					lang,
					theme,
				});

				// Extract just the inner content (remove pre/code wrapper)
				const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
				const innerHtml = match?.[1] ?? escapeHtml(line);

				// Remove the span wrapper around the whole line if present
				const cleaned = innerHtml
					.replace(/<span class="line">([\s\S]*?)<\/span>/, "$1")
					.trim();

				cacheRef.current.set(i, cleaned || escapeHtml(line));
			} catch {
				cacheRef.current.set(i, escapeHtml(line));
			}
		}
	}, [isReady, visibleRange, lines, theme]);

	// Clear cache when lines change significantly
	useEffect(() => {
		cacheRef.current.clear();
	}, [filePath]);

	const getHighlightedLine = useCallback(
		(lineIdx: number): string => {
			const cached = cacheRef.current.get(lineIdx);
			if (cached) return cached;

			// Return escaped plain text if not yet highlighted
			return escapeHtml(lines[lineIdx] ?? "");
		},
		[lines]
	);

	return {
		getHighlightedLine,
		isReady,
		language,
	};
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Simple hook for highlighting small code snippets (like chat diffs)
 * Unlike useShikiHighlighter, this highlights all lines at once since
 * chat diffs are typically small.
 */
export function useShikiSnippet(
	lines: string[],
	filePath: string,
	enabled = true
): { highlighted: Map<number, string>; isReady: boolean } {
	const [highlighted, setHighlighted] = useState<Map<number, string>>(
		new Map()
	);
	const [isReady, setIsReady] = useState(false);
	const linesRef = useRef<string[]>([]);

	const language = getLanguageFromPath(filePath);

	useEffect(() => {
		// Only re-highlight if lines actually changed
		const linesChanged =
			lines.length !== linesRef.current.length ||
			lines.some((l, i) => l !== linesRef.current[i]);

		if (!linesChanged && isReady) return;
		linesRef.current = lines;

		if (!enabled || !language || lines.length === 0) {
			setIsReady(true);
			return;
		}

		let cancelled = false;

		async function highlight() {
			try {
				const hl = await getHighlighter();
				if (cancelled) return;

				// Load language if needed
				if (!loadedLanguages.has(language!)) {
					await hl.loadLanguage(language!);
					loadedLanguages.add(language!);
				}

				if (cancelled) return;

				const result = new Map<number, string>();

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (!line) {
						result.set(i, "");
						continue;
					}

					try {
						const html = hl.codeToHtml(line, {
							lang: language!,
							theme: "github-dark-default",
						});

						// Extract inner content
						const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
						const innerHtml = match?.[1] ?? escapeHtml(line);
						const cleaned = innerHtml
							.replace(/<span class="line">([\s\S]*?)<\/span>/, "$1")
							.trim();

						result.set(i, cleaned || escapeHtml(line));
					} catch {
						result.set(i, escapeHtml(line));
					}
				}

				if (!cancelled) {
					setHighlighted(result);
					setIsReady(true);
				}
			} catch (err) {
				console.warn("Failed to highlight snippet:", err);
				if (!cancelled) {
					setIsReady(true);
				}
			}
		}

		highlight();

		return () => {
			cancelled = true;
		};
	}, [lines, language, enabled, isReady]);

	return { highlighted, isReady };
}
