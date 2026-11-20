// VeriReceipt Desk — Streamable HTTP MCP (mcp.ts).
//
// POST /mcp speaks JSON-RPC 2.0 (Streamable HTTP transport, plain
// JSON responses): initialize, tools/list, tools/call, ping. Keyless —
// no auth, no login — the same live escrow path as the web UI.
//   GET /llms.txt — plain-text agent quickstart (tools + curl snippets).
//
// Tools:
//   run_m13_allocation_check — full M13 audit (6 ranked escrow calls:
//     5 own intents + independent CRYPTO_PRICE_USD spot)
//   run_m12_dispatch_check   — full M12 dispatch (2 ranked escrow calls)
//   verify_receipt           — verify a signal_hash on the node
//   get_ledger               — paginated desk runs
//
// Every tool call that buys intelligence spends REAL Test USDC from the
// Desk payer escrow and is logged to the SQLite ledger as related-party
// traffic. There is no demo mode.
//
// SPEND CAPS: the run_* tools enforce the SAME caps as POST /desk/run
// (caps.ts: 5 free checks / IP / day, $2.00/day global), with the same
// counters and the same up-front reservation. verify_receipt and
// get_ledger buy nothing and are uncapped. A cap that existed only on
// the HTTP surface would not be a cap — the MCP surface is keyless and
// advertised in /llms.txt.

import type { FastifyInstance } from "fastify";
import { ApiError } from "../core/errors";
import { clientIp, reserveCaps, M12_RUN_COST_UUSDC, M13_RUN_COST_UUSDC } from "./caps";
import { validateM12Input } from "./policyM12";
import { validateM13Input } from "./policyM13";
import {
  deskRunToPublic,
  countDeskRuns,
  getDeskRunBySignalHash,
  listDeskRuns,
  markDeskRunVerified,
  updateDeskRunVerdict,
} from "./ledger";
import { RELATED_PARTY_DISCLOSURE, logBoughtCall } from "./routes";
import { runM12Scenario, runM13Scenario } from "./scenarios";
import { TelegraphClient, type Hex } from "./telegraphClient";

export interface McpDeps {
  client?: TelegraphClient;
  /** Override for tests: live Bitcoin tip height (default: mempool.space). */
  blockHeightFn?: () => Promise<number>;
  /** Override for tests: returns the current UTC day prefix YYYY-MM-DD. */
  todayPrefix?: () => string;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "verireceipt-desk", version: "2.0.0" };

const TOOLS = [
  {
    name: "run_m13_allocation_check",
    description:
      "Run a Mission 13 asset-allocation audit: buys 6 ranked Telegraph intents (tx lookup, filings, TVL, execution route, sanctions, independent CRYPTO_PRICE_USD spot) via escrow and returns a deterministic APPROVE / HOLD / REJECT verdict with a Why box and per-call receipts. Testnet Test USDC only. $0.06 per run; 5 free checks / IP / day, $2.00 / day global cap.",
    inputSchema: {
      type: "object",
      properties: {
        protocol: { type: "string", description: "DeFi protocol slug, e.g. aave-v3" },
        tx_hash: { type: "string", description: "0x-prefixed 64-hex counterparty transaction hash" },
        chain: { type: "string", description: "EVM chain: ethereum, base, arbitrum, optimism, polygon, sepolia" },
        issuer_entity: { type: "string", description: "Issuer / counterparty entity name" },
        period: { type: "string", description: "Filing search period, e.g. last 12 months" },
        trade_pair: { type: "string", description: "Must be ETH/USDC" },
        scenario_id: { type: "string", description: "Optional scenario label for the ledger" },
      },
      required: ["protocol", "tx_hash", "chain", "issuer_entity", "period", "trade_pair"],
    },
  },
  {
    name: "run_m12_dispatch_check",
    description:
      "Run a Mission 12 mining-power dispatch check: buys 2 ranked Telegraph intents (grid power price, hashprice) via escrow and returns a deterministic MINE / CURTAIL / HOLD verdict with a Why box and per-call receipts. Testnet Test USDC only. $0.02 per run; 5 free checks / IP / day, $2.00 / day global cap.",
    inputSchema: {
      type: "object",
      properties: {
        node_or_zone: { type: "string", description: "Pricing node or bidding zone, e.g. TH_NP15_GEN-APND" },
        interval_start: { type: "string", description: "ISO-8601 UTC settlement interval start" },
        breakeven_usd_per_mwh: { type: "number", description: "Hashprice break-even threshold in $/MWh" },
        scenario_id: { type: "string", description: "Optional scenario label for the ledger" },
      },
      required: ["node_or_zone", "interval_start", "breakeven_usd_per_mwh"],
    },
  },
  {
    name: "verify_receipt",
    description:
      "Verify a Desk signal_hash against the Telegraph node (GET /engine/v1/signal/<hash>). Returns verified=true only when verification.verified is true, and records the outcome in the ledger.",
    inputSchema: {
      type: "object",
      properties: {
        signal_hash: { type: "string", description: "0x-prefixed 64-hex signal hash" },
      },
      required: ["signal_hash"],
    },
  },
  {
    name: "get_ledger",
    description: "List Desk runs (ranked escrow calls) with signal_hash links, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Rows to return (default 20, max 100)" },
        offset: { type: "number", description: "Rows to skip (default 0)" },
      },
    },
  },
];

