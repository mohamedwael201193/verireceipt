import { useCallback, useEffect, useRef, useState } from "react";
import { getHealth } from "./api";
import type { HealthResponse } from "./types";

export interface LiveQueryResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Runs `fetcher` once per `key` (and on every refetch) and tracks the
 * loading / data / error states. The fetcher receives an AbortSignal: the
 * in-flight fetch is aborted on unmount and on refetch, so a slow
 * response can never overwrite a newer one.
 *
 * Stale-data-while-refetching is explicit: `data` is never cleared when a
 * refetch starts — the previous result stays visible with loading=true
 * until the new result (or error) lands.
 */
export function useLiveQuery<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
): LiveQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  // Never write a ref during render: sync it in an effect so the fetch
  // effect below always sees the latest fetcher.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    // data is intentionally NOT cleared here (stale-while-refetching).

    let outcome: Promise<T>;
    try {
      // A synchronously-throwing fetcher lands in error state, never
      // escapes the hook (or the render) as an uncaught exception.
      outcome = fetcherRef.current(controller.signal);
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setLoading(false);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    Promise.resolve(outcome)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        // Aborted by unmount/refetch: not an error, the newer run owns
        // the state now. (ApiError ABORTED from the api client is also
        // covered by the signal check.)
        if (cancelled || controller.signal.aborted) return;
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, nonce]);

  const refetch = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  return { data, error, loading, refetch };
}

export function useHealth(): LiveQueryResult<HealthResponse> {
  return useLiveQuery<HealthResponse>("health", (signal) => getHealth(signal));
}
