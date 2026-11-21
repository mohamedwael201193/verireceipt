// A1 round 9 — one test per J2-r8 finding (M1 + m1..m8) and the J1-r8
// minors that touch code. Stubbed blocks answer from small in-memory
// payloads; every expected count is computed from those payloads.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync } from 'fs';
import { join, resolve } from 'path';

const SCRATCH = resolve(process.cwd(), '..', 'tmp', 'filings-r9-db');
mkdirSync(SCRATCH, { recursive: true });
process.env.SQLITE_PATH = join(mkdtempSync(join(SCRATCH, 'db-')), 'verireceipt.sqlite');

import type { FastifyInstance } from 'fastify';
import { ApiError } from '../src/core/errors';
import { getReceiptEvidence } from '../src/core/db';
import {
  handleFilings,
  formFamily,
  FORM_FAMILIES,
  MAX_SEC_DOCUMENT_CHARS,
  parseFormType,
  __clearTickersCacheForTests,
  __seedTickersCacheForTests,
} from '../src/handlers/filings';
import { EDGAR_FORM_TYPES, EDGAR_FORM_TYPES_SOURCE } from '../src/handlers/edgarFormTypes';
import { buildServer } from '../src/server';

const TEST_UA =
  (process.env.SEC_USER_AGENT_LIVE ?? process.env.SEC_USER_AGENT ?? '').trim() ||
  'VeriReceipt-Test/2.0 (test-only; set SEC_USER_AGENT_LIVE="Name contact@email" for live runs)';

// Real company_tickers.json entries (CIK / ticker / title as SEC publishes them).
const R9_TICKERS = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 1318605, ticker: 'TSLA', title: 'Tesla, Inc.' },
  '2': { cik_str: 831001, ticker: 'C', title: 'CITIGROUP INC' },
  '3': { cik_str: 896159, ticker: 'CB', title: 'Chubb Ltd' },
  '4': { cik_str: 1141391, ticker: 'MA', title: 'Mastercard Inc' },
  '5': { cik_str: 715957, ticker: 'D', title: 'DOMINION ENERGY, INC' },
  '6': { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
};

type Row = [accession: string, date: string, form: string];

const ROWS: Record<number, Row[]> = {
  320193: [
    ['0000320193-25-000010', '2025-02-14', 'SCHEDULE 13G/A'],
    ['0000320193-24-000020', '2024-12-20', 'SCHEDULE 13G/A'],
    ['0000320193-24-000010', '2024-02-14', 'SC 13G/A'],
    ['0000320193-23-000106', '2023-11-03', '10-K'],
    ['0000320193-23-000054', '2023-06-02', 'SC 13G/A'],
    ['0000320193-23-000055', '2023-02-10', 'SC 13G/A'],
    ['0000320193-23-000056', '2023-02-11', 'SC 13G'],
    ['0000320193-23-000057', '2023-03-01', 'SC TO-T'],
    ['0000320193-23-000058', '2023-04-01', 'SEC STAFF ACTION'],
    ['0000320193-23-000059', '2023-04-02', 'ANE EXCEP NOTICE'],
  ],
  1067983: [
    ['0001067983-25-000003', '2025-05-01', 'SCHEDULE 13D/A'],
    ['0001067983-25-000002', '2025-02-14', 'SCHEDULE 13G'],
    ['0001067983-25-000001', '2025-01-10', 'SC 13D/A'],
    ['0001067983-23-000002', '2023-02-14', 'SC 13G'],
    ['0001067983-23-000001', '2023-01-10', 'SC 13D/A'],
  ],
  1318605: [
    ['0001318605-23-000002', '2023-01-31', '10-K'],
    ['0001318605-23-000001', '2023-04-24', '10-Q'],
  ],
  831001: [
    ['0000831001-23-000001', '2023-02-24', '10-K'],
    ['0000831001-23-000002', '2023-03-01', '8-K'],
  ],
  896159: [
    ['0000896159-23-000001', '2023-02-24', '10-K'],
    ['0000896159-23-000004', '2023-03-02', '4'],
    ['0000896159-23-000005', '2023-03-03', '4'],
  ],
  1141391: [
    ['0001141391-23-000001', '2023-02-14', '10-K'],
    ['0001141391-23-000002', '2023-04-27', '10-Q'],
  ],
  715957: [
    ['0000715957-23-000001', '2023-02-24', '10-K'],
    ['0000715957-23-000002', '2023-05-01', '8-K'],
    ['0000715957-23-000003', '2023-06-01', '8-K'],
  ],
};

