// Tests for src/handlers/washTrading.ts (WASH_TRADING_DETECTION_GENERAL).
// Real fixtures: tests/fixtures/wash/* are recorded GeckoTerminal bodies (2026-11-26): s_pool = /search/pools for
// 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640, s_tok = /search/pools for USDT, base_0xdeba... and eth_0xa43f... = /trades.
// SYNTHETIC fixtures (labelled) cover the wash and threshold cases, because no known-positive pool was recorded.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "wash-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");
afterAll(() => { rmSync(SCRATCH_DIR, { recursive: true, force: true }); });

import { ApiError } from "../src/core/errors";
import { FIELD_FORMAT, OUTPUT_MAPPING } from "../src/core/shapedFields";
import { intentFor } from "../src/core/requestMetrics";
import { INTENT_PRIMARY_UPSTREAM, getUpstreamsSnapshot, resetUpstreamsForTests } from "../src/core/upstreams";
import { buildServer } from "../src/server";
import { handleWashTrading, setWashFetchForTests, washStats, washVerdict } from "../src/handlers/washTrading";

const fx = (n: string) => readFileSync(join(__dirname, "fixtures", "wash", n), "utf8");
const S_POOL = fx("s_pool.json"), S_TOK = fx("s_tok.json");
const T_ORGANIC = fx("base_0xdebaebe5b2729f7d62072b2ea40472d78d2c1626.json"), T_MID = fx("eth_0xa43fe16908251ee70ef74718545e4fe6c5ccec9f.json");
const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const V4 = "0x3b1b1f2e775a6db1664f8e7d59ad568605ea2406312c11aef03146c0cf89d5b9";

afterEach(() => { vi.restoreAllMocks(); setWashFetchForTests(null); });
async function err(p: Promise<unknown>, status: number, code?: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ApiError); expect((e as ApiError).status).toBe(status); if (code) expect((e as ApiError).code).toBe(code); return; }
  throw new Error("expected rejection");
}
function route(map: { search?: string; trades?: string }, urls: string[] = []) {
  setWashFetchForTests(async (url) => { urls.push(url); if (url.includes("/search/pools")) return map.search ?? "{\"data\":[]}"; if (url.endsWith("/trades")) return map.trades ?? "{\"data\":[]}"; throw new Error("unexpected " + url); });
  return urls;
}
// SYNTHETIC trades
const trade = (i: number, kind: "buy" | "sell", sender: number, usd: number) => ({ attributes: { kind, tx_from_address: "0x" + sender.toString(16).padStart(40, "0"), volume_in_usd: String(usd), block_number: 1000 + i, tx_hash: "0x" + i.toString(16).padStart(64, "0"), block_timestamp: "2026-11-26T10:00:00Z" } });
const synth = (rows: any[]) => JSON.stringify({ data: rows });
const washRows = (senders: number) => Array.from({ length: senders * 4 }, (_, i) => trade(i, i % 2 === 0 ? "buy" : "sell", 1 + Math.floor(i / 4), 100 + Math.floor(i / 4)));

describe("washVerdict thresholds (pure)", () => {
  const st = (pct: number, trades = 300, senders = 100) => ({ trades, senders, total_usd: 1, wash_usd: 0, wash_volume_pct: pct, pairs: 0, top3_sender_pct: 0, zero_volume: 0, anomalous: 0, oldest: "", newest: "" });
  it("boundaries", () => {
    expect(washVerdict(st(50))).toBe("wash_trading"); expect(washVerdict(st(49.999999))).toBe("likely_wash_trading");
    expect(washVerdict(st(25))).toBe("likely_wash_trading"); expect(washVerdict(st(24.9))).toBe("inconclusive");
    expect(washVerdict(st(10))).toBe("inconclusive"); expect(washVerdict(st(9.999999))).toBe("organic");
  });
  it("too few trades or senders is inconclusive whatever the percentage", () => {
    expect(washVerdict(st(0, 99, 100))).toBe("inconclusive"); expect(washVerdict(st(0, 100, 19))).toBe("inconclusive");
    expect(washVerdict(st(90, 99, 100))).toBe("inconclusive"); expect(washVerdict(st(90, 100, 19))).toBe("inconclusive");
    expect(washVerdict(st(0, 100, 20))).toBe("organic"); expect(washVerdict(st(90, 100, 20))).toBe("wash_trading");
  });
});

