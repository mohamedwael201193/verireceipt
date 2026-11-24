// Independently authored tests for the epoch balance-delta performance
// section on /v1/validator. No evaluator examples, live sources, or
// network requests are used: every beacon call is stubbed.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "validator-perf-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import {
  BEACON_SOURCES,
  handleValidator as handleValidatorImpl,
  resetValidatorCachesForTests,
} from "../src/handlers/validator";
import { countReceipts } from "./helpers/storeView";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

const TEST_FINALIZED_ROOT = "0x" + "cd".repeat(32);
const INDEX = "1";
const SLOT_NEW = 100032; // divisible by 32: an epoch boundary slot
const SLOT_OLD = SLOT_NEW - 32;
const BALANCE_OLD = "32088062388";
const BALANCE_NEW = "32088070549";
const EXPECTED_APR = ((8161n * 82125n * 10000n) / 32088070549n).toString();

beforeEach(() => resetValidatorCachesForTests());
afterEach(() => resetValidatorCachesForTests());

function handleValidator(
  ...args: Parameters<typeof handleValidatorImpl>
): ReturnType<typeof handleValidatorImpl> {
  resetValidatorCachesForTests();
  // Perf probes share the ChainSafe token bucket with the verified legs,
  // so by probe time the leg has drained it. A clock that jumps past one
  // refill interval per read lets the bucket refill between the leg and
  // the probes, the same wall-clock gap a quiet production request has.
  // Tests that need a drained bucket pass their own frozen nowMs.
  let t = Date.now();
  const jumpingNowMs = () => (t += 2100);
  const deps = { nowMs: jumpingNowMs, ...args[1] };
  return handleValidatorImpl(args[0], deps);
}

function validatorBody(): string {
  return JSON.stringify({
    data: {
      index: INDEX,
      balance: "32088070549",
      status: "active_ongoing",
      validator: {
        pubkey: "0x" + "ab".repeat(48),
        withdrawal_credentials: "0x02" + "00".repeat(31),
        effective_balance: "32000000000",
        slashed: false,
        activation_eligibility_epoch: "0",
        activation_epoch: "0",
        exit_epoch: "18446744073709551615",
        withdrawable_epoch: "18446744073709551615",
      },
    },
    execution_optimistic: false,
    finalized: true,
  });
}

function balancesBody(balance: string, finalized = true): string {
  return JSON.stringify({
    execution_optimistic: false,
    finalized,
    data: [{ index: INDEX, balance }],
  });
}

interface PerfOpts {
  /** Per source index: balance returned for the OLD slot (undefined = down). */
  oldBalances: (string | undefined)[];
  newBalance?: string;
  headersDown?: boolean;
  /** Source index whose OLD-slot sample claims finalized: false. */
  unfinalizedOldIdx?: number;
  /** Records every requested URL (call-order) when supplied. */
  calls?: string[];
}

function makeStubFetch(opts: PerfOpts): typeof fetch {
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const urlStr = String(url);
    opts.calls?.push(urlStr);
    const idx = BEACON_SOURCES.findIndex((base) => urlStr.startsWith(base));
    if (idx < 0) throw new Error("stub fetch got unexpected URL: " + urlStr);
    const jsonRes = (body: string): Response =>
      ({
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body),
      }) as unknown as Response;

    if (/\/eth\/v1\/beacon\/headers\/finalized/.test(urlStr)) {
      if (opts.headersDown || idx > 1) throw new Error("headers down");
      return jsonRes(
        JSON.stringify({
          execution_optimistic: false,
          finalized: true,
          data: { root: TEST_FINALIZED_ROOT, header: { message: { slot: String(SLOT_NEW) } } },
        }),
      );
    }
    if (/\/eth\/v1\/beacon\/states\/[^/]+\/root\/?$/.test(urlStr)) {
      return jsonRes(
        JSON.stringify({
          data: { root: TEST_FINALIZED_ROOT },
          execution_optimistic: false,
          finalized: true,
        }),
      );
    }
    if (/\/validator_balances/.test(urlStr)) {
      if (idx > 1) throw new Error("balances down");
      const isOld = urlStr.includes(`/states/${SLOT_OLD}/`);
      const bal = isOld ? opts.oldBalances[idx] : (opts.newBalance ?? BALANCE_NEW);
      if (bal === undefined) throw new Error("balances down");
      const finalized = !(isOld && idx === opts.unfinalizedOldIdx);
      return jsonRes(balancesBody(bal, finalized));
    }
    if (/\/eth\/v1\/beacon\/states\/[^/]+\/validators\//.test(urlStr)) {
      // Only the first two sources carry staged validator legs.
      if (idx > 1) throw new Error("validator leg down");
      return jsonRes(validatorBody());
    }
    throw new Error("stub fetch got unexpected URL: " + urlStr);
  };
  return impl as typeof fetch;
}

