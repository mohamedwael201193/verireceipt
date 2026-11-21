import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { auditLinks, DESK_PURCHASES, type DeskPurchase } from "../../lib/deskPurchases";
import EscrowPurchases from "./EscrowPurchases";
import { shortHash } from "./utils";

describe("EscrowPurchases panel", () => {
  it("renders every committed purchase with its Telegraph receipt and VeriReceipt receipt", () => {
    render(<MemoryRouter><EscrowPurchases /></MemoryRouter>);
    for (const p of DESK_PURCHASES) {
      const link = screen.getByText(p.miner_receipt!.receipt_id);
      expect(link.getAttribute("href")).toBe(`/receipts/${p.miner_receipt!.receipt_id}`);
      expect(screen.getByTitle(p.telegraph_receipt.receipt_hash)).toBeTruthy();
    }
    expect(screen.getAllByText("VERIFIED").length).toBe(DESK_PURCHASES.filter((p) => p.verdict === "VERIFIED").length);
  });
  it("shows the empty state honestly", () => {
    render(<MemoryRouter><EscrowPurchases rows={[]} /></MemoryRouter>);
    expect(screen.getByText("No escrow purchases recorded.")).toBeTruthy();
  });
  it("Re-hash reports UNVERIFIED (never MATCH) when the raw fetch fails", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("gone", { status: 404 }));
    render(<MemoryRouter><EscrowPurchases rows={[DESK_PURCHASES[0]]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Re-hash" }));
    expect(await screen.findByText(/UNVERIFIED \(HTTP 404\)/)).toBeTruthy();
    expect(spy).toHaveBeenCalledWith(`/api/receipts/${DESK_PURCHASES[0].miner_receipt!.receipt_id}/raw`, { cache: "no-store" });
    spy.mockRestore();
  });

  it("Epochs KPI says charged in these ledger roots for the committed included proofs", () => {
    const e31 = DESK_PURCHASES.filter((p) => p.telegraph_receipt.epoch_id === 31);
    render(<MemoryRouter><EscrowPurchases rows={e31} /></MemoryRouter>);
    expect(screen.getByText("charged in these ledger roots")).toBeTruthy();
    expect(screen.getAllByText("#31 · included")).toHaveLength(3);
  });
  it("Epochs KPI does not say charged when a supplied row is still pending", () => {
    const pending: DeskPurchase = { ...DESK_PURCHASES[0], delivery_proof: null };
    render(<MemoryRouter><EscrowPurchases rows={[pending]} /></MemoryRouter>);
    expect(screen.getByText("pending epoch submission; billed in ledger root once recorded")).toBeTruthy();
    expect(screen.queryByText("charged in these ledger roots")).toBeNull();
  });
  it("Epochs KPI says charged in these ledger roots only when every delivery is included", () => {
    const included: DeskPurchase = {
      ...DESK_PURCHASES[0],
      delivery_proof: { status: "included", checked_at: "2026-11-21T00:00:00Z", deliveries_root: "0x" + "ab".repeat(32) },
    };
    render(<MemoryRouter><EscrowPurchases rows={[included]} /></MemoryRouter>);
    expect(screen.getByText("charged in these ledger roots")).toBeTruthy();
    expect(screen.getByText(`#${included.telegraph_receipt.epoch_id} · included`)).toBeTruthy();
  });
  it("shows a delivery error as error, not pending", () => {
    const err: DeskPurchase = {
      ...DESK_PURCHASES[0],
      delivery_proof: { status: "error", checked_at: "2026-11-21T00:00:00Z" },
    };
    render(<MemoryRouter><EscrowPurchases rows={[err]} /></MemoryRouter>);
    expect(screen.getByText(`#${err.telegraph_receipt.epoch_id} · error`)).toBeTruthy();
    expect(screen.queryByText(`#${err.telegraph_receipt.epoch_id} · pending`)).toBeNull();
    expect(screen.getByText("delivery error; not charged in a recorded ledger root")).toBeTruthy();
  });
  it("does not show VERIFIED or increment the KPI when checks failed or the sha drifted", () => {
    const bad: DeskPurchase = {
      ...DESK_PURCHASES[0],
      checks: [{ name: "sha256(stored raw bytes) = raw_response_sha256", ok: false, detail: "no" }],
      raw_sha256_recomputed: "0".repeat(64),
    };
    render(<MemoryRouter><EscrowPurchases rows={[bad]} /></MemoryRouter>);
    expect(screen.queryByText("VERIFIED")).toBeNull();
    expect(screen.getByText("UNVERIFIED")).toBeTruthy();
    const lbl = screen.getByText("Verified End-to-End");
    expect(lbl.nextElementSibling?.textContent).toBe("0");
  });
  it("renders receipt_hash as plain text and labels the signal link as signal", () => {
    render(<MemoryRouter><EscrowPurchases rows={[DESK_PURCHASES[0]]} /></MemoryRouter>);
    const p = DESK_PURCHASES[0];
    const cell = screen.getByTitle(p.telegraph_receipt.receipt_hash);
    expect(cell.tagName).toBe("TD");
    expect(cell.textContent).toContain(shortHash(p.telegraph_receipt.receipt_hash));
    const signal = screen.getByRole("link", { name: "signal" });
    expect(signal.getAttribute("href")).toBe(auditLinks(p).signal);
    expect(signal.textContent).toBe("signal");
    expect(signal.textContent).not.toContain(shortHash(p.telegraph_receipt.receipt_hash));
    const delivery = screen.getByRole("link", { name: `#${p.telegraph_receipt.epoch_id} · included` });
    expect(delivery.getAttribute("href")).toBe(auditLinks(p).delivery);
  });

  it("intro copy uses billed-once tense, not present-tense 'is charged' (J2 Minor 3)", () => {
    render(<MemoryRouter><EscrowPurchases /></MemoryRouter>);
    expect(screen.getByText(/is billed in its epoch's ledger root once that block is recorded/)).toBeTruthy();
    expect(screen.queryByText(/each call is charged in its epoch/)).toBeNull();
  });
  it("renders an unknown delivery status as unknown, not pending", () => {
    const bogus: DeskPurchase = {
      ...DESK_PURCHASES[0],
      delivery_proof: { status: "bogus", checked_at: "2026-11-21T00:00:00Z" },
    };
    render(<MemoryRouter><EscrowPurchases rows={[bogus]} /></MemoryRouter>);
    expect(screen.getByText(`#${bogus.telegraph_receipt.epoch_id} · unknown`)).toBeTruthy();
    expect(screen.queryByText(`#${bogus.telegraph_receipt.epoch_id} · pending`)).toBeNull();
  });
  it("a bad ledger export takes down only the panel, not the host (J2 Minor 5)", () => {
    render(<MemoryRouter><EscrowPurchases rows={[]} loadError="deskPurchases.json marks a record VERIFIED without the full expected check set or a matching sha" /></MemoryRouter>);
    expect(screen.getByRole("alert").textContent).toMatch(/could not load the committed ledger/);
    expect(screen.getByText("No escrow purchases recorded.")).toBeTruthy();
    expect(screen.getByText("Escrow")).toBeTruthy();
  });
});

  it("shows recovered values labelled as recovered from hash-verified raw, not as node-ok", () => {
    render(<MemoryRouter><EscrowPurchases rows={[DESK_PURCHASES[0]]} /></MemoryRouter>);
    expect(screen.getByText("node_or_zone: TH_NP15_GEN-APND")).toBeTruthy();
    expect(screen.getByText("market: CAISO")).toBeTruthy();
    expect(screen.getAllByText("recovered from hash-verified raw").length).toBe(1);
    expect(screen.queryByText(/node marked them ok|parser answered/i)).toBeNull();
  });
  it("does not show recovered values for an UNVERIFIED row", () => {
    const u = { ...DESK_PURCHASES[0], verdict: "UNVERIFIED" as const, checks: [{ name: "x", ok: false, detail: "no" }] };
    render(<MemoryRouter><EscrowPurchases rows={[u]} /></MemoryRouter>);
    expect(screen.queryByText("recovered from hash-verified raw")).toBeNull();
    expect(screen.queryByText("market: CAISO")).toBeNull();
  });

describe("EscrowPurchases value units", () => {
  it("labels each intent's value in its own unit, never USD/MWh outside GRID", () => {
    render(<MemoryRouter><EscrowPurchases /></MemoryRouter>);
    for (const p of DESK_PURCHASES) {
      if (p.value_field === "lmp_usd_per_mwh") continue;
      expect(screen.queryByText(new RegExp(`^${p.value} USD/MWh`))).toBeNull();
    }
    const tx = DESK_PURCHASES.find((p) => p.value_field === "block_number");
    if (tx) expect(screen.getAllByText(new RegExp(`block ${tx.value}`)).length).toBeGreaterThan(0);
    const v = DESK_PURCHASES.find((p) => p.value_field === "effective_balance");
    if (v) expect(screen.getAllByText(new RegExp(`${v.value} gwei`)).length).toBeGreaterThan(0);
  });
});