describe("washStats matching (SYNTHETIC)", () => {
  const T = (kind: "buy" | "sell", sender: string, usd: number, block = 1) => ({ kind, sender, usd, block, tx: "0x" + block + kind + usd, ts: "t", anomalous: false });
  it("matches a buy and sell within 2% once, counts both legs", () => {
    const s = washStats([T("buy", "a", 100, 1), T("sell", "a", 102, 2), T("buy", "b", 898, 3)]);
    expect(s.pairs).toBe(1); expect(s.wash_usd).toBe(202); expect(s.wash_volume_pct).toBe(Number(((202 / 1100) * 100).toFixed(6)));
  });
  it("outside 2% does not match; different senders never match; two buys cannot share one sell", () => {
    expect(washStats([T("buy", "a", 100), T("sell", "a", 102.01, 2)]).pairs).toBe(0);
    expect(washStats([T("buy", "a", 100), T("sell", "b", 100, 2)]).pairs).toBe(0);
    expect(washStats([T("buy", "a", 100), T("buy", "a", 100, 2), T("sell", "a", 100, 3)]).pairs).toBe(1);
  });
  it("zero-USD buys are skipped and top3 share is reported", () => {
    const s = washStats([T("buy", "a", 0), T("sell", "a", 0, 2), T("buy", "b", 10, 3)]);
    expect(s.pairs).toBe(0); expect(s.top3_sender_pct).toBe(100);
  });
});