const LLMS_TXT = `# VeriReceipt Desk — agent quickstart

VeriReceipt Desk is a Mission 13 (Asset Management) + Mission 12 (Mining &
Power) decision app on the Telegraph network (Ethereum Sepolia testnet,
Test USDC only). It buys ranked Telegraph intelligence via escrow and
applies deterministic, fail-closed policies — no LLM anywhere.

${RELATED_PARTY_DISCLOSURE}

## MCP (Streamable HTTP, keyless)

POST https://verireceipt.onrender.com/mcp
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_m13_allocation_check","arguments":{"protocol":"aave-v3","tx_hash":"0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3","chain":"ethereum","issuer_entity":"Apple Inc","period":"last 12 months","trade_pair":"ETH/USDC"}}}

Tools: run_m13_allocation_check, run_m12_dispatch_check, verify_receipt, get_ledger.

## HTTP API

POST /desk/run   {"mission":"M13","protocol":"aave-v3","tx_hash":"0x...","chain":"ethereum","issuer_entity":"Apple Inc","period":"last 12 months","trade_pair":"ETH/USDC"}
POST /desk/run   {"mission":"M12","node_or_zone":"TH_NP15_GEN-APND","interval_start":"2026-11-19T00:00:00Z","breakeven_usd_per_mwh":40}
GET  /desk/ledger?page=1&limit=20
GET  /desk/stats
GET  /desk/verify?signal_hash=0x...

## Costs and caps

$0.01 per ranked call ($0.06 M13 audit, $0.02 M12 dispatch). 5 free live
checks / IP / day, $2.00 / day global cap — the same caps on the HTTP
API and on the MCP run_* tools. Verify any signal at
https://devnode.telegraphprotocol.com/engine/v1/signal/<signal_hash>.
`;

function mcpClient(deps: McpDeps): TelegraphClient {
  if (deps.client) return deps.client;
  const key = (process.env.DESK_PAYER_PRIVATE_KEY ?? "").trim();
  if (!key) {
    throw new ApiError(
      503,
      "DESK_NOT_FUNDED",
      "The Desk payer wallet is not configured on this server (DESK_PAYER_PRIVATE_KEY missing). No live check can run.",
    );
  }
  return new TelegraphClient({ privateKey: key as Hex });
}

