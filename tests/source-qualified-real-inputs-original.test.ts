import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const scratch = vi.hoisted(() => {
  const path = `/tmp/source-qualified-grid-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path; delete process.env.DATABASE_URL; return path;
});
import { closeStorage, getReceiptEvidence, initStorage, saveGridPrice } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
import { handleGridPrice } from '../src/handlers/gridPrice';
import { PAIR_REGISTRY, classifyPair, parsePair } from '../src/handlers/optimalRoute';

// Original inputs derive from fresh ordinary ISO/SEC sources and our own
// registry only. Actual captured prices/dates are unchanged; EUR conversion
// uses the captured real FX rate. SQLite and receipt evidence are real local
// writes. Only the execution clock is controlled. No fabricated source body,
// mocked data, production write, protected example or other-provider handler.
const source = JSON.parse(readFileSync(join(__dirname, 'fixtures/source-qualified-real-inputs.json'), 'utf8'));
interface SourceRow { canonical: string; qualified: string; native_name?: string; native_qualified?: string;
  interval_start: string; price_usd: number; market: string; source_url: string }
const rows = source.source_rows as SourceRow[];
const captureClock = Math.max(...source.sources.map((s: { captured_at: string }) => Date.parse(s.captured_at))) + 1000;
const networkBoundary = vi.fn(async () => { throw new Error('Unexpected external IO in captured-source controls'); });
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(captureClock);
  vi.stubGlobal('fetch', networkBoundary); await initStorage();
  for (const row of rows) await saveGridPrice(row.canonical, row.interval_start, row.price_usd,
    row.market, new Date(captureClock).toISOString(), row.source_url);
});
afterAll(async () => {
  expect(networkBoundary).not.toHaveBeenCalled();
  await closeStorage(); vi.unstubAllGlobals(); vi.useRealTimers();
  for (const suffix of ['', '-wal', '-shm']) rmSync(scratch + suffix, { force: true });
});
async function gridReading(row: SourceRow, spelling: string) {
  const out = await handleGridPrice({ node_or_zone: spelling, interval_start: row.interval_start });
  expect(out.lmp_usd_per_mwh).toBe(row.price_usd); expect(out.verdict).toBe('verified');
  const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
  const saved = await getReceiptEvidence(receipt.receipt_id); expect(saved.found).toBe(true);
  expect(sha256Hex(saved.evidence!)).toBe(receipt.raw_response_sha256);
  return { out, bytes: saved.evidence!.toString('utf8'), hash: receipt.raw_response_sha256 };
}
for (const row of rows) describe(`real source ${row.market} ${row.canonical}`, () => {
  it('retains the healthy bare identifier and exact captured price/receipt', async () => {
    const result = await gridReading(row, row.canonical); expect(result.out.node_or_zone).toBe(row.canonical);
  });
  for (const spelling of [row.qualified, ` \t${row.qualified.toLowerCase()} \n`]) {
    it(`resolves exact source-qualified identity ${JSON.stringify(spelling)} without changing evidence`, async () => {
      const bare = await gridReading(row, row.canonical), qualified = await gridReading(row, spelling);
      expect(qualified.out.node_or_zone).toBe(row.canonical);
      expect(qualified.bytes).toBe(bare.bytes); expect(qualified.hash).toBe(bare.hash);
    });
  }
  if (row.native_name && row.native_qualified) it('keeps the official feed-name alias within its exact market', async () => {
    const bare = await gridReading(row, row.native_name!), qualified = await gridReading(row, row.native_qualified!);
    expect(qualified.out.node_or_zone).toBe(row.native_name);
    expect(qualified.bytes).toBe(bare.bytes);
  });
});
for (const spelling of ['NYISO EE', 'ELERING ZONE_A', 'CAISO ZONE_A', 'NYISO NYISO ZONE_A', 'ELERING NYISO ZONE_A']) {
  it(`does not cross markets or recursively strip qualifiers: ${spelling}`, async () => {
    await expect(handleGridPrice({ node_or_zone: spelling, interval_start: rows[0].interval_start }))
      .rejects.toMatchObject({ status: 422, code: 'UNSUPPORTED_ZONE' });
  });
}
for (const spec of PAIR_REGISTRY) it(`own registered route stays recognized without changing economics: ${spec.pair}`, () => {
  const [sell, buy] = spec.pair.split('/');
  for (const raw of [spec.pair, `${sell.toLowerCase()}-${buy.toLowerCase()}`, `\t${spec.sellToken}->${spec.buyToken}\t`]) {
    expect(parsePair(raw)).toBe(spec); expect(classifyPair(raw)).toEqual({ kind: 'registered', spec });
  }
});