describe("handleWashTrading", () => {
  it("exact pool address, REAL search + trades: organic with disclosed numbers and contract shape", async () => {
    const urls = route({ search: S_POOL, trades: T_ORGANIC });
    const r: any = await handleWashTrading({ subject: POOL });
    expect(urls).toEqual([`https://api.geckoterminal.com/api/v2/search/pools?query=${POOL}`, `https://api.geckoterminal.com/api/v2/networks/eth/pools/${POOL}/trades`]);
    expect(r.verdict).toBe("organic"); expect(r.subject).toBe(POOL);
    expect(r.wash_volume_pct).toBeCloseTo(0.821, 3); expect(Number.isFinite(r.wash_volume_pct)).toBe(true);
    expect(r.signals).toContain("trades_sampled=300"); expect(r.signals).toContain("distinct_senders=178");
    expect(r.summary).toMatch(/Proxy over a recent sample only/); expect(r.receipt.raw_response_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.answer).toMatch(/exact pool address/);
  });
  it("REAL mid-range pool (20.11%) is inconclusive, not likely_wash", async () => {
    route({ search: S_POOL, trades: T_MID });
    const r: any = await handleWashTrading({ subject: POOL });
    expect(r.verdict).toBe("inconclusive"); expect(r.wash_volume_pct).toBeCloseTo(20.11, 1);
  });
  it("token address selects the highest-reserve pool, including a 32-byte pool id, and discloses it", async () => {
    const urls = route({ search: S_TOK, trades: T_ORGANIC });
    const r: any = await handleWashTrading({ subject: USDT });
    expect(urls[1]).toBe(`https://api.geckoterminal.com/api/v2/networks/eth/pools/${V4}/trades`);
    expect(r.answer).toMatch(/token address; selected its highest-reserve pool/); expect(r.signals).toContain(`pool=${V4}`);
  });
  it("SYNTHETIC full round-trip pool: wash_trading at 100%", async () => {
    route({ search: S_POOL, trades: synth(washRows(30)) });
    const r: any = await handleWashTrading({ subject: POOL });
    expect(r.verdict).toBe("wash_trading"); expect(r.wash_volume_pct).toBe(100);
  });
  it("SYNTHETIC 99 trades is inconclusive even at 100% matched", async () => {
    const rows = washRows(30).slice(0, 99);
    route({ search: S_POOL, trades: synth(rows) });
    const r: any = await handleWashTrading({ subject: POOL });
    expect(r.verdict).toBe("inconclusive");
  });
  it("answers are cached for the same subject (no second fetch)", async () => {
    const urls = route({ search: S_POOL, trades: T_ORGANIC });
    await handleWashTrading({ subject: POOL }); await handleWashTrading({ subject: POOL.toUpperCase().replace("0X", "0x") });
    expect(urls.length).toBe(2);
  });
  it("concurrent identical requests share one upstream fetch", async () => {
    const urls = route({ search: S_POOL, trades: T_ORGANIC });
    await Promise.all([handleWashTrading({ subject: POOL }), handleWashTrading({ subject: POOL }), handleWashTrading({ subject: POOL })]);
    expect(urls.length).toBe(2);
  });
  it("refusals: missing, malformed, too long, wallet or unknown address", async () => {
    route({});
    await err(handleWashTrading({}), 400, "MISSING_PARAM");
    await err(handleWashTrading({ subject: "x".repeat(300) }), 400, "SUBJECT_TOO_LONG");
    await err(handleWashTrading({ subject: "PEPE/WETH" }), 422, "UNSUPPORTED_SUBJECT");
    await err(handleWashTrading({ subject: "0x1234" }), 422, "UNSUPPORTED_SUBJECT");
    await err(handleWashTrading({ subject: "0x" + "ab".repeat(20) }), 422, "SUBJECT_NOT_A_POOL_OR_TOKEN");
  });
  it("refuses an address that is a pool on two networks, and a token with pools on two networks", async () => {
    const one = JSON.parse(S_POOL).data[0];
    const two = JSON.parse(JSON.stringify(one)); two.id = "base_" + POOL;
    route({ search: JSON.stringify({ data: [one, two] }) });
    await err(handleWashTrading({ subject: POOL }), 422, "AMBIGUOUS_SUBJECT");
    const tok = JSON.parse(S_TOK); const base = JSON.parse(JSON.stringify(tok.data[0])); base.id = "base_" + base.attributes.address;
    base.relationships.base_token.data.id = "base_" + USDT;
    setWashFetchForTests(async (u) => (u.includes("/search/") ? JSON.stringify({ data: [tok.data[0], base] }) : T_ORGANIC));
    await err(handleWashTrading({ subject: USDT }), 422, "AMBIGUOUS_SUBJECT");
  });
  it("source failures and bad bodies are non-200 and never produce a verdict", async () => {
    setWashFetchForTests(async () => { throw Object.assign(new Error("x"), { status: 429 }); });
    await err(handleWashTrading({ subject: POOL }), 502, "UPSTREAM_RATE_LIMITED");
    expect(getUpstreamsSnapshot().geckoterminal?.last_error).toBe("UPSTREAM_RATE_LIMITED");
    resetUpstreamsForTests();
    setWashFetchForTests(async () => { throw new Error("down"); });
    await err(handleWashTrading({ subject: POOL }), 502, "TRADE_SOURCE_UNREACHABLE");
    expect(getUpstreamsSnapshot().geckoterminal?.last_error).toBe("INDEXER_UNREACHABLE");
    setWashFetchForTests(async () => "<html>");
    await err(handleWashTrading({ subject: POOL }), 502, "INVALID_SOURCE_BODY");
    route({ search: S_POOL, trades: synth([{ attributes: { kind: "swap" } }]) });
    await err(handleWashTrading({ subject: POOL }), 502, "INVALID_SOURCE_BODY");
    route({ search: S_POOL, trades: synth([{ ...trade(1, "buy", 1, 5), attributes: { ...trade(1, "buy", 1, 5).attributes, kind: "swap" } }]) });
    await err(handleWashTrading({ subject: POOL }), 502, "INVALID_SOURCE_BODY");
    route({ search: S_POOL, trades: "{}" });
    await err(handleWashTrading({ subject: POOL }), 502, "INVALID_SOURCE_BODY");
    route({ search: "{}", trades: T_ORGANIC });
    await err(handleWashTrading({ subject: POOL }), 502, "INVALID_SOURCE_BODY");
    route({ search: S_POOL, trades: synth([]) });
    await err(handleWashTrading({ subject: POOL }), 422, "NO_RECENT_TRADES");
  });
  it("a search row whose id ends with the subject but whose pool address differs is not an exact match", async () => {
    const row = JSON.parse(S_POOL).data[0]; row.attributes.address = "0x" + "cd".repeat(20);
    route({ search: JSON.stringify({ data: [row] }) });
    await err(handleWashTrading({ subject: POOL }), 422, "SUBJECT_NOT_A_POOL_OR_TOKEN");
  });
});

