import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
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
  it("aborts after 45s, retries once, then throws a TIMEOUT ApiError", async () => {
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
    // First attempt times out at 45s, the single retry times out at 90s.
    await vi.advanceTimersByTimeAsync(45_001);
    await vi.advanceTimersByTimeAsync(45_001);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once after a timeout and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) => {
        if (fetchMock.mock.calls.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
        }
        return Promise.resolve(
          jsonResponse({ status: "ok", service: "verireceipt", uptime_s: 1, upstreams: {} }),
        );
      },
    );
    const pending = getHealth();
    const assertion = expect(pending).resolves.toMatchObject({ status: "ok" });
    await vi.advanceTimersByTimeAsync(45_001);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("response validation (B2)", () => {
  it("throws ApiError on 200 with an HTML body", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    await expect(getTx({ tx_hash: "0x00", chain: "sepolia" })).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
  });

  it("throws ApiError on 200 with an empty body", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await expect(getHealth()).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
  });

  it("throws ApiError on 200 with a non-object JSON body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify("ok"), { status: 200 }),
    );
    await expect(getHealth()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    fetchMock.mockResolvedValue(new Response(JSON.stringify([1, 2, 3]), { status: 200 }));
    await expect(getHealth()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("throws ApiError on 200 with a missing receipt", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tx_hash: "0x00", status: "not_found" }),
    );
    await expect(getTx({ tx_hash: "0x00", chain: "sepolia" })).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
  });

  it("throws ApiError on 200 with a receipt missing receipt_id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tx_hash: "0x00",
        status: "not_found",
        receipt: { upstream_url: "https://example.com" },
      }),
    );
    await expect(getTx({ tx_hash: "0x00", chain: "sepolia" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

describe("client-side validation (M1)", () => {
  it("rejects a non-ETH/USDC pair without calling fetch", async () => {
    await expect(getRoute({ pair: "BTC/USD" })).rejects.toMatchObject({
      code: "UNSUPPORTED_PAIR",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty string params without calling fetch", async () => {
    await expect(getRoute({ pair: "" })).rejects.toMatchObject({ code: "INVALID_PARAM" });
    await expect(getTx({ tx_hash: "", chain: "sepolia" })).rejects.toMatchObject({
      code: "INVALID_PARAM",
    });
    await expect(getTvl({ protocol: "   " })).rejects.toMatchObject({
      code: "INVALID_PARAM",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects undefined params without calling fetch", async () => {
    await expect(
      getTx({ tx_hash: undefined as unknown as string, chain: "sepolia" }),
    ).rejects.toMatchObject({ code: "INVALID_PARAM" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects string params over 512 chars without calling fetch", async () => {
    await expect(getFilings({ entity: "x".repeat(513), period: "2026" })).rejects.toMatchObject({
      code: "INVALID_PARAM",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("retry_after_sec round-trip", () => {
  it("a 422 body with retry_after_sec surfaces it on the ApiError", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: "grid_no_data",
          code: "GRID_NO_DATA",
          message: "no settlement data yet for this interval",
          retry_after_sec: 30,
        },
        422,
      ),
    );
    try {
      await getGridPrice({
        node_or_zone: "TH_NP15_GEN-APND",
        interval_start: "2026-11-19T00:00:00Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 422, code: "GRID_NO_DATA", retry_after_sec: 30 });
    }
  });

  it("ignores a non-numeric retry_after_sec instead of surfacing garbage", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: "grid_no_data",
          code: "GRID_NO_DATA",
          message: "no settlement data yet",
          retry_after_sec: "soon",
        },
        422,
      ),
    );
    try {
      await getGridPrice({
        node_or_zone: "TH_NP15_GEN-APND",
        interval_start: "2026-11-19T00:00:00Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).retry_after_sec).toBeUndefined();
    }
  });
});

describe("error message truncation (J2 M2)", () => {
  it("truncates a 600-char server error message to 500 chars", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "e".repeat(600), code: "LONG_ERROR" }, 400),
    );
    try {
      await getTx({ tx_hash: "bad", chain: "sepolia" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as Error).message).toHaveLength(500);
    }
  });
});

describe("cold start (slow first response)", () => {
  // Abort-aware delayed mock: resolves after delayMs unless the signal
  // aborts first, like a real fetch under a timeout.
  function abortableDelayedResponse(delayMs: number, body: unknown) {
    return (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(jsonResponse(body)), delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
  }

  it("a 30s-delayed response succeeds within the 45s timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      abortableDelayedResponse(30_000, {
        status: "ok",
        service: "verireceipt",
        uptime_s: 1,
        upstreams: {},
      }),
    );
    const pending = getHealth();
    const assertion = expect(pending).resolves.toMatchObject({ status: "ok" });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 50s delay aborts at 45s, retries once, then throws TIMEOUT", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      abortableDelayedResponse(50_000, {
        status: "ok",
        service: "verireceipt",
        uptime_s: 1,
        upstreams: {},
      }),
    );
    const pending = getHealth();
    const assertion = expect(pending).rejects.toMatchObject({
      status: 0,
      code: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(45_001);
    await vi.advanceTimersByTimeAsync(45_001);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("route tolerates a 50s cold start inside its 60s budget", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      abortableDelayedResponse(50_000, {
        amount_out: 1739260358,
        block_number: 26454858,
        receipt: sampleReceipt,
      }),
    );
    const pending = getRoute({ pair: "ETH/USDC" });
    const assertion = expect(pending).resolves.toMatchObject({
      amount_out: 1739260358,
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("route times out at 60s per attempt (message names 60s)", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const pending = getRoute({ pair: "ETH/USDC" });
    const assertion = expect(pending).rejects.toMatchObject({
      status: 0,
      code: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    try {
      await pending;
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("60s");
    }
  });
});

describe("external abort", () => {
  it("throws ABORTED (not TIMEOUT, no retry) when the caller aborts", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const pending = getHealth(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 0, code: "ABORTED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws ABORTED immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getHealth(controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("classifies a cross-realm Error from fetch() as NETWORK_ERROR, not UNKNOWN (J2 R5 m2)", async () => {
    // An Error constructed in another vm realm fails `instanceof
    // Error` in this realm — classification must use the message
    // shape, not the prototype chain.
    const crossRealmError = vm.runInNewContext("new Error('net down')");
    expect(crossRealmError instanceof Error).toBe(false);
    expect(typeof crossRealmError.message).toBe("string");
    fetchMock.mockRejectedValue(crossRealmError);
    try {
      await getHealth();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
      expect((err as Error).message).toBe("net down");
    }
  });

  it("still reports UNKNOWN for a non-error thrown from fetch()", async () => {
    fetchMock.mockRejectedValue("boom");
    await expect(getHealth()).rejects.toMatchObject({
      status: 0,
      code: "UNKNOWN",
    });
  });
});

describe("ApiError retry_after_sec validation (J2 R2 M-1)", () => {
  it("keeps a sane finite non-negative delay", () => {
    expect(new ApiError("x", 422, "C", 30).retry_after_sec).toBe(30);
    expect(new ApiError("x", 422, "C", 0).retry_after_sec).toBe(0);
    expect(new ApiError("x", 422, "C", 86400).retry_after_sec).toBe(86400);
  });

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e21, 86401])(
    "drops an insane delay (%s) to undefined instead of storing it",
    (bad) => {
      expect(new ApiError("x", 422, "C", bad).retry_after_sec).toBeUndefined();
    },
  );

  it("drops a non-number delay (e.g. 'soon', {}) to undefined", () => {
    expect(
      new ApiError("x", 422, "C", "soon" as unknown as number).retry_after_sec,
    ).toBeUndefined();
    expect(
      new ApiError("x", 422, "C", {} as unknown as number).retry_after_sec,
    ).toBeUndefined();
  });

  it("a 422 body with an insane retry_after_sec surfaces undefined, not 1e21", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: "grid_no_data",
          code: "GRID_NO_DATA",
          message: "no settlement data yet",
          retry_after_sec: 1e21,
        },
        422,
      ),
    );
    try {
      await getGridPrice({
        node_or_zone: "TH_NP15_GEN-APND",
        interval_start: "2026-11-19T00:00:00Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).retry_after_sec).toBeUndefined();
    }
  });
});

describe("null/undefined params object (J2 R2 M-2)", () => {
  it.each([
    ["getTx", () => getTx(null as unknown as { tx_hash: string; chain: string })],
    ["getTx", () => getTx(undefined as unknown as { tx_hash: string; chain: string })],
    ["getTx", () => getTx("nope" as unknown as { tx_hash: string; chain: string })],
    ["getRoute", () => getRoute(null as unknown as { pair: string })],
    ["getRoute", () => getRoute(undefined as unknown as { pair: string })],
    ["getFilings", () => getFilings(null as unknown as { entity: string; period: string })],
    ["getTvl", () => getTvl(null as unknown as { protocol: string })],
    [
      "getGridPrice",
      () =>
        getGridPrice(null as unknown as { node_or_zone: string; interval_start: string }),
    ],
    // Array params (J2 R3 M-2): typeof [] is "object", so without the
    // Array.isArray guard in assertValidParamsObject these would throw a
    // raw TypeError from `params.tx_hash` instead of an ApiError.
    ["getTx", () => getTx([] as unknown as { tx_hash: string; chain: string })],
    ["getFilings", () => getFilings([] as unknown as { entity: string; period: string })],
    ["getTvl", () => getTvl([] as unknown as { protocol: string })],
    ["getRoute", () => getRoute([] as unknown as { pair: string })],
    [
      "getGridPrice",
      () =>
        getGridPrice([] as unknown as { node_or_zone: string; interval_start: string }),
    ],
  ])("%s throws ApiError INVALID_PARAM (not raw TypeError) with zero fetch calls", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ status: 400, code: "INVALID_PARAM" });
    try {
      await call();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("receipt field validation (J2 R2 B-1a / M-5)", () => {
  const baseBody = {
    tx_hash: "0x00",
    status: "not_found",
    from: null,
    to: null,
    block_number: null,
    value_eth: null,
  };

  it.each([
    ["non-string raw_response_sha256 (number)", { ...sampleReceipt, raw_response_sha256: 12345 }],
    ["non-string raw_response_sha256 (object)", { ...sampleReceipt, raw_response_sha256: {} }],
    ["missing raw_response_sha256", (({ raw_response_sha256: _r, ...rest }) => rest)(sampleReceipt)],
    ["non-string fetched_at (object)", { ...sampleReceipt, fetched_at: {} }],
    ["non-string fetched_at (number)", { ...sampleReceipt, fetched_at: 12345 }],
    ["missing fetched_at", (({ fetched_at: _f, ...rest }) => rest)(sampleReceipt)],
    ["non-string upstream_url (number)", { ...sampleReceipt, upstream_url: 42 }],
    ["missing upstream_url", (({ upstream_url: _u, ...rest }) => rest)(sampleReceipt)],
    ["whitespace-only receipt_id", { ...sampleReceipt, receipt_id: "   " }],
    ["empty receipt_id", { ...sampleReceipt, receipt_id: "" }],
    ["oversized receipt_id (513 chars)", { ...sampleReceipt, receipt_id: "x".repeat(513) }],
    ["1 MB receipt_id", { ...sampleReceipt, receipt_id: "x".repeat(1024 * 1024) }],
  ])("rejects a 200 whose receipt has %s", async (_label, receipt) => {
    fetchMock.mockResolvedValue(jsonResponse({ ...baseBody, receipt }));
    await expect(getTx({ tx_hash: "0x00", chain: "sepolia" })).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
  });

  it("accepts a 512-char receipt_id (at the cap)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...baseBody, receipt: { ...sampleReceipt, receipt_id: "x".repeat(512) } }),
    );
    const res = await getTx({ tx_hash: "0x00", chain: "sepolia" });
    expect(res.receipt.receipt_id).toHaveLength(512);
  });

  // The other receipt fields were uncapped (J2 R3): a 1 MB fetched_at
  // passed validation and rendered verbatim, a 1 MB upstream_url
  // rendered as plain text, a 1 MB sha sat in the title= attribute.
  it.each([
    ["1 MB fetched_at", { ...sampleReceipt, fetched_at: "x".repeat(1024 * 1024) }],
    ["1 MB upstream_url", { ...sampleReceipt, upstream_url: "x".repeat(1024 * 1024) }],
    ["1 MB raw_response_sha256", { ...sampleReceipt, raw_response_sha256: "x".repeat(1024 * 1024) }],
    ["129-char fetched_at (over the 128 cap)", { ...sampleReceipt, fetched_at: "x".repeat(129) }],
    ["2049-char upstream_url (over the 2048 cap)", { ...sampleReceipt, upstream_url: "x".repeat(2049) }],
    ["129-char raw_response_sha256 (over the 128 cap)", { ...sampleReceipt, raw_response_sha256: "x".repeat(129) }],
  ])("rejects a 200 whose receipt has %s", async (_label, receipt) => {
    fetchMock.mockResolvedValue(jsonResponse({ ...baseBody, receipt }));
    await expect(getTx({ tx_hash: "0x00", chain: "sepolia" })).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
  });

  it("accepts each receipt field exactly at its cap (128 / 2048 / 128)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...baseBody,
        receipt: {
          ...sampleReceipt,
          fetched_at: "x".repeat(128),
          upstream_url: "x".repeat(2048),
          raw_response_sha256: "x".repeat(128),
        },
      }),
    );
    const res = await getTx({ tx_hash: "0x00", chain: "sepolia" });
    expect(res.receipt.fetched_at).toHaveLength(128);
    expect(res.receipt.upstream_url).toHaveLength(2048);
    expect(res.receipt.raw_response_sha256).toHaveLength(128);
  });
});

