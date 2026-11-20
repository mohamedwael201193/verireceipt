// Tests for the VerifyBadge — the landing badge for THE ONE verifier
// (lib/verifyReceipt.ts, PLAN.md C2). The old envelope-digest badge
// (deleted with landing/verify.ts) could never verify anything: it
// hashed the miner envelope, which can never match the recorded
// upstream digest. These tests pin the real paths: raw_bytes first,
// live re-check while the miner does not serve /raw.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../lib/receipt";
import type { Receipt } from "../../lib/types";
import { VerifyBadge } from "./VerifyBadge";

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: "rcpt-test-1",
    upstream_url: "https://example.com/upstream",
    raw_response_sha256: "a".repeat(64),
    fetched_at: "2026-11-20T00:00:00Z",
    ...overrides,
  };
}

async function digestOf(body: string): Promise<string> {
  return `0x${await sha256Hex(body)}`;
}

describe("VerifyBadge (C2 — ONE verifier)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("raw MATCH: stored bytes hash to the recorded digest — MATCH VERIFIED + Stored raw bytes + evidence kind", async () => {
    const bytes = "the exact upstream bytes";
    const receipt = makeReceipt({ raw_response_sha256: await digestOf(bytes) });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bytes, { status: 200, headers: { "x-evidence-kind": "upstream" } }),
      ),
    );
    render(<VerifyBadge receipt={receipt} endpoint="filings" data={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    await waitFor(() =>
      expect(screen.getByText("SHA-256 MATCH VERIFIED ✓")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Stored raw bytes/)).toBeInTheDocument();
    expect(screen.getByText(/evidence: upstream/)).toBeInTheDocument();
  });

  it("raw 404 → tx fallback MATCH: JSON-RPC replay (live re-check)", async () => {
    const rpcText = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { blockNumber: "0x1" } });
    const receipt = makeReceipt({
      upstream_url: "https://rpc.example/tx",
      raw_response_sha256: await digestOf(rpcText),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/receipts/")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(rpcText, { status: 200 });
      }),
    );
    render(<VerifyBadge receipt={receipt} endpoint="tx" data={{ tx_hash: "0xabc" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    await waitFor(() =>
      expect(screen.getByText("SHA-256 MATCH VERIFIED ✓")).toBeInTheDocument(),
    );
    expect(screen.getByText(/JSON-RPC replay \(live re-check\)/)).toBeInTheDocument();
  });

  it("raw 404 → filings fallback MISMATCH names the live re-check path (not a tampering verdict)", async () => {
    const receipt = makeReceipt({ raw_response_sha256: await digestOf("miner bytes") });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/receipts/")) {
          return new Response("not found", { status: 404 });
        }
        return new Response("moved bytes", { status: 200 });
      }),
    );
    render(<VerifyBadge receipt={receipt} endpoint="filings" />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    await waitFor(() => expect(screen.getByText("DIGEST MISMATCH")).toBeInTheDocument());
    expect(screen.getByText(/upstream data can move/)).toBeInTheDocument();
    expect(screen.getByText(/Upstream re-fetch \(live re-check\)/)).toBeInTheDocument();
  });

  it("route with no /raw is NOT REPRODUCIBLE IN BROWSER", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    render(<VerifyBadge receipt={makeReceipt()} endpoint="route" />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    await waitFor(() =>
      expect(screen.getByText("NOT REPRODUCIBLE IN BROWSER")).toBeInTheDocument(),
    );
  });

  it("raw 404 + upstream 500 is COULD NOT VERIFY (not a mismatch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/receipts/")) {
          return new Response("not found", { status: 404 });
        }
        return new Response("error", { status: 500 });
      }),
    );
    render(<VerifyBadge receipt={makeReceipt()} endpoint="filings" />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    await waitFor(() =>
      expect(screen.getByText("COULD NOT VERIFY IN BROWSER")).toBeInTheDocument(),
    );
    expect(screen.queryByText("DIGEST MISMATCH")).toBeNull();
  });

  it("Re-verify runs the check again", async () => {
    const bytes = "bytes";
    const receipt = makeReceipt({ raw_response_sha256: await digestOf(bytes) });
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<VerifyBadge receipt={receipt} endpoint="filings" />);
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    await waitFor(() =>
      expect(screen.getByText("SHA-256 MATCH VERIFIED ✓")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Re-verify receipt" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

});
