// Desk routes + MCP tests — Fastify inject, no network, no live spend.
// The TelegraphClient is replaced by a stub that returns canned ranked
// answers, so these tests prove routing, caps, ledger writes, MCP
// framing, and the verbatim disclosure — not the node.
//
// Paths are the remounted no-/api routes: /desk/* and /mcp.

import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerDeskRoutes, RELATED_PARTY_DISCLOSURE, resetDeskCaps } from "../src/desk/routes";
import { registerMcp } from "../src/desk/mcp";
import type { AskResult, TelegraphClient } from "../src/desk/telegraphClient";

process.env.SQLITE_PATH = join(tmpdir(), `desk-test-${process.pid}.sqlite`);

const CONFIRMED_TX = "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";

function cannedAsk(intent: string, params: Record<string, unknown>): AskResult {
  const results: Record<string, Record<string, unknown>> = {
    ONCHAIN_TX_LOOKUP_GENERAL: {
      status: "confirmed",
      chain: "ethereum",
      tx_hash: CONFIRMED_TX,
      from: "0x5875db54cd9ae2b2a875e09bb731772297ae9d92",
      to: "0x0000000aa232009084bd71a5797d089aa4edfad4",
      block_number: 26454409,
      value_eth: 0,
    },
    REGULATORY_FILING_MONITOR_GENERAL: { entity: "Apple Inc", filing_count: 12, filings: [], urls: [] },
    TVL_LOOKUP_GENERAL: { protocol_or_chain: "aave-v3", tvl_usd: 15000000000 },
    OPTIMAL_EXECUTION_ROUTE_GENERAL: { amount_out: 3000000000, pair: "ETH/USDC" },
    SANCTIONS_SCREENING_MATCH_GENERAL: { matched: false, name: "Apple Inc", match_score: 0.12 },
    CRYPTO_PRICE_USD: { symbol: "ETH", price_usd: 3000 },
    GRID_POWER_PRICE_GENERAL: {
      lmp_usd_per_mwh: 30,
      node_or_zone: "TH_NP15_GEN-APND",
      market: "day-ahead",
      interval_start: "2026-11-19T00:00:00Z",
      currency: "USD",
    },
    MINING_HASHPRICE_VERIFY_GENERAL: {
      hashprice_sats_per_ph_day: 50000,
      hashprice_usd_per_ph_day: 50,
      block_height: 900000,
    },
  };
  return {
    intent,
    params,
    result: results[intent] ?? {},
    input: intent === "ONCHAIN_TX_LOOKUP_GENERAL" ? { chain: "ethereum" } : undefined,
    miner_id: "774921",
    miner_name: "VeriReceipt Deterministic Oracle",
    signal_hash: "0x" + "ab".repeat(32),
    cost_usd: 0.01,
    duration_ms: 412,
    payments: [{ miner: "774921", intent, amount_uusdc: 10000, receipt_hash: "0x" + "cd".repeat(32) }],
    receipt: { receipt_hash: "0x" + "cd".repeat(32), rail: "escrow", amount_uusdc: 10000, epoch_id: 24 },
    rail: "escrow",
    fetched_at: new Date().toISOString(),
  };
}

const stubClient = {
  address: "0xf76e6B0920e9332fF4410f6dD53F01722AbC71a3",
  askRanked: async (intent: string, params: Record<string, unknown>) => cannedAsk(intent, params),
  verifySignal: async () => ({ verified: true, body: { verification: { verified: true } } }),
  getLedgerAccount: async () => ({
    address: "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3",
    deposited: "2000000",
    balance: "2000000",
    available: "2000000",
    charged: "0",
    credited: "0",
    unbilled: "0",
  }),
} as unknown as TelegraphClient;

const M13_PAYLOAD = {
  mission: "M13",
  protocol: "aave-v3",
  tx_hash: CONFIRMED_TX,
  chain: "ethereum",
  issuer_entity: "Apple Inc",
  period: "last 12 months",
  trade_pair: "ETH/USDC",
};

