// J2 Minor 3 (pc2-xtab-r6 verdict): a refetch that throws after a
// matching read must not leave the green "live re-read matches" badge.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLiveQuery } from "./hooks";
import { bondBadge, type LiveMinerBond } from "./minerBond";

const match: LiveMinerBond = {
  registrationBond: 1_500_000n,
  quoteForIntents: 1_500_000n,
  matchesConstant: true,
};

describe("bondBadge", () => {
  it("shows matches only for a settled, error-free matching read", () => {
    expect(bondBadge({ data: match, error: null, loading: false })).toEqual({
      tone: "ok",
      text: "live re-read matches",
    });
  });

  it("clears to UNVERIFIED when the latest read threw, even with earlier data", () => {
    const b = bondBadge({ data: match, error: new Error("HTTP 503"), loading: false });
    expect(b.tone).not.toBe("ok");
    expect(b.text).toBe("live re-read failed (HTTP 503) — UNVERIFIED");
  });

  it("does not keep the green badge while a re-read is in flight", () => {
    expect(bondBadge({ data: match, error: null, loading: true })).toEqual({
      tone: "dim",
      text: "re-reading on-chain…",
    });
  });

  it("reports a mismatch with both live values", () => {
    const b = bondBadge({
      data: { registrationBond: 1_870_000n, quoteForIntents: 2_010_000n, matchesConstant: false },
      error: null,
      loading: false,
    });
    expect(b.tone).toBe("err");
    expect(b.text).toContain("$1.87");
    expect(b.text).toContain("$2.01");
  });

  it("useLiveQuery: match, then a refetch that throws -> UNVERIFIED (J2 sequence)", async () => {
    let call = 0;
    const fetcher = async (): Promise<LiveMinerBond> => {
      call += 1;
      if (call === 1) return match;
      throw new Error("RPC down");
    };
    const { result } = renderHook(() => useLiveQuery("bond-badge-test", fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(bondBadge(result.current).text).toBe("live re-read matches");
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    // The stale data is still there (stale-while-refetching) …
    expect(result.current.data).toEqual(match);
    // … but the badge no longer says it matches.
    expect(bondBadge(result.current).text).toBe("live re-read failed (RPC down) — UNVERIFIED");
  });
});
