// pc2-xtab-r7 (J1 residual 1): plate 08 states the per-intent upstream
// timeouts. This test reads the BACKEND source so the copy cannot drift
// from the real constants, and it fails if the backend ever starts
// constructing a CircuitBreaker (then the "no miner-side breaker" copy
// must be revisited).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTENTS, PLATES } from "./data";

const BACKEND = join(__dirname, "..", "..", "..", "..", "src");
const src = (rel: string) => readFileSync(join(BACKEND, rel), "utf8");

function constMs(file: string, name: string): number {
  const m = src(file).match(new RegExp(`const ${name}(?::\\s*number)?\\s*=\\s*([0-9_]+)\\s*;`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return Number(m[1].replace(/_/g, ""));
}

function allBackendFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return allBackendFiles(p);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

const s = (ms: number) => `${ms / 1000} s`;

describe("plate 08 matches the backend timeouts", () => {
  const plate = PLATES.find((p) => p.id === "sieve")!;

  it("route: per-RPC call budget and total deadline", () => {
    const quorum = constMs("handlers/optimalRoute.ts", "QUORUM_TIMEOUT_MS");
    const call = constMs("handlers/optimalRoute.ts", "CALL_TIMEOUT_MS");
    const total = constMs("handlers/optimalRoute.ts", "ROUTE_TOTAL_DEADLINE_MS");
    expect(quorum).toBe(call);
    expect(plate.desc).toContain(`route ${s(call)} per RPC call (${s(total)} total)`);
  });

  it("tvl: per-fetch cap and 2x wall budget", () => {
    const fetchMs = constMs("handlers/tvl.ts", "FETCH_TIMEOUT_MS");
    expect(src("handlers/tvl.ts")).toMatch(/REQUEST_WALL_BUDGET_MS = 2 \* FETCH_TIMEOUT_MS;/);
    expect(plate.desc).toContain(`TVL ${s(fetchMs)} per fetch (${s(2 * fetchMs)} total)`);
  });

  it("validator: one request budget = TIMEOUT_MS", () => {
    expect(src("handlers/validator.ts")).toMatch(/VALIDATOR_TIMEOUT_MS = TIMEOUT_MS;/);
    const t = constMs("config/limits.ts", "TIMEOUT_MS");
    expect(plate.desc).toContain(`validator ${s(t)} for the whole request`);
  });

  it("filings: per SEC request and per answer", () => {
    const per = constMs("handlers/filings.ts", "SEC_TIMEOUT_MS");
    const total = constMs("handlers/filings.ts", "SEC_DEADLINE_MS");
    expect(plate.desc).toContain(`filings ${s(per)} per SEC request (${s(total)} total)`);
  });

  it("tx: per RPC call", () => {
    const rpc = constMs("handlers/txLookup.ts", "RPC_TIMEOUT_MS");
    expect(plate.desc).toContain(`tx ${s(rpc)} per RPC call`);
  });

  it("grid: ingester fetch cap and on-demand fallback cap", () => {
    const ingest = constMs("jobs/gridIngester.ts", "FETCH_TIMEOUT_MS");
    expect(plate.desc).toContain(`${s(ingest)} per ingester fetch`);
    const fallback = src("jobs/gridIngester.ts").match(
      /export async function fetchCaisoDamLmp\([^)]*timeoutMs: number = ([0-9_]+)/,
    );
    expect(fallback).not.toBeNull();
    expect(plate.desc).toContain(`capped at ${s(Number(fallback![1].replace(/_/g, "")))}`);
  });

  it("the miner constructs no CircuitBreaker, and the plate says so", () => {
    const constructed = allBackendFiles(BACKEND).filter((f) => /new\s+CircuitBreaker\s*\(/.test(readFileSync(f, "utf8")));
    expect(constructed).toEqual([]);
    expect(plate.desc).toMatch(/miner itself runs no circuit breaker/);
    expect(plate.desc).not.toMatch(/per-upstream breaker/);
  });
});

describe("quorum and validator wording (J1 / J2 minors)", () => {
  it("tx quorum labels are per chain (polygon and base-sepolia are 2-of-2)", () => {
    const chains = src("config/chains.ts");
    for (const c of ["polygon", "\"base-sepolia\""]) {
      const block = chains.match(new RegExp(`${c}: \\[([^\\]]*)\\]`));
      expect(block).not.toBeNull();
      expect((block![1].match(/https:\/\//g) ?? []).length).toBe(2);
    }
    const tx = INTENTS.find((i) => i.key === "tx")!;
    expect(tx.upstreams).toContain("2-of-2 on Polygon, Base Sepolia");
    expect(tx.desc).toContain("2-of-2 on Polygon and Base Sepolia");
  });

  it("validator copy says finalized state (miner.yaml wording)", () => {
    const v = INTENTS.find((i) => i.key === "validator")!;
    expect(v.desc).toContain("at the finalized state");
  });
});
