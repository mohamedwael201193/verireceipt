// J1 regression test: the VerifyBadge steady state for the EXPECTED
// digest mismatch (envelope bytes vs upstream receipt bytes) must be
// NEUTRAL — it is not a failed verification, and the old amber
// "DIGESTS DIFFER — SEE NOTE" badge read as one. MATCH VERIFIED still
// appears only on a real byte-exact match.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { VerifyBadge } from "./VerifyBadge";
import { fetchAndVerify } from "./verify";

const RECORDED_DIGEST = "b".repeat(64);

function mockEnvelope() {
  const body = {
    tx_hash: "0x8c3f442fc6d640a6ff3ea0b12be64f1d4609ea94edd2966f42c01cd9bdcf04b5",
    status: "confirmed",
    receipt: {
      receipt_id: "rcpt-test-1",
      upstream_url: "https://example.com/upstream",
      raw_response_sha256: RECORDED_DIGEST,
      fetched_at: "2026-11-20T00:00:00Z",
    },
  };
  const rawText = JSON.stringify(body);
  // Real Response (J2 R2 M5): the old hand-rolled {ok, status, text}
  // stub had no headers and contradicted the "all mocks are real
  // Response" claim — fetchAndVerify never reads headers, but the stub
  // should still be a real Response.
  const fetchMock = vi.fn(async () => new Response(rawText, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, rawText };
}

describe("VerifyBadge — neutral steady state (J1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a neutral (not warning-styled) envelope digest when the digests differ", async () => {
    mockEnvelope();
    const { container } = render(
      <VerifyBadge url="/api/v1/tx?tx_hash=0x8c3f442fc6d640a6ff3ea0b12be64f1d4609ea94edd2966f42c01cd9bdcf04b5&chain=ethereum" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Compute envelope digest" }));

    await waitFor(() =>
      expect(
        screen.getByText("ENVELOPE DIGEST — NOT COMPARABLE TO UPSTREAM RECEIPT"),
      ).toBeInTheDocument(),
    );
    // Neutral presentation: no warning styling anywhere, no failure copy.
    expect(container.querySelector(".b-warn")).toBeNull();
    expect(screen.queryByText("DIGESTS DIFFER — SEE NOTE")).toBeNull();
    expect(screen.queryByText(/MATCH VERIFIED/)).toBeNull();
    // …but the recorded digest and the truthful explanation are still shown.
    expect(screen.getByText(RECORDED_DIGEST)).toBeInTheDocument();
    expect(screen.getByText(/not expected to be equal/)).toBeInTheDocument();
  });

  it("budgets 45s for cold starts — still pending at 20s, TIMEOUT at 45s (J2 minor 2)", async () => {
    // The old 20 s budget timed the badge out on every cold start (J2
    // measured live cold starts of 25–56 s) while the 45 s data path
    // beside it loaded fine. A fetch that hangs until its signal aborts
    // must stay pending past 20 s and fail only at 45 s.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string, opts?: { signal?: AbortSignal }) => {
        return new Promise<never>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      let settled = false;
      let failure: unknown = null;
      const p = fetchAndVerify("/api/v1/tx?tx_hash=0x00&chain=ethereum").then(
        () => {
          settled = true;
        },
        (e) => {
          settled = true;
          failure = e;
        },
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(25_000);
      await p;
      expect(settled).toBe(true);
      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).code).toBe("TIMEOUT");
      expect((failure as ApiError).message).toContain("45s");
    } finally {
      vi.useRealTimers();
    }
  });
});