describe("unpriced, oversized and flagged rows (SYNTHETIC)", () => {
  const nullRow = (i: number, v: unknown) => { const t: any = trade(i, i % 2 === 0 ? "buy" : "sell", 500 + (i % 30), 1); t.attributes.volume_in_usd = v; return t; };
  for (const [label, v] of [["null", null], ["empty string", ""], ["blank string", "  "]] as const) {
    it(`${label} volume rows are excluded and disclosed, never counted as trades or senders`, async () => {
      const priced = washRows(15).slice(0, 60); // 60 priced trades, 15 senders
      const rows = [...priced, ...Array.from({ length: 90 }, (_x, i) => nullRow(1000 + i, v))];
      route({ search: S_POOL, trades: synth(rows) });
      const r: any = await handleWashTrading({ subject: POOL });
      expect(r.verdict).toBe("inconclusive");
      expect(r.signals).toContain("trades_sampled=60"); expect(r.signals).toContain("unpriced_trades_excluded=90"); expect(r.signals).toContain("distinct_senders=15");
      expect(r.summary).toMatch(/90 unpriced excluded/);
    });
  }
  it("enough priced trades still answer when a few rows are unpriced", async () => {
    route({ search: S_POOL, trades: synth([...washRows(30), nullRow(5000, null)]) });
    const r: any = await handleWashTrading({ subject: POOL });
    expect(r.verdict).toBe("wash_trading"); expect(r.signals).toContain("unpriced_trades_excluded=1");
  });
  it("all rows unpriced is a refusal, not a verdict", async () => {
    route({ search: S_POOL, trades: synth([nullRow(1, null), nullRow(2, "")]) });
    await err(handleWashTrading({ subject: POOL }), 422, "NO_RECENT_TRADES");
  });
  for (const [label, v] of [["negative", "-5"], ["non-numeric", "abc"], ["boolean", true], ["NaN number", "NaN"]] as const) {
    it(`${label} volume is a malformed row (502)`, async () => {
      route({ search: S_POOL, trades: synth([...washRows(30), nullRow(7000, v)]) });
      await err(handleWashTrading({ subject: POOL }), 502, "INVALID_SOURCE_BODY");
    });
  }
  it("only the latest 300 rows are used (rows past 300 are ignored, even malformed ones)", async () => {
    const extra = Array.from({ length: 50 }, (_x, i) => ({ attributes: { kind: "swap", n: i } }));
    route({ search: S_POOL, trades: synth([...washRows(75), ...extra]) });
    const r: any = await handleWashTrading({ subject: POOL });
    expect(r.signals).toContain("trades_sampled=300");
  });
  it("source_anomalous_flags is n/a when the source omits the flag, a count when present", async () => {
    route({ search: S_POOL, trades: synth(washRows(30)) });
    expect(((await handleWashTrading({ subject: POOL })) as any).signals).toContain("source_anomalous_flags=n/a");
    const rows = washRows(30); rows[0].attributes.is_anomalous = true; rows[1].attributes.is_anomalous = false; rows[2].attributes.is_anomalous = true;
    route({ search: S_POOL, trades: synth(rows) });
    expect(((await handleWashTrading({ subject: POOL })) as any).signals).toContain("source_anomalous_flags=2");
  });
  it("summary discloses the window, arbitrage/market-maker limit and non-legal status", async () => {
    route({ search: S_POOL, trades: synth(washRows(30)) });
    const r: any = await handleWashTrading({ subject: POOL });
    expect(r.summary).toMatch(/latest-300-trade window at most/); expect(r.summary).toMatch(/arbitrage and market-maker bots/); expect(r.summary).toMatch(/not a legal finding/);
  });
  it("explicit zero-volume trades count toward MIN_TRADES and are disclosed", async () => {
    const zero = (i: number) => trade(i, i % 2 === 0 ? "buy" : "sell", 800 + (i % 20), 0);
    const rows = [...washRows(15).slice(0, 60), ...Array.from({ length: 40 }, (_x, i) => zero(2000 + i))];
    route({ search: S_POOL, trades: synth(rows) });
    const r: any = await handleWashTrading({ subject: POOL });
    expect(r.signals).toContain("zero_volume_trades_counted=40"); expect(r.signals).toContain("trades_sampled=100"); expect(r.signals).toContain("unpriced_trades_excluded=0");
    route({ search: S_POOL, trades: synth(washRows(30)) });
    expect(((await handleWashTrading({ subject: POOL })) as any).signals).toContain("zero_volume_trades_counted=0");
    // a priced trade between 0 and 1 USD is not a zero-volume trade (pins exact zero)
    const sub1 = Array.from({ length: 100 }, (_x, i) => trade(3000 + i, i % 2 === 0 ? "buy" : "sell", 900 + (i % 25), 0.5));
    route({ search: S_POOL, trades: synth(sub1) });
    expect(((await handleWashTrading({ subject: POOL })) as any).signals).toContain("zero_volume_trades_counted=0");
  });
  it("cache expires after 5 minutes", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const urls = route({ search: S_POOL, trades: T_ORGANIC });
    await handleWashTrading({ subject: POOL }); expect(urls.length).toBe(2);
    now += 299_000; await handleWashTrading({ subject: POOL }); expect(urls.length).toBe(2);
    now += 2_000; await handleWashTrading({ subject: POOL }); expect(urls.length).toBe(4);
  });
  it("a search row whose id is on another pool but whose address field equals the subject is not an exact match", async () => {
    const row = JSON.parse(S_POOL).data[0]; row.id = "eth_0x" + "ef".repeat(20);
    route({ search: JSON.stringify({ data: [row] }) });
    await err(handleWashTrading({ subject: POOL }), 422, "SUBJECT_NOT_A_POOL_OR_TOKEN");
  });
});

