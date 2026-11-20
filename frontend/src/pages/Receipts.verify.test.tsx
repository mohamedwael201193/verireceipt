// VerifyPanel verification_mode gate tests (J1-F1 / J2-F8).
//
// A snapshot_raw_digest receipt (the default — ALL five intents) must
// NEVER get an upstream re-fetch button or a MATCH / MISMATCH verdict:
// live upstream data has moved since fetch time, so a re-fetch proves
// nothing either way. Only immutable_live_recheck receipts (or the
// tx/grid deterministic constructions) may be verified by re-fetch.
// The global fetch is stubbed (no network); the hash oracle is the
// standard SHA-256 vector for "abc".

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyPanel } from "./Receipts";
import type { Receipt } from "../lib/types";

const ABC_SHA =
  "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function receiptWith(
  overrides: Partial<Receipt> = {},
): Receipt {
  return {
    receipt_id: "rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    upstream_url: "https://example.com/upstream",
    raw_response_sha256: ABC_SHA,
    fetched_at: "2026-11-20T16:25:57.739Z",
    audit_url: "https://verireceipt.onrender.com/receipts/rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ...overrides,
  };
}

function bytesOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VerifyPanel verification_mode gate", () => {
  it("snapshot tvl receipt: NO re-fetch button, informational label, no verdict possible", () => {
    render(<VerifyPanel receipt={receiptWith()} endpoint="tvl" />);
    expect(
      screen.queryByRole("button", { name: "Recompute SHA-256 in browser" }),
    ).toBeNull();
    expect(screen.getByText(/never a verification verdict/i)).toBeTruthy();
    expect(screen.getByText(/snapshot_raw_digest/)).toBeTruthy();
    expect(screen.queryByText(/SHA-256 MATCH VERIFIED/)).toBeNull();
    expect(screen.queryByText(/DIGEST MISMATCH/)).toBeNull();
    // The stored-bytes re-hash is still offered: it is the real path.
    expect(
      screen.getByRole("button", { name: "Recompute from stored bytes" }),
    ).toBeTruthy();
  });

  it("snapshot tvl receipt: even matching upstream bytes cannot produce a verdict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytesOf("abc"),
      }),
    );
    render(<VerifyPanel receipt={receiptWith()} endpoint="tvl" />);
    expect(
      screen.queryByRole("button", { name: "Recompute SHA-256 in browser" }),
    ).toBeNull();
    expect(screen.queryByText(/SHA-256 MATCH VERIFIED/)).toBeNull();
  });

  it("snapshot filings receipt: same gate as tvl", () => {
    render(<VerifyPanel receipt={receiptWith()} endpoint="filings" />);
    expect(
      screen.queryByRole("button", { name: "Recompute SHA-256 in browser" }),
    ).toBeNull();
    expect(screen.getByText(/never a verification verdict/i)).toBeTruthy();
  });

  it("immutable_live_recheck tvl receipt: re-fetch button exists and a match verifies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url === "https://example.com/upstream") {
          return { ok: true, status: 200, arrayBuffer: async () => bytesOf("abc") };
        }
        return { ok: false, status: 404, arrayBuffer: async () => bytesOf("") };
      }),
    );
    render(
      <VerifyPanel
        receipt={receiptWith({ verification_mode: "immutable_live_recheck" })}
        endpoint="tvl"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in browser" }));
    expect(await screen.findByText("SHA-256 MATCH VERIFIED ✓")).toBeTruthy();
  });

  it("tx endpoint: re-fetch button exists even for a snapshot-labelled receipt (deterministic replay)", () => {
    render(
      <VerifyPanel
        receipt={receiptWith()}
        endpoint="tx"
        data={{ tx_hash: "0x1234" }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Recompute SHA-256 in browser" }),
    ).toBeTruthy();
  });

  it("tx endpoint: the replay is a POST of the exact JSON-RPC call, never a plain GET (round-3 N1/F1)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <VerifyPanel
        receipt={receiptWith()}
        endpoint="tx"
        data={{ tx_hash: "0x1234" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in browser" }));
    expect(await screen.findByText("SHA-256 MATCH VERIFIED ✓")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/upstream");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: ["0x1234"],
    });
  });

  it("a hanging arrayBuffer() fails closed within the 45s budget, never stuck on 'Verifying…' (round-3 F3)", async () => {
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
        <VerifyPanel
          receipt={receiptWith()}
          endpoint="tx"
          data={{ tx_hash: "0x1234" }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in browser" }));
      // "Verifying…" appears twice while checking: the button label
      // (Receipts.tsx:588) and the status line (Receipts.tsx:615).
      expect(screen.getAllByText("Verifying…")).toHaveLength(2);
      // The 45s timer fires a state update from a promise continuation,
      // outside fireEvent's act() — wrap the advance in act() so React
      // flushes the resulting render before the assertions run.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(screen.getByText("COULD NOT VERIFY IN BROWSER")).toBeTruthy();
      expect(screen.getByText(/timed out after 45s/i)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Recompute SHA-256 in browser" }),
      ).toBeTruthy();
      expect(screen.queryAllByText("Verifying…")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cancel aborts an in-flight check promptly and returns to idle (round-3 F3)", async () => {
    // A fetch that never settles and ignores the signal: Cancel must
    // still resolve the panel — the abort race, not the fetch, ends it.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {})));
    render(
      <VerifyPanel
        receipt={receiptWith()}
        endpoint="tx"
        data={{ tx_hash: "0x1234" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute SHA-256 in browser" }));
    // "Verifying…" appears twice while checking: the button label and
    // the status line (see the hanging-arrayBuffer test above).
    expect(screen.getAllByText("Verifying…")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("button", { name: "Recompute SHA-256 in browser" }),
    ).toBeTruthy();
    expect(screen.queryAllByText("Verifying…")).toHaveLength(0);
    expect(screen.queryByText("COULD NOT VERIFY IN BROWSER")).toBeNull();
  });
});