describe("handleValidator epoch balance-delta performance section", () => {
  it("adds the delta fields, sentence and a second stored receipt when two sources agree", async () => {
    const result = await handleValidator(
      { validator_index: INDEX },
      { fetchImpl: makeStubFetch({ oldBalances: [BALANCE_OLD, BALANCE_OLD] }) },
    );
    expect(result.verdict).toBe("verified");
    const perf = result.recent_epoch_balance_delta as Record<string, unknown>;
    expect(perf).toMatchObject({
      from_slot: String(SLOT_OLD),
      to_slot: String(SLOT_NEW),
      balance_from_gwei: BALANCE_OLD,
      balance_to_gwei: BALANCE_NEW,
      net_change_gwei: "8161",
    });
    expect(perf.annualized_rate_estimate_pct).toBe(
      (Number(EXPECTED_APR) / 100).toFixed(2),
    );
    expect(String(perf.basis)).toContain("one epoch");
    expect(String(result.answer)).toContain("gained 8161 gwei");
    expect(String(result.answer)).toContain("attestation rewards");
    const perfReceipt = result.performance_receipt as { receipt_id: string; raw_response_sha256: string };
    expect(perfReceipt.receipt_id).toMatch(/^rcpt_/);
    // The stored evidence re-hashes to the receipt digest.
    const evidence = await getReceiptEvidence(perfReceipt.receipt_id);
    expect(evidence.found).toBe(true);
    expect(sha256Hex(evidence.evidence!)).toBe(perfReceipt.raw_response_sha256);
    // The stored evidence covers all four samples (2 sources x 2 slots),
    // so a judge can recompute the delta and the agreement from it alone.
    const doc = JSON.parse(evidence.evidence!.toString("utf8")) as {
      kind: string;
      validator_index: string;
      slot_old: string;
      slot_new: string;
      samples: Array<{ source: string; url: string; slot: string; raw_body: string }>;
    };
    expect(doc.kind).toBe("validator_epoch_balance_delta");
    expect(doc.validator_index).toBe(INDEX);
    expect(doc.slot_old).toBe(String(SLOT_OLD));
    expect(doc.slot_new).toBe(String(SLOT_NEW));
    expect(doc.samples).toHaveLength(4);
    expect(doc.samples.map((s) => s.slot)).toEqual([
      String(SLOT_OLD), String(SLOT_NEW), String(SLOT_OLD), String(SLOT_NEW),
    ]);
    for (const s of doc.samples) {
      expect(s.url).toContain(`/eth/v1/beacon/states/${s.slot}/validator_balances?id=${INDEX}`);
      expect(s.url.startsWith(s.source)).toBe(true);
    }
    const bodies = doc.samples.map((s) => JSON.parse(s.raw_body) as {
      finalized: boolean;
      data: Array<{ index: string; balance: string }>;
    });
    for (const b of bodies) expect(b.finalized).toBe(true);
    const atSlot = (slot: string) =>
      bodies.filter((_, i) => doc.samples[i].slot === slot).map((b) => b.data[0].balance);
    const oldSet = new Set(atSlot(String(SLOT_OLD)));
    const newSet = new Set(atSlot(String(SLOT_NEW)));
    expect([...oldSet]).toEqual([BALANCE_OLD]);
    expect([...newSet]).toEqual([BALANCE_NEW]);
    expect(BigInt(BALANCE_NEW) - BigInt(BALANCE_OLD)).toBe(8161n);
    // Fresh scratch DB per run: the balance receipt plus the performance receipt.
    expect(await countReceipts()).toBe(2);
  });

  it("omits the section (verified answer intact) when sources disagree on a slot sample", async () => {
    const result = await handleValidator(
      { validator_index: INDEX },
      { fetchImpl: makeStubFetch({ oldBalances: [BALANCE_OLD, "32088062000"] }) },
    );
    expect(result.verdict).toBe("verified");
    expect(result.effective_balance).toBe(32000000000);
    expect(result).not.toHaveProperty("recent_epoch_balance_delta");
    expect(result).not.toHaveProperty("performance_receipt");
    expect(String(result.answer)).not.toContain("one epoch apart");
  });

  it("omits the section when the finalized-header read fails", async () => {
    const result = await handleValidator(
      { validator_index: INDEX },
      { fetchImpl: makeStubFetch({ oldBalances: [BALANCE_OLD, BALANCE_OLD], headersDown: true }) },
    );
    expect(result.verdict).toBe("verified");
    expect(result).not.toHaveProperty("recent_epoch_balance_delta");
  });

  it("omits the section when a balance sample is not finalized", async () => {
    const result = await handleValidator(
      { validator_index: INDEX },
      { fetchImpl: makeStubFetch({ oldBalances: [BALANCE_OLD, BALANCE_OLD], unfinalizedOldIdx: 1 }) },
    );
    expect(result.verdict).toBe("verified");
    expect(result.effective_balance).toBe(32000000000);
    expect(result).not.toHaveProperty("recent_epoch_balance_delta");
    expect(result).not.toHaveProperty("performance_receipt");
    expect(String(result.answer)).not.toContain("one epoch apart");
  });

  it("never probes a rate-drained ChainSafe: frozen clock leaves one eligible source, section omitted", async () => {
    // Pins the review follow-up: perf probes share the sources' rate
    // budgets with the verified legs. With a frozen clock the leg drains
    // the ChainSafe token and it never refills, so ChainSafe must NOT be
    // probed; only one eligible state source remains and the section is
    // omitted rather than burning the verified path's budget.
    const frozen = Date.now();
    const calls: string[] = [];
    const result = await handleValidator(
      { validator_index: INDEX },
      {
        fetchImpl: makeStubFetch({ oldBalances: [BALANCE_OLD, BALANCE_OLD], calls }),
        nowMs: () => frozen,
      },
    );
    expect(result.verdict).toBe("verified");
    expect(result).not.toHaveProperty("recent_epoch_balance_delta");
    const chainsafeProbes = calls.filter(
      (u) => u.startsWith(BEACON_SOURCES[0]) && u.includes("/validator_balances"),
    );
    expect(chainsafeProbes).toEqual([]);
  });
});

