// J1 regression test: the VerifyBadge steady state for the EXPECTED
// digest mismatch (envelope bytes vs upstream receipt bytes) must be
// NEUTRAL — it is not a failed verification, and the old amber
// "DIGESTS DIFFER — SEE NOTE" badge read as one. MATCH VERIFIED still
// appears only on a real byte-exact match.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyBadge } from "./VerifyBadge";

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
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => rawText }));
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

    fireEvent.click(screen.getByRole("button", { name: "Verify in browser" }));

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
});
