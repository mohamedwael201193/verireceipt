import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHealth, useLiveQuery } from "./hooks";

describe("useLiveQuery", () => {
  it("returns data after the fetcher resolves", async () => {
    const fetcher = vi.fn().mockResolvedValue("hello");
    const { result } = renderHook(() => useLiveQuery("k1", fetcher));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe("hello");
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("captures fetcher errors", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useLiveQuery("k2", fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error?.message).toBe("boom");
  });

  it("refetch calls the fetcher again", async () => {
    const fetcher = vi.fn().mockResolvedValue("v1");
    const { result } = renderHook(() => useLiveQuery("k3", fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetcher.mockResolvedValue("v2");
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toBe("v2"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts the in-flight fetch on unmount (J2 M4)", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn().mockImplementation((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {
        // Never resolves: unmount is the only way out.
      });
    });
    const { unmount } = renderHook(() => useLiveQuery("k-abort-unmount", fetcher));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("aborts the previous fetch on refetch (J2 M4)", async () => {
    const signals: AbortSignal[] = [];
    let resolveFirst!: (v: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const fetcher = vi.fn().mockImplementation((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? first : Promise.resolve("v2");
    });
    const { result } = renderHook(() => useLiveQuery("k-abort-refetch", fetcher));
    expect(result.current.loading).toBe(true);
    act(() => {
      result.current.refetch();
    });
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await waitFor(() => expect(result.current.data).toBe("v2"));
    expect(result.current.error).toBeNull();
    // Resolving the stale first fetch afterwards must not overwrite v2.
    act(() => {
      resolveFirst("stale-v1");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe("v2");
  });

  it("does not surface an aborted fetch as an error (J2 M4)", async () => {
    const fetcher = vi.fn().mockImplementation((signal: AbortSignal) => {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const { result } = renderHook(() => useLiveQuery("k-abort-error", fetcher));
    fetcher.mockResolvedValue("after-refetch");
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toBe("after-refetch"));
    expect(result.current.error).toBeNull();
  });

  it("captures a synchronously-throwing fetcher in error state (J2 M5)", async () => {
    const fetcher = () => {
      throw new Error("sync boom");
    };
    const { result } = renderHook(() => useLiveQuery("k-sync-throw", fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("sync boom");
    expect(result.current.data).toBeNull();
  });

  it("keeps stale data visible while refetching (J2 M9)", async () => {
    let resolveSecond!: (v: string) => void;
    const second = new Promise<string>((resolve) => {
      resolveSecond = resolve;
    });
    const fetcher = vi.fn().mockImplementation(() => {
      return fetcher.mock.calls.length === 1
        ? Promise.resolve("v1")
        : second;
    });
    const { result } = renderHook(() => useLiveQuery("k-stale", fetcher));
    await waitFor(() => expect(result.current.data).toBe("v1"));
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.loading).toBe(true));
    // Previous result stays visible while the refetch is in flight.
    expect(result.current.data).toBe("v1");
    expect(result.current.error).toBeNull();
    act(() => {
      resolveSecond("v2");
    });
    await waitFor(() => expect(result.current.data).toBe("v2"));
  });
});

describe("useHealth", () => {
  it("fetches /api/health through the shared hook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "ok", service: "verireceipt", uptime_s: 10, upstreams: {} }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { result } = renderHook(() => useHealth());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data?.status).toBe("ok");
      expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.any(Object));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