describe("invisible format characters in receipt fields (J2 R5 B-1)", () => {
  const baseBody = {
    tx_hash: "0x00",
    status: "not_found",
    from: null,
    to: null,
    block_number: null,
    value_eth: null,
  };
  // trim() strips NBSP/FEFF but NOT these: every one used to pass
  // isNonEmptyReceiptString and be ACCEPTED as a receipt field.
  const INVISIBLE = [
    "\u200B",
    "\u200C",
    "\u200D",
    "\u2060",
    "\u180E",
    "\u200B\u200B",
    " \u200B ",
    "\u200B \u200C \u200D",
  ];
  const fields = ["receipt_id", "raw_response_sha256", "fetched_at", "upstream_url"] as const;
  const cases = fields.flatMap((field) =>
    INVISIBLE.map(
      (value) =>
        [`${field} is invisible-only`, { ...sampleReceipt, [field]: value }] as const,
    ),
  );

  it.each(cases)("rejects a 200 whose receipt has %s", async (_label, receipt) => {
    fetchMock.mockResolvedValue(jsonResponse({ ...baseBody, receipt }));
    await expect(getTx({ tx_hash: "0x00", chain: "sepolia" })).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
  });

  it("accepts a receipt_id with a visible character next to a format character", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...baseBody, receipt: { ...sampleReceipt, receipt_id: "rcpt_\u200BTEST" } }),
    );
    const res = await getTx({ tx_hash: "0x00", chain: "sepolia" });
    expect(res.receipt.receipt_id).toBe("rcpt_\u200BTEST");
  });
});

