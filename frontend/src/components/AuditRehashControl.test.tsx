// AuditRehashControl tests — the "Recompute from stored bytes" control.
//
// The global fetch is stubbed per test (no network); the bytes are
// synthetic and the hash oracle is the standard SHA-256 vector for "abc".

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditRehashControl } from "./AuditRehashControl";
import type { Receipt } from "../lib/types";

const ABC_SHA =
  "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const receipt: Receipt = {
  receipt_id: "rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  upstream_url: "https://example.com/upstream",
  raw_response_sha256: ABC_SHA,
  fetched_at: "2026-11-20T16:25:57.739Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
};

function bytesOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function clickRecompute() {
  // No awaited act(): the re-hash chain (fetch + WebCrypto digest) is
  // genuinely async, so the assertions below wait for the badge with
  // findByText instead of assuming the act() scope flushed it.
  fireEvent.click(screen.getByRole("button", { name: "Recompute from stored bytes" }));
}

describe("AuditRehashControl", () => {
  it("renders the control with an explanation before any check", () => {
    render(<AuditRehashControl receipt={receipt} />);
    expect(
      screen.getByRole("button", { name: "Recompute from stored bytes" }),
    ).toBeTruthy();
    expect(screen.getByText(/stored bytes cannot drift/i)).toBeTruthy();
  });

  it("shows MATCH with both hashes when the stored bytes hash to the digest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytesOf("abc"),
      }),
    );
    render(<AuditRehashControl receipt={receipt} />);
    await clickRecompute();
    expect(
      await screen.findByText("MATCH — STORED BYTES HASH TO RECORDED DIGEST"),
    ).toBeTruthy();
    expect(screen.getByText(new RegExp(ABC_SHA))).toBeTruthy();
  });

  it("shows MISMATCH with both hashes when the stored bytes differ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytesOf("abd"),
      }),
    );
    render(<AuditRehashControl receipt={receipt} />);
    await clickRecompute();
    expect(
      await screen.findByText("MISMATCH — STORED BYTES DO NOT HASH TO RECORDED DIGEST"),
    ).toBeTruthy();
  });

  it("shows UNAVAILABLE — never MISMATCH — when the audit endpoint 404s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        arrayBuffer: async () => bytesOf(""),
      }),
    );
    render(<AuditRehashControl receipt={receipt} />);
    await clickRecompute();
    expect(
      await screen.findByText("AUDIT ENDPOINT NOT AVAILABLE — RE-HASH UNPROVEN"),
    ).toBeTruthy();
    expect(screen.queryByText(/MISMATCH — STORED BYTES/i)).toBeNull();
  });

  it("fetches exactly the /receipts/:id/raw URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesOf("abc"),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuditRehashControl receipt={receipt} />);
    await clickRecompute();
    await screen.findByText("MATCH — STORED BYTES HASH TO RECORDED DIGEST");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://verireceipt.onrender.com/receipts/rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ/raw",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
