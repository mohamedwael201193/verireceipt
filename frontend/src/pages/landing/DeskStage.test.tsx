// J2 B1 regression tests: desk items 03/04 must NEVER render a VERIFIED
// verdict. No SHA-256 recompute happens anywhere in the desk — the grid
// call merely returning data is a live response with a receipt, not a
// verification (the same principle d004f91 applied to item 01). The
// verdict label is RECEIPTED and the section heading reads "receipted
// in the open." — assert both, plus that no VERIFIED label appears.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskStage } from "./DeskStage";

const RECEIPT = {
  receipt_id: "rcpt-test-grid",
  upstream_url: "https://example.com/upstream",
  raw_response_sha256: "c".repeat(64),
  fetched_at: "2026-11-20T00:00:00Z",
};

const GRID_BODY = {
  lmp_usd_per_mwh: 32.5,
  node_or_zone: "TH_NP15_GEN-APND",
  market: "CAISO",
  interval_start: "2026-11-20T05:00:00Z",
  currency: "USD",
  receipt: RECEIPT,
};

const GRID_NYISO_BODY = {
  ...GRID_BODY,
  node_or_zone: "ZONE_J",
  market: "NYISO",
};

function mockGridFetch(body: unknown) {
  // Real Response: lib/api.ts reads the body via res.text().
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function selectAndPlay(title: RegExp) {
  render(<DeskStage />);
  fireEvent.click(screen.getByRole("button", { name: title }));
  fireEvent.click(screen.getByRole("button", { name: /Run .* live checks/ }));
}

async function runItem(title: RegExp, body: unknown) {
  mockGridFetch(body);
  selectAndPlay(title);
  await waitFor(() => expect(screen.getByText("RECEIPTED")).toBeInTheDocument(), {
    timeout: 15000,
  });
}

describe("DeskStage — no VERIFIED verdict for grid items (J2 B1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("item 03 (CAISO NP15): a 200 grid response renders RECEIPTED, never VERIFIED", async () => {
    await runItem(/CAISO NP15/, GRID_BODY);
    expect(screen.queryByText("VERIFIED")).toBeNull();
    expect(screen.getByText(/receipted in the open\./)).toBeInTheDocument();
    expect(screen.queryByText(/verified in the open\./)).toBeNull();
    expect(screen.getByText(/live response with receipt, no threshold applied/)).toBeInTheDocument();
  });

  it("item 04 (NYISO Zone J): a 200 grid response renders RECEIPTED, never VERIFIED", async () => {
    await runItem(/NYISO Zone J/, GRID_NYISO_BODY);
    expect(screen.queryByText("VERIFIED")).toBeNull();
    expect(screen.getByText(/receipted in the open\./)).toBeInTheDocument();
  });
});

describe("DeskStage — stream rows name the real failure (J2 minor 3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a 500 labels the row 'HTTP 500', never 422", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "upstream boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    selectAndPlay(/CAISO NP15/);
    // The sig cell reads "<ms> · HTTP 500" (the outcome cell also
    // starts "HTTP 500 …", so match the sig's "·" prefix specifically).
    await waitFor(() => expect(screen.getByText(/· HTTP 500/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.queryByText(/422/)).toBeNull();
    expect(screen.getByText("CHECK FAILED")).toBeInTheDocument();
  });

  it("a network failure labels the row 'network', never 422", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    selectAndPlay(/CAISO NP15/);
    await waitFor(() => expect(screen.getByText(/· network/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.queryByText(/422/)).toBeNull();
  });
});

describe("DeskStage — item 02 verdict accounts for all calls (J2 R2 M3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("confirmed tx + failed 2nd (tvl) call is CHECK FAILED, never CLEAR", async () => {
    const TX_CONFIRMED_BODY = {
      tx_hash: "0x1a1467893eaed124a13164b589f1ed7a70ec203257084a7be27eee8f93bd8ba9",
      status: "confirmed",
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      block_number: 26454411,
      value_eth: "0.01",
      source: "archive-rpc-quorum",
      receipt: { ...RECEIPT, receipt_id: "rcpt-test-tx" },
    };
    // J2's exact repro: mock tx confirmed + tvl 500. The old verdict
    // read only outcomes[0], so it rendered CLEAR while a stream row
    // showed HTTP 500.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/v1/tvl")) {
          return new Response(JSON.stringify({ error: "upstream boom" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(TX_CONFIRMED_BODY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    selectAndPlay(/Counterparty hash, checked\./);
    await waitFor(() => expect(screen.getByText("CHECK FAILED")).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.queryByText("CLEAR")).toBeNull();
    expect(screen.getByText(/· HTTP 500/)).toBeInTheDocument();
    expect(screen.getByText(/Live check failed: tvl/)).toBeInTheDocument();
  });
});