describe("spurious abort (J2 R2 M-6)", () => {
  it("an AbortError with no timeout and no external abort is ABORTED, never TIMEOUT", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));
    const pending = getHealth();
    await expect(pending).rejects.toMatchObject({ status: 0, code: "ABORTED" });
    try {
      await pending;
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("timed out");
      expect((err as Error).message).toBe("Request aborted");
    }
    // Not retried: a spurious abort is not a timeout.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a non-DOMException AbortError from fetch() itself is ABORTED (J2 R4 M-3)", async () => {
    // Name-based classification (not instanceof): a plain Error carrying
    // the AbortError name is an abort all the same.
    const abortLike = new Error("The operation was aborted.");
    abortLike.name = "AbortError";
    fetchMock.mockRejectedValue(abortLike);
    await expect(getHealth()).rejects.toMatchObject({ status: 0, code: "ABORTED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("abort during the body read (J2 R3 M-6)", () => {
  it("an external abort fired while the body is still pending returns ABORTED, never the data", async () => {
    // The body is now read via res.text() (size-cap change), so the
    // pending-body mock defers text(): it resolves only when the
    // controller signal aborts — exactly the race the fix closes.
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) => {
        let resolveText: (value: string) => void = () => {};
        const textPromise = new Promise<string>((resolve) => {
          resolveText = resolve;
        });
        init?.signal?.addEventListener(
          "abort",
          () => {
            resolveText(
              JSON.stringify({ status: "ok", service: "verireceipt", uptime_s: 1, upstreams: {} }),
            );
          },
          { once: true },
        );
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          text: () => textPromise,
        } as unknown as Response);
      },
    );
    const pending = getHealth(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 0, code: "ABORTED" });
    // The body resolved after the abort — it must not have been returned.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an AbortError thrown by text() itself is ABORTED, not INVALID_RESPONSE", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
    } as unknown as Response);
    await expect(getHealth()).rejects.toMatchObject({ status: 0, code: "ABORTED" });
  });

  it("a non-DOMException error with name 'AbortError' thrown by text() is ABORTED (J2 R4 M-3)", async () => {
    // A plain Error (not a DOMException) carrying the AbortError name —
    // e.g. thrown by a non-DOM text() implementation — used to be
    // swallowed to body = null and surface as INVALID_RESPONSE.
    const abortLike = new Error("The operation was aborted.");
    abortLike.name = "AbortError";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: () => Promise.reject(abortLike),
    } as unknown as Response);
    await expect(getHealth()).rejects.toMatchObject({ status: 0, code: "ABORTED" });
  });

  it("a generic Error thrown by text() is NETWORK_ERROR, not INVALID_RESPONSE (J1 R3 m3)", async () => {
    // A mid-body network failure: the body never arrived, so nothing
    // about it was invalid.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: () => Promise.reject(new Error("network failure mid-body")),
    } as unknown as Response);
    try {
      await getHealth();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
      expect((err as Error).message).toBe("network failure mid-body");
    }
  });

  it("a text() failure on an error status still surfaces the HTTP status (J1 R3 m3 — status preserved)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: () => Promise.reject(new Error("network failure mid-body")),
    } as unknown as Response);
    await expect(getHealth()).rejects.toMatchObject({ status: 500 });
  });
});