function recentOf(rows: Row[]): Record<string, string[]> {
  return {
    accessionNumber: rows.map((r) => r[0]),
    filingDate: rows.map((r) => r[1]),
    form: rows.map((r) => r[2]),
    primaryDocument: rows.map((r) => `${r[0]}.htm`),
  };
}

interface Calls {
  pages: string[];
}

function stub(opts: { rows?: Record<number, Row[]>; files?: Record<number, unknown[]>; pages?: Record<string, string>; calls?: Calls } = {}): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    const page = /data\.sec\.gov\/submissions\/(CIK\d{10}-submissions-\d{3}\.json)$/.exec(url);
    if (page) {
      opts.calls?.pages.push(page[1]);
      const body = opts.pages?.[page[1]];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }
    const m = /data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/.exec(url);
    if (m) {
      const cik = Number(m[1]);
      const rows = (opts.rows ?? ROWS)[cik];
      if (!rows) return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({
          cik: String(cik),
          name: Object.values(R9_TICKERS).find((e) => e.cik_str === cik)?.title ?? 'x',
          filings: { recent: recentOf(rows), files: opts.files?.[cik] ?? [] },
        }),
        { status: 200 },
      );
    }
    throw new Error(`r9 stub: unexpected URL ${url}`);
  }) as unknown as typeof fetch;
}

async function refuse(query: Record<string, string>, status: number, code: string, f?: typeof fetch, extra: object = {}): Promise<ApiError> {
  try {
    await handleFilings(query, { fetchImpl: f ?? stub(), ...extra });
  } catch (err) {
    expect(err, JSON.stringify(query)).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status, JSON.stringify(query)).toBe(status);
    expect(e.code, JSON.stringify(query)).toBe(code);
    return e;
  }
  throw new Error(`expected ${status} ${code} for ${JSON.stringify(query)}, got an answer`);
}

const ask = (q: Record<string, string>, f?: typeof fetch) => handleFilings(q, { fetchImpl: f ?? stub() });