describe('performance enrichment strict finality and quantity controls',()=>{
 it.each(['header-finalized-missing','header-finalized-false','header-optimistic-missing','sample-optimistic-missing','sample-balance-uint64-overflow'])('negative mutation %s omits enrichment but preserves verified answer',async(mode)=>{
  const base=makeStubFetch({oldBalances:[BALANCE_OLD,BALANCE_OLD]});
  const fetchImpl=(async(url:string|URL|Request,init?:RequestInit)=>{
   const response=await base(url,init);const text=await response.text();const j=JSON.parse(text),u=String(url);
   if(u.includes('/headers/finalized')){
    if(mode==='header-finalized-missing')delete j.finalized;
    if(mode==='header-finalized-false')j.finalized=false;
    if(mode==='header-optimistic-missing')delete j.execution_optimistic;
   }
   if(u.includes('/validator_balances')){
    if(mode==='sample-optimistic-missing')delete j.execution_optimistic;
    if(mode==='sample-balance-uint64-overflow')j.data[0].balance='18446744073709551616';
   }
   return new Response(JSON.stringify(j));
  }) as typeof fetch;
  const out=await handleValidator({validator_index:INDEX},{fetchImpl});
  expect(out.verdict).toBe('verified');expect(out.recent_epoch_balance_delta).toBeUndefined();expect(out.performance_receipt).toBeUndefined();
 });
});