describe("route /v1/wash-trading", () => {
  it("serves 200 with the contract fields and the upstream is tracked as geckoterminal", async () => {
    route({ search: S_POOL, trades: T_ORGANIC });
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/wash-trading?subject=" + POOL });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(["wash_trading", "likely_wash_trading", "inconclusive", "organic"]).toContain(b.verdict);
    expect(typeof b.wash_volume_pct).toBe("number"); expect(Array.isArray(b.signals)).toBe(true); expect(b.subject).toBe(POOL);
    expect(getUpstreamsSnapshot().geckoterminal).toBeDefined();
    const bad = await app.inject({ method: "GET", url: "/v1/wash-trading?subject=PEPE" });
    expect(bad.statusCode).toBe(422);
    await app.close();
  });
  it("consumer mapping and format match the official contract", () => {
    expect(Object.keys(OUTPUT_MAPPING.WASH_TRADING_DETECTION_GENERAL)).toEqual(["subject", "verdict", "wash_volume_pct", "signals", "summary"]);
    expect(FIELD_FORMAT.WASH_TRADING_DETECTION_GENERAL.verdict).toEqual({ type: "enum", allowed: ["wash_trading", "likely_wash_trading", "inconclusive", "organic"] });
    expect(FIELD_FORMAT.WASH_TRADING_DETECTION_GENERAL.wash_volume_pct).toEqual({ type: "number" });
  });
  it("request metrics label the route with its intent", () => { expect(intentFor("/v1/wash-trading")).toBe("WASH_TRADING_DETECTION_GENERAL"); });
  it("the 502 path attributes failures to geckoterminal", () => { expect(INTENT_PRIMARY_UPSTREAM["wash-trading"]).toBe("geckoterminal"); });
});

