// ReceiptDrawer verification_mode gate + per-intent method tests
// (round-2 FIX A: J1-F1 / J2-F4; round-3 N1/F1 + S2 + F3).
//
// Round-2 gate: the drawer is the same upstream re-fetch pattern F8
// removed from VerifyPanel, surviving verbatim in the shipped Dashboard
// surface: it fetched receipt.upstream_url and hashed the bytes with NO
// endpoint/mode branching, rendering a green "BIT-EXACT MATCH
// VERIFIED ✓" badge for ANY intent — including snapshot filings/tvl
// receipts, where a live re-fetch can never reproduce the fetch-time
// bytes and a match/mismatch proves nothing either way.
//
// Gate (exactly like VerifyPanel): tx/grid are immutable_live_recheck
// constructions by method, so the drawer keeps the re-fetch button and
// the MATCH/MISMATCH verdict for them; snapshot_raw_digest receipts
// (filings/tvl/route, label absent or snapshot) get NO re-fetch button
// and NO verdict — an informational label only. The global fetch is
// stubbed (no network); the hash oracle is the standard SHA-256
// vector for "abc".
//
// Round-3 N1/F1: the old tests stubbed fetch to return "abc" bytes for
// ANY method/URL, which masked the drawer hashing the wrong bytes in
// production (a plain GET of the RPC URL for tx, zip bytes for grid,
// an RPC URL for route). These tests now assert the METHOD per intent:
// tx must POST the exact JSON-RPC replay, grid must rebuild the
// canonical evidence JSON with NO fetch at all, route must offer no
// button even with an immutable label, and a mismatch must never
// assert "the upstream bytes changed" for a case where the drawer
// hashed the wrong bytes.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReceiptDrawer from "./ReceiptDrawer";
import type { LiveReceipt, Receipt } from "./types";
import { toLiveReceipt } from "./utils";

const ABC_SHA =
  "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

// SHA-256 of the canonical grid evidence JSON for the fields below:
// JSON.stringify({node_or_zone:"TH_NP15_GEN-APND",
//   interval_start:"2026-11-20T06:00:00Z", lmp_usd_per_mwh:38.09,
//   market:"DAM"}) — computed with node:crypto, not by the code under
// test, so a match proves the drawer rebuilt the same canonical JSON.
const GRID_SHA =
  "0xc0e7cf6d7c838e390c08f3067d6e87e49f7cf15d86b6192f1275d4c6a8fd9e28";

const TX_HASH =
  "0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902";

const GRID_FIELDS = {
  node_or_zone: "TH_NP15_GEN-APND",
  interval_start: "2026-11-20T06:00:00Z",
  lmp_usd_per_mwh: 38.09,
  market: "DAM",
};

function bytesOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function drawerReceipt(
  intent: string,
  receiptOverrides: Partial<Receipt> = {},
  bodyOverrides: Record<string, unknown> = {},
): LiveReceipt {
  const receipt: Receipt = {
    receipt_id: "rcpt_TEST00000000000000000001",
    intent,
    upstream_url: "https://example.com/upstream",
    raw_response_sha256: ABC_SHA,
    quorum_votes: "3/3 sources agreed",
    fetched_at: "2026-11-20T07:00:00.000Z",
    audit_url: "https://example.com/receipts/rcpt_TEST00000000000000000001",
    ...receiptOverrides,
  };
  return toLiveReceipt(intent, "q", "https://example.com", {
    ok: true,
    body: { receipt, ...bodyOverrides },
    receipt,
    latencyMs: 42,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ReceiptDrawer verification_mode gate", () => {
  it("snapshot tvl receipt (no label = snapshot default): NO re-fetch button, informational label, no verdict", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("TVL_LOOKUP_GENERAL")}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recompute SHA-256 in Browser" }),
    ).toBeNull();
    expect(screen.getByText(/never a verification verdict/i)).toBeTruthy();
    expect(screen.getByText(/snapshot_raw_digest/)).toBeTruthy();
    expect(screen.queryByText(/BIT-EXACT MATCH VERIFIED/)).toBeNull();
    expect(screen.queryByText(/DIGEST MISMATCH/)).toBeNull();
    // No fetch is attempted: there is no button to click, and the
    // drawer must not re-fetch upstream on render either.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("snapshot filings receipt (explicit label): same gate as tvl", () => {
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("REGULATORY_FILING_MONITOR_GENERAL", {
          verification_mode: "snapshot_raw_digest",
        })}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recompute SHA-256 in Browser" }),
    ).toBeNull();
    expect(screen.getByText(/never a verification verdict/i)).toBeTruthy();
    expect(screen.queryByText(/BIT-EXACT MATCH VERIFIED/)).toBeNull();
  });

  it("snapshot route receipt: same gate (route is not an immutable construction)", () => {
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("OPTIMAL_EXECUTION_ROUTE_GENERAL")}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recompute SHA-256 in Browser" }),
    ).toBeNull();
    expect(screen.getByText(/never a verification verdict/i)).toBeTruthy();
  });

  it("unknown intent with no label: gated (fail-closed to snapshot)", () => {
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("SOMETHING_ELSE_GENERAL")}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recompute SHA-256 in Browser" }),
    ).toBeNull();
  });

  it("tx receipt: replays the exact JSON-RPC call with POST and matching response bytes verify (round-3 N1/F1)", async () => {
    const showToast = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("ONCHAIN_TX_LOOKUP_GENERAL", {}, { tx_hash: TX_HASH })}
        onClose={() => undefined}
        showToast={showToast}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("BIT-EXACT MATCH VERIFIED ✓")).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith("SHA-256 bit-exact match verified in browser");
    // The METHOD is the assertion: a plain GET of the RPC URL can
    // never return the POST response bytes the miner hashed, so the
    // drawer must POST the exact JSON-RPC replay VerifyPanel uses.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/upstream");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [TX_HASH],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("tx receipt with a missing tx_hash: no fetch, unverifiable (cannot replay without the hash)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("ONCHAIN_TX_LOOKUP_GENERAL")}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("NOT VERIFIABLE FROM THIS BROWSER")).toBeTruthy();
    expect(screen.getByText(/transaction hash is missing/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tx receipt with an unsafe upstream URL: refused, nothing fetched (round-3 S2)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt(
          "ONCHAIN_TX_LOOKUP_GENERAL",
          { upstream_url: "http://example.com/upstream" },
          { tx_hash: TX_HASH },
        )}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("NOT VERIFIABLE FROM THIS BROWSER")).toBeTruthy();
    expect(screen.getByText(/not a safe https URL/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("grid receipt: canonical evidence rebuild verifies with NO fetch at all (round-3 N1/F1)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt(
          "GRID_POWER_PRICE_GENERAL",
          { raw_response_sha256: GRID_SHA },
          GRID_FIELDS,
        )}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("BIT-EXACT MATCH VERIFIED ✓")).toBeTruthy();
    expect(screen.getByText(/Canonical evidence re-hash/)).toBeTruthy();
    // The zip bytes were never hashed and must never be fetched: the
    // old code fetched upstream_url and hashed zip bytes, so a genuine
    // grid receipt deterministically showed a false DIGEST MISMATCH.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("grid receipt with a non-matching digest: DIGEST MISMATCH that never blames 'upstream bytes' (round-3 N1/F1)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("GRID_POWER_PRICE_GENERAL", {}, GRID_FIELDS)}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("DIGEST MISMATCH")).toBeTruthy();
    // The drawer hashed a canonical rebuild, not upstream bytes — the
    // badge text must never assert "the upstream bytes changed" for a
    // case where it hashed the wrong bytes (or no upstream bytes).
    expect(screen.queryByText(/upstream bytes changed/i)).toBeNull();
    expect(screen.getByText(/Canonical evidence re-hash/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("grid receipt with missing evidence fields: no fetch, unverifiable", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("GRID_POWER_PRICE_GENERAL")}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("NOT VERIFIABLE FROM THIS BROWSER")).toBeTruthy();
    expect(screen.getByText(/evidence fields.*missing/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("grid receipt with missing evidence fields: NO curl/zip terminal hint — no terminal re-check is possible (round-4 F3)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("GRID_POWER_PRICE_GENERAL", {
          upstream_url: "https://example.com/caiso.zip",
        })}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("NOT VERIFIABLE FROM THIS BROWSER")).toBeTruthy();
    expect(screen.getByText(/evidence fields.*missing/i)).toBeTruthy();
    // The old fallback curled the CAISO zip — the exact bytes the
    // miner never hashed — so a judge following it got a deterministic
    // false mismatch. No terminal command may be shown at all here.
    expect(screen.queryByText(/curl -s "/)).toBeNull();
    // ".zip" legitimately appears in the drawer's UPSTREAM SOURCE URL
    // panel — the bug was the curl COMMAND fetching it, so assert the
    // terminal-hint block itself is gone, not the URL text.
    expect(screen.queryByText(/Verify from a terminal instead/i)).toBeNull();
    expect(screen.queryByText(/sha256sum/)).toBeNull();
    expect(screen.getByText(/No terminal re-check is possible/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("grid receipt with a wrong-typed lmp (string, not number): same — NOT VERIFIABLE, no curl hint (round-4 F3)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt(
          "GRID_POWER_PRICE_GENERAL",
          { upstream_url: "https://example.com/caiso.zip" },
          { ...GRID_FIELDS, lmp_usd_per_mwh: "38.09" },
        )}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("NOT VERIFIABLE FROM THIS BROWSER")).toBeTruthy();
    expect(screen.getByText(/evidence fields.*missing/i)).toBeTruthy();
    expect(screen.queryByText(/curl -s "/)).toBeNull();
    // ".zip" legitimately appears in the drawer's UPSTREAM SOURCE URL
    // panel — the bug was the curl COMMAND fetching it, so assert the
    // terminal-hint block itself is gone, not the URL text.
    expect(screen.queryByText(/Verify from a terminal instead/i)).toBeNull();
    expect(screen.queryByText(/sha256sum/)).toBeNull();
    expect(screen.getByText(/No terminal re-check is possible/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("route receipt WITH an immutable label: still no button, not reproducible (round-3 S2)", () => {
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("OPTIMAL_EXECUTION_ROUTE_GENERAL", {
          verification_mode: "immutable_live_recheck",
        })}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recompute SHA-256 in Browser" }),
    ).toBeNull();
    expect(screen.getByText(/not reproducible in browser/i)).toBeTruthy();
    expect(screen.getByText(/never a verification verdict/i)).toBeTruthy();
    expect(screen.queryByText(/BIT-EXACT MATCH VERIFIED/)).toBeNull();
    expect(screen.queryByText(/DIGEST MISMATCH/)).toBeNull();
  });

  it("immutable_live_recheck tvl receipt: GET re-fetch button exists and a match verifies", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <ReceiptDrawer
        receipt={drawerReceipt("TVL_LOOKUP_GENERAL", {
          verification_mode: "immutable_live_recheck",
        })}
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
    expect(await screen.findByText("BIT-EXACT MATCH VERIFIED ✓")).toBeTruthy();
    // tvl/filings with an immutable label ARE a plain GET re-fetch —
    // the only intents where that is the miner's method.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/upstream");
    expect(init.method === undefined || init.method === "GET").toBe(true);
  });

  it("a hanging arrayBuffer() fails closed within the 45s budget, never stuck on 'Fetching upstream…' (round-3 F3)", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: () => new Promise(() => {}),
        }),
      );
      render(
        <ReceiptDrawer
          receipt={drawerReceipt("ONCHAIN_TX_LOOKUP_GENERAL", {}, { tx_hash: TX_HASH })}
          onClose={() => undefined}
          showToast={() => undefined}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }));
      expect(screen.getByText("Fetching upstream…")).toBeTruthy();
      // The 45s timer fires a state update from a promise continuation,
      // outside fireEvent's act() — wrap the advance in act() so React
      // flushes the resulting render before the assertions run.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(screen.getByText("NOT VERIFIABLE FROM THIS BROWSER")).toBeTruthy();
      expect(screen.getByText(/timed out after 45s/i)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Recompute SHA-256 in Browser" }),
      ).toBeTruthy();
      expect(screen.queryByText("Fetching upstream…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