const M12_PAYLOAD = {
  mission: "M12",
  node_or_zone: "TH_NP15_GEN-APND",
  interval_start: "2026-11-19T00:00:00Z",
  breakeven_usd_per_mwh: 40,
};

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DESK_PAYER_ADDRESS = "0xf76e6B0920e9332fF4410f6dD53F01722AbC71a3";
  resetDeskCaps();
  app = Fastify({ logger: false });
  registerDeskRoutes(app, {
    client: stubClient,
    todayPrefix: () => "2026-11-20",
    blockHeightFn: async () => 900000,
  });
  registerMcp(app, {
    client: stubClient,
    blockHeightFn: async () => 900000,
    todayPrefix: () => "2026-11-20",
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /desk/stats", () => {
  it("serves the verbatim related-party disclosure + runway ticker", async () => {
    const res = await app.inject({ method: "GET", url: "/desk/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.related_party_disclosure).toBe(RELATED_PARTY_DISCLOSURE);
    expect(body.related_party_disclosure).toContain("related-party / internal test traffic");
    expect(body.runway_label).toBe("Funded for ~200 live checks");
    expect(body.runway_checks).toBe(200);
    expect((body.caps as Record<string, unknown>).free_checks_per_ip_per_day).toBe(5);
    expect((body.caps as Record<string, unknown>).daily_global_cap_usd).toBe(2);
    expect((body.caps as Record<string, unknown>).cost_per_m13_run_usd).toBe(0.06);
    expect((body.caps as Record<string, unknown>).cost_per_m12_run_usd).toBe(0.02);
  });
});

describe("GET /desk/ledger", () => {
  it("returns paginated runs (empty before any run)", async () => {
    const res = await app.inject({ method: "GET", url: "/desk/ledger?page=1&limit=20" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.page).toBe(1);
    expect(Array.isArray(body.runs)).toBe(true);
  });
});

describe("POST /desk/run", () => {
  it("runs a full M13 audit via the stub and returns APPROVE + Why box (6 calls, route_vs_spot computed)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desk/run",
      payload: { ...M13_PAYLOAD, scenario_id: "desk-test-m13" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.verdict).toBe("APPROVE");
    expect((body.calls as unknown[]).length).toBe(6);
    expect((body.calls as Array<Record<string, unknown>>).map((c) => c.intent)).toContain("CRYPTO_PRICE_USD");
    expect((body.why as unknown[]).length).toBe(8);
    expect(body.total_cost_uusdc).toBe(60000);
    expect(body.disclosure).toBe(RELATED_PARTY_DISCLOSURE);
    const calls = body.calls as Array<Record<string, unknown>>;
    expect(calls[0].signal_url).toContain("https://devnode.telegraphprotocol.com/engine/v1/signal/0x");
    const spot = (body.checks as Array<Record<string, unknown>>).find((c) => c.id === "route_vs_spot");
    expect(spot?.status).toBe("pass");
    const txHash = (body.checks as Array<Record<string, unknown>>).find((c) => c.id === "tx_hash");
    expect(txHash?.status).toBe("pass");
    // Every receipt identifier the ask provided is recorded per call.
    expect((calls[0].payments as unknown[]).length).toBe(1);
    expect(calls[0].receipt).toBeDefined();
  });

  it("runs a full M12 dispatch via the stub and returns MINE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desk/run",
      payload: { ...M12_PAYLOAD, scenario_id: "desk-test-m12" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.verdict).toBe("MINE");
    expect((body.calls as unknown[]).length).toBe(2);
    expect(body.total_cost_uusdc).toBe(20000);
  });

  it("refuses an invalid mission with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desk/run",
      payload: { mission: "M99" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an unsupported trade pair with 422", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desk/run",
      payload: { ...M13_PAYLOAD, trade_pair: "BTC/USD" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("writes the runs to the ledger", async () => {
    const res = await app.inject({ method: "GET", url: "/desk/ledger?limit=100" });
    const body = res.json() as Record<string, unknown>;
    expect((body.total as number) >= 8).toBe(true);
    const runs = body.runs as Array<Record<string, unknown>>;
    expect(runs.every((r) => r.related_party === true)).toBe(true);
    expect(runs[0].signal_url).toContain("/engine/v1/signal/0x");
  });

  it("404s the old /api-prefixed route (clean remount, no ambiguity)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/desk/run",
      payload: M13_PAYLOAD,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("caps on POST /desk/run", () => {
  it("RATE_LIMITEDs the 6th free check from one IP in a day", async () => {
    resetDeskCaps();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/desk/run",
        payload: { ...M12_PAYLOAD, scenario_id: `cap-${i}` },
      });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: "POST",
      url: "/desk/run",
      payload: { ...M12_PAYLOAD, scenario_id: "cap-6" },
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as Record<string, unknown>).code).toBe("RATE_LIMITED");
  });

  it("allows only 5 of 6 concurrent requests from one IP (no TOCTOU overshoot)", async () => {
    resetDeskCaps();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/desk/run",
          payload: { ...M12_PAYLOAD, scenario_id: `race-${i}` },
        }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200).length;
    const limited = results.filter((r) => r.statusCode === 429).length;
    expect(ok).toBe(5);
    expect(limited).toBe(1);
  });

  it("a spoofed X-Forwarded-For does not grant a fresh quota (production trustProxy path)", async () => {
    // Production-path app: the SAME trustProxy function as src/server.ts:61
    // (trust only hop 0, the immediate socket peer = Render's proxy), so
    // request.ip is the LAST X-Forwarded-For entry and a client-sent entry
    // further left is ignored. The old test built a bare Fastify with no
    // trustProxy, where the spoof test passed trivially (no-trust Fastify
    // ignores XFF entirely) and proved nothing about production.
    resetDeskCaps();
    const prodApp = Fastify({ logger: false, trustProxy: (_address, hop) => hop === 0 });
    registerDeskRoutes(prodApp, {
      client: stubClient,
      todayPrefix: () => "2026-11-20",
      blockHeightFn: async () => 900000,
    });
    await prodApp.ready();
    try {
      // Exhaust the quota for the last XFF entry 203.0.113.7 (the "real"
      // client Render would have appended) with varying spoofed first
      // entries — the spoof must never mint a fresh quota.
      for (let i = 0; i < 5; i++) {
        const res = await prodApp.inject({
          method: "POST",
          url: "/desk/run",
          payload: { ...M12_PAYLOAD, scenario_id: `xff-prod-${i}` },
          headers: { "x-forwarded-for": `203.0.113.${10 + i}, 203.0.113.7` },
        });
        expect(res.statusCode).toBe(200);
      }
      const res = await prodApp.inject({
        method: "POST",
        url: "/desk/run",
        payload: { ...M12_PAYLOAD, scenario_id: "xff-prod-6" },
        headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.7" },
      });
      expect(res.statusCode).toBe(429);
      expect((res.json() as Record<string, unknown>).code).toBe("RATE_LIMITED");
    } finally {
      await prodApp.close();
    }
  });

  it("the src/server.ts:61 trustProxy citation points at the trustProxy line", () => {
    // Guard for the README.md / desk.test.ts citations: if the comment
    // block above the Fastify construction grows or shrinks, the cited
    // line moves and this test fails loudly instead of the citations
    // silently pointing at a comment line.
    const lines = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf8").split("\n");
    const idx = lines.findIndex((l) => l.includes("trustProxy: (_address, hop) => hop === 0"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx + 1).toBe(61);
  });

  it("a different last X-Forwarded-For entry is a different quota (the last entry is the client)", async () => {
    resetDeskCaps();
    const prodApp = Fastify({ logger: false, trustProxy: (_address, hop) => hop === 0 });
    registerDeskRoutes(prodApp, {
      client: stubClient,
      todayPrefix: () => "2026-11-20",
      blockHeightFn: async () => 900000,
    });
    await prodApp.ready();
    try {
      // Same spoofed first entry, different last entry: two distinct
      // clients, each with its own 5/day quota.
      for (const last of ["203.0.113.7", "203.0.113.8"]) {
        const res = await prodApp.inject({
          method: "POST",
          url: "/desk/run",
          payload: { ...M12_PAYLOAD, scenario_id: `xff-last-${last}` },
          headers: { "x-forwarded-for": `1.2.3.4, ${last}` },
        });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await prodApp.close();
    }
  });

  it("a request with a different last X-Forwarded-For entry gets a fresh quota after the socket peer's quota is exhausted (proves request.ip follows the last entry)", async () => {
    // This is the discriminating test: on a no-trust app request.ip is
    // always the socket peer, so the XFF request below would 429 like
    // the plain ones. On the production hop===0 function it resolves to
    // the last XFF entry — a different client with a fresh quota.
    resetDeskCaps();
    const prodApp = Fastify({ logger: false, trustProxy: (_address, hop) => hop === 0 });
    registerDeskRoutes(prodApp, {
      client: stubClient,
      todayPrefix: () => "2026-11-20",
      blockHeightFn: async () => 900000,
    });
    await prodApp.ready();
    try {
      for (let i = 0; i < 5; i++) {
        const res = await prodApp.inject({
          method: "POST",
          url: "/desk/run",
          payload: { ...M12_PAYLOAD, scenario_id: `xff-fresh-${i}` },
        });
        expect(res.statusCode).toBe(200);
      }
      const plain6 = await prodApp.inject({
        method: "POST",
        url: "/desk/run",
        payload: { ...M12_PAYLOAD, scenario_id: "xff-fresh-plain-6" },
      });
      expect(plain6.statusCode).toBe(429);
      const otherClient = await prodApp.inject({
        method: "POST",
        url: "/desk/run",
        payload: { ...M12_PAYLOAD, scenario_id: "xff-fresh-other" },
        headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.7" },
      });
      expect(otherClient.statusCode).toBe(200);
    } finally {
      await prodApp.close();
    }
  });
});

describe("failed runs keep their bought spend (per-call logging)", () => {
  it("a scenario that throws on call 3 still has calls 1-2 in the ledger", async () => {
    resetDeskCaps();
    let asks = 0;
    const throwingClient = {
      ...stubClient,
      askRanked: async (intent: string, params: Record<string, unknown>) => {
        asks += 1;
        if (asks === 3) throw new Error("upstream exploded on call 3");
        return cannedAsk(intent, params);
      },
    } as unknown as TelegraphClient;
    const throwingApp = Fastify({ logger: false });
    registerDeskRoutes(throwingApp, {
      client: throwingClient,
      todayPrefix: () => "2026-11-20",
      blockHeightFn: async () => 900000,
    });
    await throwingApp.ready();
    try {
      const res = await throwingApp.inject({
        method: "POST",
        url: "/desk/run",
        payload: { ...M13_PAYLOAD, scenario_id: "throw-mid-run" },
      });
      expect(res.statusCode).toBe(502);
      const ledger = await throwingApp.inject({ method: "GET", url: "/desk/ledger?limit=100" });
      const runs = (ledger.json() as Record<string, unknown>).runs as Array<Record<string, unknown>>;
      const mine = runs.filter((r) => r.scenario_id === "throw-mid-run");
      expect(mine.length).toBe(2);
      expect(mine.map((r) => r.intent).sort()).toEqual([
        "ONCHAIN_TX_LOOKUP_GENERAL",
        "REGULATORY_FILING_MONITOR_GENERAL",
      ]);
      // The reservation was released: a later run still succeeds.
      const after = await throwingApp.inject({
        method: "POST",
        url: "/desk/run",
        payload: { ...M12_PAYLOAD, scenario_id: "throw-after" },
      });
      expect(after.statusCode).toBe(200);
    } finally {
      await throwingApp.close();
    }
  });
});

describe("MCP /mcp + /llms.txt", () => {
  it("answers initialize with the server info", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const result = body.result as Record<string, unknown>;
    expect((result.serverInfo as Record<string, unknown>).name).toBe("verireceipt-desk");
  });

  it("lists the 4 tools", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    const body = res.json() as Record<string, unknown>;
    const tools = (body.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_ledger",
      "run_m12_dispatch_check",
      "run_m13_allocation_check",
      "verify_receipt",
    ]);
  });

  it("calls verify_receipt and returns verified=true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { signal_hash: "0x" + "ab".repeat(32) } },
      },
    });
    const body = res.json() as Record<string, unknown>;
    const content = (body.result as Record<string, unknown>).content as Array<Record<string, unknown>>;
    const parsed = JSON.parse(content[0].text as string) as Record<string, unknown>;
    expect(parsed.verified).toBe(true);
  });

  it("calls get_ledger and returns rows", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_ledger", arguments: { limit: 5 } } },
    });
    const body = res.json() as Record<string, unknown>;
    const content = (body.result as Record<string, unknown>).content as Array<Record<string, unknown>>;
    const parsed = JSON.parse(content[0].text as string) as Record<string, unknown>;
    expect((parsed.total as number) >= 8).toBe(true);
  });

  it("runs run_m13_allocation_check through MCP with caps applied (6 calls, APPROVE)", async () => {
    resetDeskCaps();
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "run_m13_allocation_check",
          arguments: {
            protocol: "aave-v3",
            tx_hash: CONFIRMED_TX,
            chain: "ethereum",
            issuer_entity: "Apple Inc",
            period: "last 12 months",
            trade_pair: "ETH/USDC",
            scenario_id: "mcp-m13",
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const parsed = (body.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
    expect(parsed.verdict).toBe("APPROVE");
    expect((parsed.calls as unknown[]).length).toBe(6);
    expect(parsed.total_cost_uusdc).toBe(60000);
  });

  it("runs run_m12_dispatch_check through MCP with caps applied (MINE)", async () => {
    resetDeskCaps();
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "run_m12_dispatch_check",
          arguments: {
            node_or_zone: "TH_NP15_GEN-APND",
            interval_start: "2026-11-19T00:00:00Z",
            breakeven_usd_per_mwh: 40,
            scenario_id: "mcp-m12",
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const parsed = (body.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
    expect(parsed.verdict).toBe("MINE");
    expect(parsed.total_cost_uusdc).toBe(20000);
  });

  it("RATE_LIMITEDs the 6th MCP run_* call from one IP in a day (same caps as HTTP)", async () => {
    resetDeskCaps();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: {
          jsonrpc: "2.0",
          id: 10 + i,
          method: "tools/call",
          params: {
            name: "run_m12_dispatch_check",
            arguments: {
              node_or_zone: "TH_NP15_GEN-APND",
              interval_start: "2026-11-19T00:00:00Z",
              breakeven_usd_per_mwh: 40,
              scenario_id: `mcp-cap-${i}`,
            },
          },
        },
      });
      const parsed = (res.json() as Record<string, unknown>).result as Record<string, unknown>;
      expect(parsed.isError).toBeUndefined();
    }
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "run_m12_dispatch_check",
          arguments: {
            node_or_zone: "TH_NP15_GEN-APND",
            interval_start: "2026-11-19T00:00:00Z",
            breakeven_usd_per_mwh: 40,
            scenario_id: "mcp-cap-6",
          },
        },
      },
    });
    const body = res.json() as Record<string, unknown>;
    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].text as string).toContain("RATE_LIMITED");
  });

  it("404s the old /api/mcp route (clean remount)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 30, method: "tools/list" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("serves /llms.txt with the disclosure, tool names and new paths", async () => {
    const res = await app.inject({ method: "GET", url: "/llms.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("run_m13_allocation_check");
    expect(res.body).toContain("related-party / internal test traffic");
    expect(res.body).toContain("POST https://verireceipt.onrender.com/mcp");
    expect(res.body).toContain("POST /desk/run");
    expect(res.body).toContain("$0.06 M13 audit");
    expect(res.body).not.toContain("/api/mcp");
    expect(res.body).not.toContain("/api/desk");
  });
});
