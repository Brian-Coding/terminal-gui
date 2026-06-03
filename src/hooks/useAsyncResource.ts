import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Generic async resource hook. Tracks loading/error state for an arbitrary
 * fetcher and re-runs whenever `deps` change. Return `null` from `fetcher`
 * to indicate "no input yet" (skips loading state).
 */
export function useAsyncResource<T>(
	fetcher: () => Promise<T> | null,
	initial: T
) {
	const [data, setData] = useState<T>(initial);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const initialRef = useRef(initial);

	initialRef.current = initial;

	const refresh = useCallback(async () => {
		const promise = fetcher();
		if (!promise) {
			setData(initialRef.current);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setData(await promise);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			setData(initialRef.current);
		} finally {
			setLoading(false);
		}
	}, [fetcher]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return { data, setData, loading, error, refresh };
}