describe("Retry-After response header (J2 R3)", () => {
  function headerResponse(status: number, retryAfter: string | null, body: unknown): Response {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (retryAfter !== null) headers["Retry-After"] = retryAfter;
    return new Response(JSON.stringify(body), { status, headers });
  }

  const errBody = { error: "rate_limited", code: "RATE_LIMITED", message: "too many requests" };

  it("reads Retry-After: 120 from a 429 when the body carries no retry_after_sec", async () => {
    fetchMock.mockResolvedValue(headerResponse(429, "120", errBody));
    try {
      await getGridPrice({
        node_or_zone: "TH_NP15_GEN-APND",
        interval_start: "2026-11-19T00:00:00Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED", retry_after_sec: 120 });
    }
  });

  it("prefers a valid body retry_after_sec over the header", async () => {
    fetchMock.mockResolvedValue(
      headerResponse(429, "120", { ...errBody, retry_after_sec: 30 }),
    );
    try {
      await getGridPrice({
        node_or_zone: "TH_NP15_GEN-APND",
        interval_start: "2026-11-19T00:00:00Z",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).retry_after_sec).toBe(30);
    }
  });

  it("falls back to the header when the body value is invalid", async () => {
    fetchMock.mockResolvedValue(
      headerResponse(429, "45", { ...errBody, retry_after_sec: "soon" }),
    );
    try {
      await getGridPrice({
        node_or_zone: "TH_NP15_GEN-APND",
        interval_start: "2026-11-19T00:00:00Z",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).retry_after_sec).toBe(45);
    }
  });

  it("ignores an unparseable or out-of-range header instead of surfacing garbage", async () => {
    for (const bad of ["soon", "999999", "-5"]) {
      fetchMock.mockResolvedValue(headerResponse(429, bad, errBody));
      try {
        await getGridPrice({
          node_or_zone: "TH_NP15_GEN-APND",
          interval_start: "2026-11-19T00:00:00Z",
        });
        expect.unreachable();
      } catch (err) {
        expect((err as ApiError).retry_after_sec).toBeUndefined();
      }
    }
  });

  it("accepts an HTTP-date Retry-After as seconds-from-now", async () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    fetchMock.mockResolvedValue(headerResponse(429, date, errBody));
    try {
      await getGridPrice({
        node_or_zone: "TH_NP15_GEN-APND",
        interval_start: "2026-11-19T00:00:00Z",
      });
      expect.unreachable();
    } catch (err) {
      const secs = (err as ApiError).retry_after_sec;
      expect(secs).toBeGreaterThanOrEqual(55);
      expect(secs).toBeLessThanOrEqual(60);
    }
  });

  it("surfaces the real error code/status when the Response has no headers object (J1 dashboard re-review)", async () => {
    // Hand-rolled stubs in other branches' tests return {ok, status,
    // text} with NO headers. The Retry-After fallback must not throw
    // TypeError and mask the real 422 as NETWORK_ERROR (status 0) —
    // a missing headers object simply means no header fallback.
    const body = { error: "unprocessable", code: "UNSUPPORTED_PAIR", message: "pair not supported" };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response);
    try {
      await getHealth();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 422, code: "UNSUPPORTED_PAIR" });
      expect((err as Error).message).toBe("pair not supported");
    }
  });
  it("surfaces the real error code/status when headers.get throws (J2 R5 m1)", async () => {
    // A throwing .get used to propagate to the outer catch and mask
    // the real 422 as NETWORK_ERROR (status 0). It must fall back to
    // "no header" and preserve the body code/status.
    const body = { error: "unprocessable", code: "UNSUPPORTED_PAIR", message: "pair not supported" };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      headers: {
        get() {
          throw new Error("headers boom");
        },
      },
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response);
    try {
      await getHealth();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 422, code: "UNSUPPORTED_PAIR" });
      expect((err as Error).message).toBe("pair not supported");
      expect((err as ApiError).retry_after_sec).toBeUndefined();
    }
  });
});

