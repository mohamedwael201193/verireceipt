// pc2-xtab-r4: /status shows the on-chain bond ($2.15 = minerBond(6174) =
// quoteMinerBond(14)) and its live re-read, and surfaces a mismatch.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Status from "./Status";
import { SEPOLIA_RPC } from "../lib/minerBond";

const word = (n: number) => n.toString(16).padStart(64, "0");

function stubFetch(bondUnits: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === SEPOLIA_RPC) {
        const data: string = JSON.parse(String(init?.body)).params[0].data;
        const out = data.startsWith("0xc17a8722") ? "0x" + word(bondUnits) + word(bondUnits) : "0x" + word(bondUnits);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: out }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }),
  );
}

describe("/status bond row", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows $2.15 with its on-chain source and a matching live re-read", async () => {
    stubFetch(2_150_000);
    render(<MemoryRouter><Status /></MemoryRouter>);
    expect(await screen.findByText("live re-read matches")).toBeTruthy();
    expect(screen.getAllByText(/\$2\.15 Test USDC/).length).toBeGreaterThan(0);
    expect(screen.getByText(/minerBond\(6174\) = quoteMinerBond\(14\) = 2,150,000/)).toBeTruthy();
    expect(screen.queryByText(/\$1\.40/)).toBeNull();
  });

  it("flags a live value that differs from the labelled constant", async () => {
    stubFetch(1_870_000);
    render(<MemoryRouter><Status /></MemoryRouter>);
    expect(await screen.findByText(/live re-read differs/)).toBeTruthy();
    expect(screen.getByText(/live re-read differs/).textContent).toContain("$1.87");
  });
});

describe("/status bond row when the live read throws (J2 Minor 3, r7)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows UNVERIFIED, never the green badge, when the RPC fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 503 })),
    );
    render(<MemoryRouter><Status /></MemoryRouter>);
    expect(await screen.findByText(/live re-read failed .*UNVERIFIED/)).toBeTruthy();
    expect(screen.queryByText("live re-read matches")).toBeNull();
  });
});
