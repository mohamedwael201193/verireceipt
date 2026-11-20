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
 * loading / data / error states. The fetcher is held in a ref so an
 * inline arrow function does not re-trigger the effect on every render.
 */
export function useLiveQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
): LiveQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  const refetch = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  return { data, error, loading, refetch };
}

export function useHealth(): LiveQueryResult<HealthResponse> {
  return useLiveQuery<HealthResponse>("health", getHealth);
}