describe("response-body size cap (J2 R3)", () => {
  it("rejects a valid-JSON body over 1 MiB as INVALID_RESPONSE", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: "ok",
        service: "verireceipt",
        uptime_s: 1,
        upstreams: {},
        pad: "x".repeat(1_048_576),
      }),
    );
    try {
      await getHealth();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 200, code: "INVALID_RESPONSE" });
      expect((err as Error).message).toContain("exceeds");
    }
  });

  it("accepts a body of exactly 1,048,576 bytes (J1 R3 m1 — exact boundary)", async () => {
    // Only the over-cap rejection was tested before; the cap itself is
    // `> MAX`, so a body of exactly 1 MiB must parse.
    const base = { status: "ok", service: "verireceipt", uptime_s: 1, upstreams: {} };
    const baseLen = new TextEncoder().encode(JSON.stringify(base)).length;
    // Adding a "pad" key inserts `,"pad":"<pad>"` (9 chars + pad) before
    // the closing brace; all-ASCII, so chars == bytes.
    const padLen = 1_048_576 - baseLen - 9;
    const text = JSON.stringify({ ...base, pad: "x".repeat(padLen) });
    expect(new TextEncoder().encode(text).length).toBe(1_048_576);
    fetchMock.mockResolvedValue(jsonResponse(JSON.parse(text)));
    const res = await getHealth();
    expect(res.status).toBe("ok");
  });
});