describe('A1 r9 stubbed: J2-r8 findings', () => {
  beforeEach(() => {
    process.env.SEC_USER_AGENT = TEST_UA;
    __clearTickersCacheForTests();
    __seedTickersCacheForTests(R9_TICKERS as never);
  });

  it('M1: the alias table is exactly the four Schedule 13D/13G spellings renamed in EDGAR Release 24.4, all in the closed vocab', () => {
    expect(FORM_FAMILIES).toEqual([
      ['SC 13D', 'SCHEDULE 13D'],
      ['SC 13D/A', 'SCHEDULE 13D/A'],
      ['SC 13G', 'SCHEDULE 13G'],
      ['SC 13G/A', 'SCHEDULE 13G/A'],
    ]);
    for (const fam of FORM_FAMILIES) for (const f of fam) expect(EDGAR_FORM_TYPES).toContain(f);
    expect(formFamily('SCHEDULE 13G/A')).toEqual(['SC 13G/A', 'SCHEDULE 13G/A']);
    // Not renamed (still filed under the SC spelling in 2026; no SCHEDULE twin) / a new version, not a rename.
    for (const f of ['SC TO-T', 'SC TO-I', 'SC TO-C', 'SC 14D9', 'SC 13E3', 'SC 14F1', 'SC 14N', 'N-MFP2', 'N-MFP3', '10-K']) {
      expect(formFamily(f), f).toEqual([f]);
    }
  });

  it('M1: "Schedule 13G/A" in 2023 counts the SC 13G/A rows (J2 repro: Apple 2023 was a verified 0)', async () => {
    const r = await ask({ entity: 'Apple Inc. Schedule 13G/A', period: '2023' });
    expect(r.filing_count).toBe(2);
    expect(r.form_type).toBe('SCHEDULE 13G/A');
    expect(r.forms_counted).toEqual(['SC 13G/A', 'SCHEDULE 13G/A']);
    expect(r.form_counts).toEqual({ 'SC 13G/A': 2, 'SCHEDULE 13G/A': 0 });
    expect(String(r.form_alias_source)).toContain('edgar-release-24-4');
    expect(String(r.answer)).toContain('SC 13G/A 2 + SCHEDULE 13G/A 0');
  });

  it('M1: "SC 13G/A" in 2025 counts SCHEDULE 13G/A rows; a year spanning the rename counts both spellings', async () => {
    const r25 = await ask({ entity: 'Apple Inc. SC 13G/A', period: '2025' });
    expect(r25.filing_count).toBe(1);
    expect(r25.form_counts).toEqual({ 'SC 13G/A': 0, 'SCHEDULE 13G/A': 1 });
    const r24 = await ask({ entity: 'Apple Inc.', period: '2024', form_type: 'SCHEDULE 13G/A' });
    expect(r24.filing_count).toBe(2);
    expect(r24.form_counts).toEqual({ 'SC 13G/A': 1, 'SCHEDULE 13G/A': 1 });
    expect((r24.filings_detail as Array<{ form: string }>).map((f) => f.form).sort()).toEqual(['SC 13G/A', 'SCHEDULE 13G/A']);
  });

  it('M1: originals and amendments stay distinct; 13D and 13G stay distinct; agreement across fields is family-aware', async () => {
    expect((await ask({ entity: 'Apple Inc. SC 13G', period: '2023' })).filing_count).toBe(1);
    const b25 = await ask({ entity: 'BERKSHIRE HATHAWAY INC SC 13D/A', period: '2025' });
    expect(b25.filing_count).toBe(2);
    expect(b25.form_counts).toEqual({ 'SC 13D/A': 1, 'SCHEDULE 13D/A': 1 });
    expect((await ask({ entity: 'BERKSHIRE HATHAWAY INC SC 13G', period: '2025' })).filing_count).toBe(1);
    // The same family named in two fields is one request, not a conflict.
    const both = await ask({ entity: 'Apple Inc. Schedule 13G/A', period: '2023', form_type: 'SC 13G/A' });
    expect(both.filing_count).toBe(2);
    await refuse({ entity: 'Apple Inc. Schedule 13G/A', period: '2023', form_type: 'SC 13D/A' }, 422, 'CONFLICTING_FORM_TYPE');
  });

  it('M1: a form outside any family answers exactly as before and carries no alias source', async () => {
    const r = await ask({ entity: 'Apple Inc.', period: '2023', form_type: 'SC TO-T' });
    expect(r.filing_count).toBe(1);
    expect(r.forms_counted).toEqual(['SC TO-T']);
    expect(r.form_alias_source).toBeUndefined();
    expect(String(r.answer)).not.toContain('Release 24.4');
    const none = await ask({ entity: 'Apple Inc.', period: '2023' });
    expect(none.forms_counted).toBeUndefined();
  });

  // ---- m1 / m2: history pages ----
  const pageOf = (rows: Row[]) => JSON.stringify(recentOf(rows));
  const recentApple: Row[] = [['0000320193-23-000106', '2023-11-03', '10-K']];
  const pageName = (n: number) => `CIK0000320193-submissions-00${n}.json`;

  it('m1 (stub D1): a row drifting > 7 days after the filingTo of a NON-overlapping page fails closed (502), never a verified 0', async () => {
    const lower: Row[] = [['0000320193-20-000001', '2020-07-02', '8-K'], ['0000320193-20-000002', '2020-03-01', '8-K']];
    const upper: Row[] = [['0000320193-20-000003', '2020-08-01', '8-K']];
    const calls: Calls = { pages: [] };
    const f = stub({
      calls,
      rows: { 320193: recentApple },
      files: { 320193: [
        { name: pageName(1), filingCount: 1, filingFrom: '2020-07-15', filingTo: '2020-12-31' },
        { name: pageName(2), filingCount: 2, filingFrom: '2020-01-01', filingTo: '2020-06-20' },
      ] },
      pages: { [pageName(1)]: pageOf(upper), [pageName(2)]: pageOf(lower) },
    });
    const e = await refuse({ entity: 'AAPL', period: '2020-07-01..2020-07-31' }, 502, 'SEC_UNAVAILABLE', f);
    expect(e.message).toContain('does not match its index entry');
    expect(calls.pages.sort()).toEqual([pageName(1), pageName(2)]);
  });

  it('m1 (stub D3): a row drifting > 7 days before the filingFrom of a NON-overlapping later page fails closed (502)', async () => {
    const later: Row[] = [['0000320193-20-000004', '2020-06-25', '8-K'], ['0000320193-20-000005', '2020-08-01', '8-K']];
    const f = stub({
      rows: { 320193: recentApple },
      files: { 320193: [{ name: pageName(1), filingCount: 2, filingFrom: '2020-07-10', filingTo: '2020-12-31' }] },
      pages: { [pageName(1)]: pageOf(later) },
    });
    await refuse({ entity: 'AAPL', period: '2020-06-01..2020-06-30' }, 502, 'SEC_UNAVAILABLE', f);
  });

  it('m1: drift of exactly 7 days in a neighbour page is inside the slack and the answer stays exact', async () => {
    const lower: Row[] = [['0000320193-20-000001', '2020-06-27', '8-K']];
    const f = stub({
      rows: { 320193: recentApple },
      files: { 320193: [{ name: pageName(1), filingCount: 1, filingFrom: '2020-01-01', filingTo: '2020-06-20' }] },
      pages: { [pageName(1)]: pageOf(lower) },
    });
    const r = await ask({ entity: 'AAPL', period: '2020-07-01..2020-07-31' }, f);
    expect(r.filing_count).toBe(0);
  });

  it('m2 (stub T1): a needed page whose index entry has no filingCount fails closed (502)', async () => {
    const rows: Row[] = [['0000320193-20-000001', '2020-03-01', '8-K']];
    const f = stub({
      rows: { 320193: recentApple },
      files: { 320193: [{ name: pageName(1), filingFrom: '2020-01-01', filingTo: '2020-06-20' }] },
      pages: { [pageName(1)]: pageOf(rows) },
    });
    const e = await refuse({ entity: 'AAPL', period: '2020' }, 502, 'SEC_UNAVAILABLE', f);
    expect(e.message).toContain('filingCount');
  });

  it('m3: an oversized history page (> MAX_SEC_DOCUMENT_CHARS) fails closed (502 SEC_DOCUMENT_TOO_LARGE)', async () => {
    expect(MAX_SEC_DOCUMENT_CHARS).toBe(8_000_000);
    const rows: Row[] = [['0000320193-20-000001', '2020-03-01', '8-K']];
    const big = JSON.stringify({ ...recentOf(rows), pad: 'x'.repeat(MAX_SEC_DOCUMENT_CHARS) });
    const f = stub({
      rows: { 320193: recentApple },
      files: { 320193: [{ name: pageName(1), filingCount: 1, filingFrom: '2020-01-01', filingTo: '2020-06-20' }] },
      pages: { [pageName(1)]: big },
    });
    await refuse({ entity: 'AAPL', period: '2020' }, 502, 'SEC_DOCUMENT_TOO_LARGE', f);
  });

  // ---- m4: ticker + form ----
  it('m4: an exact ticker that is also a form word, plus a second form, resolves (C 10-K, CB Form 4 filings, MA 10-K, Form 8-K filings by D)', async () => {
    const cases: Array<[string, number, string, number]> = [
      ['C 10-K', 1, '10-K', 831001],
      ['CB Form 4 filings', 2, '4', 896159],
      ['MA 10-K', 1, '10-K', 1141391],
      ['Form 8-K filings by D', 2, '8-K', 715957],
    ];
    for (const [entity, count, form, cik] of cases) {
      const r = await ask({ entity, period: '2023' });
      expect(r.filing_count, entity).toBe(count);
      expect(r.form_type, entity).toBe(form);
      expect((r.receipt as { upstream_url: string }).upstream_url, entity).toContain(String(cik).padStart(10, '0'));
    }
  });

  it('m4: lowercase ticker + filings never says MISSING_ENTITY; a pure filler entity still does', async () => {
    for (const entity of ['c filings', 'ma filings']) {
      try {
        const r = await ask({ entity, period: '2023' });
        expect(r.filing_count, entity).toBeGreaterThan(0);
      } catch (err) {
        expect(err, entity).toBeInstanceOf(ApiError);
        expect((err as ApiError).code, entity).not.toBe('MISSING_ENTITY');
      }
    }
    await refuse({ entity: 'the filings', period: '2023' }, 400, 'MISSING_ENTITY');
  });

  // ---- m5: separators and form_type=all ----
  it('m5: form_type "10;K" / "10|K" fold like the entity (10-K); a real list is still 422', async () => {
    for (const ft of ['10;K', '10|K', '10 ; K']) {
      expect(parseFormType(ft)).toEqual({ kind: 'form', form: '10-K' });
      expect((await ask({ entity: 'Tesla, Inc.', period: '2023', form_type: ft })).filing_count, ft).toBe(1);
    }
    for (const ft of ['10-K;10-Q', '10-K|8-K', '10-K, 10-Q']) {
      await refuse({ entity: 'Tesla, Inc.', period: '2023', form_type: ft }, 422, 'MULTIPLE_FORM_TYPES');
    }
  });

  it('m5: form_type=all against a form named in the entity is 422 CONFLICTING_FORM_TYPE; all alone still counts every form', async () => {
    for (const ft of ['all', 'ANY', '*']) {
      await refuse({ entity: 'Tesla, Inc. 10-K', period: '2023', form_type: ft }, 422, 'CONFLICTING_FORM_TYPE');
    }
    expect((await ask({ entity: 'Tesla, Inc.', period: '2023', form_type: 'all' })).filing_count).toBe(2);
  });

  // ---- m6: closed list = full-index ∪ live submissions forms ----
  it('m6: the closed vocabulary is the 739-form UNION of full-index form.gz and live submissions (SEC STAFF ACTION, ANE EXCEP NOTICE)', () => {
    expect(EDGAR_FORM_TYPES.length).toBe(739);
    expect(EDGAR_FORM_TYPES_SOURCE.entries).toBe(739);
    expect(EDGAR_FORM_TYPES_SOURCE.source).toMatch(/UNION live submissions/);
    expect(EDGAR_FORM_TYPES_SOURCE.submissions_last_modified).toBe('Fri, 20 Nov 2026 05:00:09 GMT');
    for (const f of ['SEC STAFF ACTION', 'ANE EXCEP NOTICE', 'SEC STAFF LETTER', 'SCHEDULE 13G/A', 'SC 13G/A']) {
      expect(EDGAR_FORM_TYPES, f).toContain(f);
      expect(parseFormType(f)).toEqual({ kind: 'form', form: f });
    }
  });

  it('m6: a submissions-only form (SEC STAFF ACTION / ANE EXCEP NOTICE) is answered, not 422 UNKNOWN_FORM', async () => {
    const a = await ask({ entity: 'Apple Inc.', period: '2023', form_type: 'SEC STAFF ACTION' });
    expect(a.filing_count).toBe(1);
    expect(a.form_type).toBe('SEC STAFF ACTION');
    const b = await ask({ entity: 'Apple Inc. ANE EXCEP NOTICE', period: '2023' });
    expect(b.filing_count).toBe(1);
    expect(b.form_type).toBe('ANE EXCEP NOTICE');
  });

  // ---- m8: receipt store failure ----
  it('m8: a failed receipt save fails closed with 500 RECEIPT_STORE_FAILED (no verified answer with a dead audit link)', async () => {
    const e = await refuse({ entity: 'Tesla, Inc.', period: '2023' }, 500, 'RECEIPT_STORE_FAILED', stub(), {
      saveReceiptImpl: () => {
        throw new Error('disk full');
      },
    });
    expect(e.message).not.toContain('disk full');
    // The normal path still persists the receipt.
    const r = await ask({ entity: 'Tesla, Inc.', period: '2023' });
    expect(getReceiptEvidence((r.receipt as { receipt_id: string }).receipt_id)).not.toBeNull();
  });
});

describe('A1 r9 HTTP: m7 prototype keys', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    process.env.SEC_USER_AGENT = TEST_UA;
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('m7: __proto__ / constructor / prototype query keys are 400 UNKNOWN_PARAM over HTTP', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const res = await app.inject({ method: 'GET', url: `/v1/filings?entity=Tesla&period=2023&form_type=10-K&${key}=x` });
      expect(res.statusCode, key).toBe(400);
      expect(res.json().code ?? res.json().error_code ?? JSON.stringify(res.json()), key).toMatch(/UNKNOWN_PARAM/i);
    }
  });
});