describe("source failure classes through the real public-source reader", () => {
  const classLines = (spy: any) => spy.mock.calls.map((c: any[]) => { try { return JSON.parse(String(c[0])); } catch { return {}; } }).filter((o: any) => o.event === "wash_source_failure");
  const cases: [string, () => Response | Promise<never>, string, string][] = [
    ["HTTP 403", () => new Response("denied", { status: 403 }), "http_403", "TRADE_SOURCE_UNREACHABLE"],
    ["HTTP 429", () => new Response("slow down", { status: 429 }), "http_429", "UPSTREAM_RATE_LIMITED"],
    ["HTTP 404", () => new Response("no", { status: 404 }), "http_4xx", "TRADE_SOURCE_UNREACHABLE"],
    ["HTTP 503", () => new Response("down", { status: 503 }), "http_5xx", "TRADE_SOURCE_UNREACHABLE"],
    ["transport error", () => Promise.reject(new TypeError("fetch failed")), "transport", "TRADE_SOURCE_UNREACHABLE"],
  ];
  for (const [label, impl, cls, code] of cases) {
    it(`${label}: logs class ${cls} only, returns ${code}`, async () => {
      setWashFetchForTests(null); resetUpstreamsForTests();
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.stubGlobal("fetch", async () => impl());
      await err(handleWashTrading({ subject: POOL }), 502, code);
      const lines = classLines(info);
      expect(lines).toEqual([{ event: "wash_source_failure", class: cls }]);
      expect(JSON.stringify(info.mock.calls)).not.toContain(POOL);
      expect(getUpstreamsSnapshot().geckoterminal?.last_error).toBe(code === "UPSTREAM_RATE_LIMITED" ? "UPSTREAM_RATE_LIMITED" : "INDEXER_UNREACHABLE");
      vi.unstubAllGlobals();
    });
  }
  it("timeout: logs class timeout", async () => {
    setWashFetchForTests(null);
    vi.useFakeTimers();
    try {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.stubGlobal("fetch", (_u: string, init: any) => new Promise((_res, rej) => { init.signal.addEventListener("abort", () => rej(new Error("aborted"))); }));
      const p = handleWashTrading({ subject: POOL }).then(() => null, (e: any) => e);
      await vi.advanceTimersByTimeAsync(2600);
      const e: any = await p;
      expect(e).toBeInstanceOf(ApiError); expect(e.code).toBe("TRADE_SOURCE_UNREACHABLE");
      expect(classLines(info)).toEqual([{ event: "wash_source_failure", class: "timeout" }]);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
  it("our own start budget exhaustion is labelled budget and stays rate limited", async () => {
    setWashFetchForTests(async () => { throw Object.assign(new Error("x"), { status: 429 }); });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await err(handleWashTrading({ subject: POOL }), 502, "UPSTREAM_RATE_LIMITED");
    expect(classLines(info)).toEqual([{ event: "wash_source_failure", class: "budget" }]);
  });
  it("an out-of-set reader label (body_read) is logged as class other, never the raw label", async () => {
    setWashFetchForTests(null); resetUpstreamsForTests();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ pull(c) { c.error(new Error("broken body")); } }), { status: 200 }));
    await err(handleWashTrading({ subject: POOL }), 502, "TRADE_SOURCE_UNREACHABLE");
    expect(classLines(info)).toEqual([{ event: "wash_source_failure", class: "other" }]);
    vi.unstubAllGlobals();
  });
  it("an unlabelled failure is class other", async () => {
    setWashFetchForTests(async () => { throw new Error("weird"); });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await err(handleWashTrading({ subject: POOL }), 502, "TRADE_SOURCE_UNREACHABLE");
    expect(classLines(info)).toEqual([{ event: "wash_source_failure", class: "other" }]);
  });
});
