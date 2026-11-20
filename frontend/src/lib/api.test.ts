import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getFilings, getGridPrice, getHealth, getRoute, getTvl, getTx } from "./api";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleReceipt = {
  receipt_id: "rcpt_TEST123",
  upstream_url: "https://example.com/upstream",
  raw_response_sha256: "0xabc123",
  fetched_at: "2026-11-20T07:37:12.206Z",
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getHealth", () => {
  it("calls /api/health and returns the body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "ok", service: "verireceipt", uptime_s: 2778, upstreams: {} }),
    );
    const res = await getHealth();
    expect(res.status).toBe("ok");
    expect(res.service).toBe("verireceipt");
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.any(Object));
  });
});

describe("getTx", () => {
  it("encodes tx_hash and chain as query params", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tx_hash: "0x00",
        status: "not_found",
        from: null,
        to: null,
        block_number: null,
        value_eth: null,
        receipt: sampleReceipt,
      }),
    );
    const res = await getTx({
      tx_hash: "0x00",
      chain: "sepolia",
    });
    expect(res.status).toBe("not_found");
    expect(res.receipt.receipt_id).toBe("rcpt_TEST123");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe("/api/v1/tx?tx_hash=0x00&chain=sepolia");
  });

  it("throws ApiError with the live error body on a 400", async () => {
    // Fresh Response per call: a Response body can only be consumed once.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: "invalid_tx_hash",
            code: "INVALID_TX_HASH",
            message: "tx_hash must be a 0x-prefixed 64-hex-character transaction hash",
          },
          400,
        ),
      ),
    );
    await expect(getTx({ tx_hash: "bad", chain: "sepolia" })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_TX_HASH",
    });
    try {
      await getTx({ tx_hash: "bad", chain: "sepolia" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as Error).message).toContain("0x-prefixed");
    }
  });
});

describe("getFilings", () => {
  it("returns entity, filing_count and filings", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        entity: "Apple",
        filing_count: 94,
        filings: [{ form: "4", accession: "x", filing_date: "2026-11-19", url: "https://example.com" }],
        urls: ["https://example.com"],
        receipt: sampleReceipt,
      }),
    );
    const res = await getFilings({ entity: "Apple", period: "2026" });
    expect(res.filing_count).toBe(94);
    expect(res.filings).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/v1/filings?entity=Apple&period=2026",
    );
  });
});

describe("getTvl", () => {
  it("returns tvl fields", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        protocol_or_chain: "aave-v3",
        tvl_usd: 15083256265,
        chain_tvl_usd: 12899774367.87363,
        as_of: "2026-11-20T06:12:59.000Z",
        receipt: sampleReceipt,
      }),
    );
    const res = await getTvl({ protocol: "aave-v3" });
    expect(res.tvl_usd).toBe(15083256265);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/v1/tvl?protocol=aave-v3");
  });
});

describe("getRoute", () => {
  it("returns amount_out", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ amount_out: 1739260358, block_number: 26454858, receipt: sampleReceipt }),
    );
    const res = await getRoute({ pair: "ETH/USDC" });
    expect(res.amount_out).toBe(1739260358);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/v1/route?pair=ETH%2FUSDC");
  });
});

describe("getGridPrice", () => {
  it("returns the LMP fields", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        lmp_usd_per_mwh: 43.43,
        node_or_zone: "ZONE_J",
        market: "NYISO",
        interval_start: "2026-11-19T12:00:00.000Z",
        currency: "USD",
        receipt: sampleReceipt,
      }),
    );
    const res = await getGridPrice({
      node_or_zone: "ZONE_J",
      interval_start: "2026-11-19T12:00:00Z",
    });
    expect(res.lmp_usd_per_mwh).toBe(43.43);
    expect(res.market).toBe("NYISO");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/v1/grid-price?node_or_zone=ZONE_J");
    expect(url).toContain("interval_start=2026-11-19T12%3A00%3A00Z");
  });

  it("surfaces a 502 cache-miss as ApiError", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: "grid_cache_miss",
          code: "GRID_CACHE_MISS",
          message: "no cached price for TH_NP15_GEN-APND at 2026-11-19T00:00:00.000Z",
        },
        502,
      ),
    );
    await expect(
      getGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T00:00:00Z" }),
    ).rejects.toMatchObject({ status: 502, code: "GRID_CACHE_MISS" });
  });
});

describe("timeout", () => {
  it("aborts after 20s and throws a TIMEOUT ApiError", async () => {
    vi.useFakeTimers();
    // Real fetch rejects with AbortError when the signal aborts; the mock
    // must do the same or the request would hang forever.
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const pending = getHealth();
    const assertion = expect(pending).rejects.toMatchObject({
      status: 0,
      code: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
  });
});

describe("network failure", () => {
  it("wraps a fetch rejection as ApiError with status 0", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(getHealth()).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
    });
  });
});