describe("payload fields beyond the receipt (J2 R3 §8b)", () => {
  it("rejects a 200 with a valid receipt but filings: 'not-an-array'", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        entity: "Apple",
        filing_count: 94,
        filings: "not-an-array",
        urls: ["https://example.com"],
        receipt: sampleReceipt,
      }),
    );
    await expect(getFilings({ entity: "Apple", period: "2026" })).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a 200 with a valid receipt but a non-numeric tvl_usd", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        protocol_or_chain: "aave-v3",
        tvl_usd: "lots",
        chain_tvl_usd: 12899774367.87363,
        as_of: "2026-11-20T06:12:59.000Z",
        receipt: sampleReceipt,
      }),
    );
    await expect(getTvl({ protocol: "aave-v3" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a 200 with a valid receipt but urls: 'not-an-array'", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        entity: "Apple",
        filing_count: 94,
        filings: [],
        urls: "https://example.com",
        receipt: sampleReceipt,
      }),
    );
    await expect(getFilings({ entity: "Apple", period: "2026" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("still accepts the live-shaped payloads (numbers, null block_number, arrays)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        protocol_or_chain: "aave-v3",
        tvl_usd: 15083256265,
        chain_tvl_usd: null,
        as_of: "2026-11-20T06:12:59.000Z",
        receipt: sampleReceipt,
      }),
    );
    const res = await getTvl({ protocol: "aave-v3" });
    expect(res.tvl_usd).toBe(15083256265);
    expect(res.chain_tvl_usd).toBeNull();
  });
});