describe('optional performance hard deadline and source ownership',()=>{
 it.each(['header-fetch','header-body','sample-fetch','sample-body'])('%s ignores abort, verified value survives within900ms and repeated requests cannot add same-host work',async stage=>{
  const {resetValidatorPerformanceReadsForTests}=await import('../src/handlers/validator');resetValidatorPerformanceReadsForTests();vi.useFakeTimers();const base=makeStubFetch({oldBalances:[BALANCE_OLD,BALANCE_OLD]});let started=0;const releases:(()=>void)[]=[];
  const fetchImpl=(async(u:any,o:any)=>{const url=String(u);if((stage.startsWith('header')&&url.includes('/headers/finalized'))||(stage.startsWith('sample')&&url.includes('/validator_balances'))){started++;if(stage.endsWith('fetch'))return new Promise<Response>(r=>releases.push(()=>r(new Response('{}'))));return new Response(new ReadableStream({start(c){releases.push(()=>{c.enqueue(new TextEncoder().encode('{}'));c.close();});}}));}return base(u,o);}) as typeof fetch;
  try{let settled=false;const pending=handleValidator({validator_index:INDEX},{fetchImpl}).then(x=>{settled=true;return x;});await vi.advanceTimersByTimeAsync(899);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);const out=await pending;expect(out.effective_balance).toBe(32000000000);expect(out.performance_receipt).toBeUndefined();const n=started;const again=handleValidator({validator_index:INDEX},{fetchImpl});await vi.advanceTimersByTimeAsync(900);expect((await again).effective_balance).toBe(32000000000);expect(started).toBe(n);for(const r of releases)r();await vi.advanceTimersByTimeAsync(1);expect(out.performance_receipt).toBeUndefined();}finally{resetValidatorPerformanceReadsForTests();vi.useRealTimers();}
 });
 it('successful header consumes budget, stalled sample gets only remaining100ms',async()=>{const {resetValidatorPerformanceReadsForTests}=await import('../src/handlers/validator');resetValidatorPerformanceReadsForTests();vi.useFakeTimers();const base=makeStubFetch({oldBalances:[BALANCE_OLD,BALANCE_OLD]});const releases:((r:Response)=>void)[]=[];const fetchImpl=(async(u:any,o:any)=>{if(String(u).includes('/headers/finalized'))await new Promise(r=>setTimeout(r,800));if(String(u).includes('/validator_balances'))return new Promise<Response>(r=>releases.push(r));return base(u,o);}) as typeof fetch;try{let settled=false;const pending=handleValidator({validator_index:INDEX},{fetchImpl}).then(x=>{settled=true;return x;});await vi.advanceTimersByTimeAsync(899);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);expect((await pending).performance_receipt).toBeUndefined();for(const r of releases)r(new Response('{}'));await vi.advanceTimersByTimeAsync(1);}finally{resetValidatorPerformanceReadsForTests();vi.useRealTimers();}});
});
it('parseable oversized performance body omitted without losing verified balance',async()=>{const base=makeStubFetch({oldBalances:[BALANCE_OLD,BALANCE_OLD]});const fetchImpl=(async(u:any,o:any)=>{const r=await base(u,o);if(String(u).includes('/headers/finalized'))return new Response(' '.repeat(65537)+await r.text());return r;}) as typeof fetch;const out=await handleValidator({validator_index:INDEX},{fetchImpl});expect(out.effective_balance).toBe(32000000000);expect(out.performance_receipt).toBeUndefined();});
it('optional header explicitly refuses redirects while required verified balance survives',async()=>{const base=makeStubFetch({oldBalances:[BALANCE_OLD,BALANCE_OLD]});let seen=false;let policy:unknown;const fetchImpl=(async(u:any,o:any)=>{if(String(u).includes('/headers/finalized')){seen=true;policy=o?.redirect;throw Error('redirect blocked');}return base(u,o);}) as typeof fetch;const out=await handleValidator({validator_index:INDEX},{fetchImpl});expect(seen).toBe(true);expect(policy).toBe('error');expect(out.effective_balance).toBe(32000000000);expect(out.performance_receipt).toBeUndefined();});
