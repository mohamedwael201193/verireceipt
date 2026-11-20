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
