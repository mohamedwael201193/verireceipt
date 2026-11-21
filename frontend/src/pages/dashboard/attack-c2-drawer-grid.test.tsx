// J2 attack-c2-drawer-grid (P-C2 / N2): a grid receipt whose digest
// matches the canonical evidence JSON, verified only via live_recheck
// (stored /raw unavailable), must NOT show an unqualified
// "BIT-EXACT MATCH VERIFIED" or toast a bare bit-exact match.
// The drawer must name the live re-check and caveat that it re-hashes
// fields already in the receipt.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../lib/receipt";
import type { Receipt } from "../../lib/types";
import ReceiptDrawer from "./ReceiptDrawer";
import { toLiveReceipt } from "./utils";

const GRID_FIELDS = {
  node_or_zone: "TH_NP15_GEN-APND",
  interval_start: "2026-11-20T05:00:00.000Z",
  lmp_usd_per_mwh: 36.74434,
  market: "DAM",
};

describe("attack-c2-drawer-grid (N2 caveat)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("grid + live_recheck match is caveated; toast is qualified; no BIT-EXACT MATCH VERIFIED", async () => {
    const canonical = JSON.stringify(GRID_FIELDS);
    const digest = `0x${await sha256Hex(canonical)}`;
    const rcpt: Receipt = {
      receipt_id: "rcpt_grid_c2_n2",
      upstream_url: "https://oasis.caiso.com/oasisapi/SingleZip",
      raw_response_sha256: digest,
      fetched_at: "2026-11-20T06:00:00.000Z",
    };
    const live = toLiveReceipt(
      "GRID_POWER_PRICE_GENERAL",
      "TH_NP15_GEN-APND · 2026-11-20T05:00:00.000Z",
      "https://verireceipt.onrender.com/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T05%3A00%3A00.000Z",
      {
        ok: true,
        body: { ...GRID_FIELDS, currency: "USD" },
        receipt: rcpt,
        latencyMs: 12,
        ledgerGenAtStart: 0,
      },
    );

    const toasts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // /raw is unavailable — force the live_recheck path.
        if (String(url).includes("/api/receipts/") && String(url).includes("/raw")) {
          return new Response("not found", { status: 404 });
        }
        return new Response("unexpected fetch " + url, { status: 500 });
      }),
    );

    render(<ReceiptDrawer receipt={live} onClose={() => undefined} showToast={(m) => toasts.push(m)} />);
    fireEvent.click(screen.getByRole("button", { name: /Recompute SHA-256 in Browser/ }));

    await waitFor(() => {
      expect(screen.getByText(/HASH MATCHES STORED GRID FIELDS \(LIVE RE-CHECK\)/)).toBeTruthy();
    });
    expect(screen.queryByText("BIT-EXACT MATCH VERIFIED ✓")).toBeNull();
    expect(screen.queryByText(/BIT-EXACT MATCH — STORED RAW BYTES/)).toBeNull();
    expect(screen.getByText(/re-hashes the canonical evidence JSON already in this receipt/)).toBeTruthy();
    expect(screen.getByText(/mode live_recheck/)).toBeTruthy();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/live re-check/i);
    expect(toasts[0]).not.toMatch(/bit-exact match verified/i);
    // No unexpected upstream fetch should have been issued for CAISO.
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u: string) => u.includes("/api/receipts/") && u.includes("/raw"))).toBe(true);
    expect(urls.some((u: string) => u.includes("oasis.caiso.com"))).toBe(false);
  });
});