function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: McpDeps,
  capsCtx?: { ip: string; day: string },
): Promise<Record<string, unknown>> {
  const client = mcpClient(deps);
  switch (name) {
    case "run_m13_allocation_check": {
      // Validate BEFORE reserving: a refusal must not consume quota.
      const input = validateM13Input({
        protocol: String(args.protocol ?? ""),
        tx_hash: String(args.tx_hash ?? ""),
        chain: String(args.chain ?? ""),
        issuer_entity: String(args.issuer_entity ?? ""),
        period: String(args.period ?? ""),
        trade_pair: String(args.trade_pair ?? ""),
      });
      const scenarioId =
        typeof args.scenario_id === "string" && args.scenario_id ? args.scenario_id : "mcp";
      // Same caps as POST /desk/run (caps.ts), same counters.
      const reservation = capsCtx
        ? reserveCaps(capsCtx.ip, capsCtx.day, M13_RUN_COST_UUSDC)
        : null;
      try {
        const outcome = await runM13Scenario(client, input, scenarioId, {
          onCall: (runId, call) => logBoughtCall(runId, "M13", scenarioId, call),
        });
        updateDeskRunVerdict(outcome.run_id, outcome.decision.verdict);
        return toolResult({
          run_id: outcome.run_id,
          mission: "M13",
          verdict: outcome.decision.verdict,
          checks: outcome.decision.checks,
          why: outcome.decision.why,
          calls: outcome.calls,
          total_cost_uusdc: outcome.total_cost_uusdc,
          total_cost_usd: outcome.total_cost_uusdc / 1_000_000,
          related_party: true,
          disclosure: RELATED_PARTY_DISCLOSURE,
        });
      } finally {
        reservation?.release();
      }
    }
    case "run_m12_dispatch_check": {
      const input = validateM12Input({
        node_or_zone: String(args.node_or_zone ?? ""),
        interval_start: String(args.interval_start ?? ""),
        breakeven_usd_per_mwh: Number(args.breakeven_usd_per_mwh),
      });
      const scenarioId =
        typeof args.scenario_id === "string" && args.scenario_id ? args.scenario_id : "mcp";
      const reservation = capsCtx
        ? reserveCaps(capsCtx.ip, capsCtx.day, M12_RUN_COST_UUSDC)
        : null;
      try {
        const outcome = await runM12Scenario(client, input, scenarioId, {
          blockHeightFn: deps.blockHeightFn,
          onCall: (runId, call) => logBoughtCall(runId, "M12", scenarioId, call),
        });
        updateDeskRunVerdict(outcome.run_id, outcome.decision.verdict);
        return toolResult({
          run_id: outcome.run_id,
          mission: "M12",
          verdict: outcome.decision.verdict,
          checks: outcome.decision.checks,
          why: outcome.decision.why,
          calls: outcome.calls,
          total_cost_uusdc: outcome.total_cost_uusdc,
          total_cost_usd: outcome.total_cost_uusdc / 1_000_000,
          related_party: true,
          disclosure: RELATED_PARTY_DISCLOSURE,
        });
      } finally {
        reservation?.release();
      }
    }
    case "verify_receipt": {
      const signalHash = String(args.signal_hash ?? "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(signalHash)) {
        throw new ApiError(
          400,
          "INVALID_SIGNAL_HASH",
          "signal_hash must be a 0x-prefixed 64-hex-character hash",
        );
      }
      const { verified, body } = await client.verifySignal(signalHash);
      markDeskRunVerified(
        signalHash,
        verified ? "verified" : "failed",
        JSON.stringify(body).slice(0, 4000),
      );
      return toolResult({ signal_hash: signalHash, verified, verification: body });
    }
    case "get_ledger": {
      const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20) || 20));
      const offset = Math.max(0, Number(args.offset ?? 0) || 0);
      const rows = listDeskRuns(limit, offset);
      return toolResult({
        total: countDeskRuns(),
        limit,
        offset,
        runs: rows.map(deskRunToPublic),
      });
    }
    default:
      throw new ApiError(400, "UNKNOWN_TOOL", `Unknown MCP tool: ${name}`);
  }
}

export function registerMcp(app: FastifyInstance, deps: McpDeps = {}): void {
  const today = deps.todayPrefix ?? (() => new Date().toISOString().slice(0, 10));

  app.get("/llms.txt", async (_request, reply) => {
    return reply.type("text/plain; charset=utf-8").send(LLMS_TXT);
  });

  app.post("/mcp", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || body.jsonrpc !== "2.0") {
      return reply.status(400).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: expected JSON-RPC 2.0" },
      });
    }
    const id = body.id ?? null;
    const method = body.method;
    try {
      if (method === "initialize") {
        return reply.send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
      }
      if (method === "notifications/initialized" || method === "ping") {
        if (method === "ping") {
          return reply.send({ jsonrpc: "2.0", id, result: {} });
        }
        return reply.status(202).send();
      }
      if (method === "tools/list") {
        return reply.send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      }
      if (method === "tools/call") {
        const params = (body.params ?? {}) as Record<string, unknown>;
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        // Caps context: the caller's socket IP (XFF never trusted) and
        // the current UTC day. Read-only tools ignore it.
        const result = await callTool(name, args, deps, {
          ip: clientIp(request),
          day: today(),
        });
        return reply.send({ jsonrpc: "2.0", id, result });
      }
      return reply.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error (${err.status} ${err.code}): ${err.message}` }],
            isError: true,
          },
        });
      }
      return reply.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  });
}

export function getDeskRunBySignalHashPublic(signalHash: string): Record<string, unknown> | null {
  const row = getDeskRunBySignalHash(signalHash);
  return row ? deskRunToPublic(row) : null;
}
