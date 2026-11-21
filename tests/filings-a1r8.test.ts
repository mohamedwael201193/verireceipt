// A1 round 8 — one test per J1-r7 / J2-r7 finding plus the parent's settled
// decisions (SEC EDGAR only, closed EDGAR form vocabulary, separator /
// spaced-form / homoglyph folding, longest-match entity resolution,
// timeouts, history-page validation, size cap, receipts with pages).
//
// Stubbed blocks answer from small in-memory payloads whose expected
// counts are computed from those payloads. LIVE blocks hit the real SEC
// EDGAR APIs and assert the ground truth the judges measured (J1-r7
// truth.json, J2-r7 verdict), re-verified live on 2026-11-21.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync } from 'fs';
import { join, resolve } from 'path';

const SCRATCH = resolve(process.cwd(), '..', 'tmp', 'filings-r8-db');
mkdirSync(SCRATCH, { recursive: true });
process.env.SQLITE_PATH = join(mkdtempSync(join(SCRATCH, 'db-')), 'verireceipt.sqlite');

import { ApiError } from '../src/core/errors';
import { getReceiptEvidence, getReceiptPageEvidence, getReceiptPages } from '../src/core/db';
import { handleFilings, parsePeriod, __clearTickersCacheForTests, __seedTickersCacheForTests } from '../src/handlers/filings';
import { EDGAR_FORM_TYPES, EDGAR_FORM_TYPES_SOURCE } from '../src/handlers/edgarFormTypes';
import { canonicalFormOrThrow } from '../src/handlers/filingsForms';
import { scanAllTitles } from './helpers/filingsTitleScan';

// J1-r8 m4: SEC fair-access guidance asks for a contact e-mail in the
// User-Agent. The LIVE tests take it from the environment (in-process
// only, never printed or committed): SEC_USER_AGENT_LIVE, else the
// operator's SEC_USER_AGENT. The fallback is only used by stubbed runs.
const TEST_UA =
  (process.env.SEC_USER_AGENT_LIVE ?? process.env.SEC_USER_AGENT ?? '').trim() ||
  'VeriReceipt-Test/2.0 (test-only; set SEC_USER_AGENT_LIVE="Name contact@email" for live runs)';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// Real company_tickers.json entries (CIK / ticker / title as SEC publishes them).
const R8_TICKERS = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
  '2': { cik_str: 1318605, ticker: 'TSLA', title: 'Tesla, Inc.' },
  '3': { cik_str: 51143, ticker: 'IBM', title: 'INTERNATIONAL BUSINESS MACHINES CORP' },
  '4': { cik_str: 896159, ticker: 'CB', title: 'Chubb Ltd' },
  '5': { cik_str: 2074872, ticker: 'KRSP', title: 'Rice Acquisition Corp 3' },
  '6': { cik_str: 2074872, ticker: 'KRSP-WT', title: 'Rice Acquisition Corp 3' },
  '7': { cik_str: 1993097, ticker: 'MASK', title: '3 E Network Technology Group Ltd' },
  '8': { cik_str: 1349436, ticker: 'SD', title: 'SANDRIDGE ENERGY INC' },
  '9': { cik_str: 2058873, ticker: 'Q', title: 'Qnity Electronics, Inc.' },
  '10': { cik_str: 1418121, ticker: 'APLE', title: 'Apple Hospitality REIT, Inc.' },
  '11': { cik_str: 899051, ticker: 'ALL', title: 'ALLSTATE CORP' },
  '12': { cik_str: 1039399, ticker: 'FORM', title: 'FORMFACTOR INC' },
  '13': { cik_str: 2155258, ticker: 'JOSTY', title: 'JOST Werke SE/ADR' },
  '14': { cik_str: 895421, ticker: 'MS', title: 'MORGAN STANLEY' },
};

type Row = [accession: string, date: string, form: string];

/** Rows per CIK for the stub; every count asserted below is derived from these. */
const ROWS: Record<number, Row[]> = {
  320193: [
    ['0000320193-23-000106', '2023-11-03', '10-K'],
    ['0000320193-23-000077', '2023-08-04', '10-Q'],
    ['0000320193-23-000064', '2023-05-05', '10-Q'],
    ['0000320193-23-000006', '2023-02-03', '10-Q'],
    ['0000320193-23-000052', '2023-04-12', '8-K'],
    ['0000320193-23-000053', '2023-05-31', 'SD'],
    ['0000320193-23-000054', '2023-06-02', 'SC 13G/A'],
    ['0000320193-23-000055', '2023-01-12', 'DEF 14A'],
    ['0000320193-23-000056', '2023-04-10', '144'],
    ['0000320193-23-000057', '2023-04-11', '144/A'],
    ['0000320193-23-000058', '2023-07-01', 'FWP'],
  ],
  1318605: [
    ['0001318605-19-000010', '2019-02-19', '10-K'],
    ['0001318605-19-000011', '2019-03-01', 'UPLOAD'],
    ['0001318605-19-000012', '2019-04-01', 'UPLOAD'],
    ['0001318605-19-000013', '2019-05-01', 'EFFECT'],
    ['0001318605-23-000001', '2023-04-24', '10-Q'],
  ],
  896159: [
    ['0000896159-23-000001', '2023-02-24', '10-K'],
    ['0000896159-23-000002', '2023-03-01', '8-K'],
    ['0000896159-23-000003', '2023-05-01', '10-Q'],
  ],
  2074872: [
    ['0002074872-25-000001', '2025-06-01', '3'],
    ['0002074872-25-000002', '2025-06-01', '3'],
    ['0002074872-25-000003', '2025-06-02', '4'],
    ['0002074872-25-000004', '2025-06-03', '8-K'],
    ['0002074872-25-000005', '2025-06-04', 'S-1'],
  ],
  1993097: [
    ['0001993097-25-000001', '2025-02-01', '6-K'],
    ['0001993097-25-000002', '2025-03-01', '20-F'],
  ],
  899051: [['0000899051-23-000001', '2023-02-17', '10-K']],
  1039399: [['0001039399-23-000001', '2023-02-17', '10-K']],
  2155258: [['0002155258-23-000001', '2023-02-17', '6-K']],
};

function recentOf(rows: Row[]): Record<string, string[]> {
  return {
    accessionNumber: rows.map((r) => r[0]),
    filingDate: rows.map((r) => r[1]),
    form: rows.map((r) => r[2]),
    primaryDocument: rows.map((r) => `${r[0]}.htm`),
  };
}

interface StubCalls {
  fedreg: number;
  submissions: number;
  pages: number;
  urls: string[];
}

function newCalls(): StubCalls {
  return { fedreg: 0, submissions: 0, pages: 0, urls: [] };
}

/** Stub of data.sec.gov. `pages` maps a history-page file name to its raw text. */
function stub(opts: {
  calls?: StubCalls;
  rows?: Record<number, Row[]>;
  files?: Record<number, unknown[]>;
  pages?: Record<string, string>;
  hang?: 'submissions' | 'page' | 'body';
} = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    opts.calls?.urls.push(url);
    if (url.includes('federalregister.gov')) {
      if (opts.calls) opts.calls.fedreg += 1;
      return new Response('{"count":1,"results":[]}', { status: 200 });
    }
    const hang = (): Promise<Response> =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    const page = /data\.sec\.gov\/submissions\/(CIK\d{10}-submissions-\d{3}\.json)$/.exec(url);
    if (page) {
      if (opts.calls) opts.calls.pages += 1;
      if (opts.hang === 'page') return hang();
      const body = opts.pages?.[page[1]];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }
    const m = /data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/.exec(url);
    if (m) {
      if (opts.calls) opts.calls.submissions += 1;
      if (opts.hang === 'submissions') return hang();
      const cik = Number(m[1]);
      const rows = (opts.rows ?? ROWS)[cik];
      if (!rows) return new Response('', { status: 404 });
      const body = JSON.stringify({
        cik: String(cik),
        name: Object.values(R8_TICKERS).find((e) => e.cik_str === cik)?.title ?? 'x',
        filings: { recent: recentOf(rows), files: opts.files?.[cik] ?? [] },
      });
      if (opts.hang === 'body') {
        // Headers arrive, the body never does.
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response(body, { status: 200 });
    }
    throw new Error(`r8 stub: unexpected URL ${url}`);
  }) as unknown as typeof fetch;
}

async function n(query: Record<string, string>, f: typeof fetch = stub()): Promise<{ count: number; form: unknown; cik: number }> {
  const r = await handleFilings(query, { fetchImpl: f });
  const url = (r.receipt as { upstream_url: string }).upstream_url;
  return { count: r.filing_count as number, form: r.form_type, cik: Number(/CIK(\d{10})/.exec(url)?.[1]) };
}

async function refuse(query: Record<string, string>, status: number, code?: string, f?: typeof fetch): Promise<ApiError> {
  try {
    await handleFilings(query, { fetchImpl: f ?? stub() });
  } catch (err) {
    expect(err, JSON.stringify(query)).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status, JSON.stringify(query)).toBe(status);
    if (code) expect(e.code, JSON.stringify(query)).toBe(code);
    return e;
  }
  throw new Error(`expected ${status} for ${JSON.stringify(query)}, got an answer`);
}

describe('A1 r8 stubbed: findings', () => {
  beforeEach(() => {
    process.env.SEC_USER_AGENT = TEST_UA;
    __clearTickersCacheForTests();
    __seedTickersCacheForTests(R8_TICKERS as never);
  });

  it('J1-M1: a ticker or name plus an unconsumed token is 422 and never reaches the Federal Register', async () => {
    for (const [entity, period] of [
      ['AAPL X', '2023'], ['TSLA X', '2019'], ['AAPL Q', '2023'], ['AAPL 10', '2023'], ['AAPL 2023', '2023'],
      ['Microsoft X', '2023'], ['IBM X', '2023'], ['MICROSOFT CORP X', '2023'],
    ]) {
      const calls = newCalls();
      await refuse({ entity, period }, 422, undefined, stub({ calls }));
      expect(calls.fedreg, entity).toBe(0);
      expect(calls.submissions, entity).toBe(0);
    }
  });

  it('J1-M1: word forms beside a ticker filter exactly (AAPL SD 2023, TSLA UPLOAD / EFFECT 2019)', async () => {
    expect(await n({ entity: 'AAPL SD 2023', period: '2023' })).toEqual({ count: 1, form: 'SD', cik: 320193 });
    expect(await n({ entity: 'TSLA UPLOAD 2019', period: '2019' })).toEqual({ count: 2, form: 'UPLOAD', cik: 1318605 });
    expect(await n({ entity: 'TSLA EFFECT 2019', period: '2019' })).toEqual({ count: 1, form: 'EFFECT', cik: 1318605 });
  });

  it('J1-M2: the verbatim reference subjects (form + CIK inside entity) resolve; form_type stays optional and must agree', async () => {
    expect(await n({ entity: 'Form 10-K filings by Apple Inc. (CIK 320193)', period: 'calendar 2023' })).toEqual({ count: 1, form: '10-K', cik: 320193 });
    expect(await n({ entity: 'Form 10-Q filings by Tesla, Inc. (CIK 1318605)', period: 'calendar 2023' })).toEqual({ count: 1, form: '10-Q', cik: 1318605 });
    expect(await n({ entity: 'Form 10-K filings by Apple Inc. (CIK 320193) in calendar 2023', period: 'calendar 2023' })).toMatchObject({ count: 1 });
    expect(await n({ entity: 'Form 10-K filings by Apple Inc. (CIK 320193)', period: 'calendar 2023', form_type: '10-K' })).toMatchObject({ count: 1 });
    await refuse({ entity: 'Form 10-K filings by Apple Inc. (CIK 320193)', period: 'calendar 2023', form_type: '10-Q' }, 422, 'CONFLICTING_FORM_TYPE');
  });

  it('J1-m1 / J2-M4: a well-formed form EDGAR has never recorded is 422 UNKNOWN_FORM, never a verified 0', async () => {
    for (const form of ['8-Z', '10-Z', '99-K', 'S-99', 'S-1ZZZZ', 'N-99Q', '12-K', '13D', '13G', '13D/A', 'K-10']) {
      const calls = newCalls();
      await refuse({ entity: `Apple Inc. ${form}`, period: '2023' }, 422, 'UNKNOWN_FORM', stub({ calls }));
      await refuse({ entity: 'Apple Inc.', period: '2023', form_type: form }, 422, 'UNKNOWN_FORM', stub({ calls }));
      expect(calls.submissions + calls.fedreg, form).toBe(0);
    }
  });

  it('J1-m2: an unknown query key is 400 UNKNOWN_PARAM; a form-like key is 422 UNSUPPORTED_FORM_PARAM', async () => {
    await refuse({ entity: 'Apple Inc.', period: '2023', note: 'hello' }, 400, 'UNKNOWN_PARAM');
    await refuse({ entity: 'Apple Inc.', period: '2023', foo: '10-K' }, 400, 'UNKNOWN_PARAM');
    await refuse({ entity: 'Apple Inc.', period: '2023', doc: '10-K' }, 422, 'UNSUPPORTED_FORM_PARAM');
    expect(await n({ entity: 'Apple Inc.', period: '2023', cik: '320193' })).toMatchObject({ cik: 320193 });
  });

  it('J1-m3: form_type is present in every answer (null when no form was asked)', async () => {
    const r = await handleFilings({ entity: 'AAPL', period: '2023' }, { fetchImpl: stub() });
    expect(Object.prototype.hasOwnProperty.call(r, 'form_type')).toBe(true);
    expect(r.form_type).toBeNull();
    const r2 = await handleFilings({ entity: 'AAPL', period: '2023', form_type: '10-Q' }, { fetchImpl: stub() });
    expect(r2.form_type).toBe('10-Q');
  });

  it('J1-m5: "annual report" = 10-K, "quarterly report" = 10-Q; "Apple Inc. 144 2023" = Form 144; a 20-F filer is ambiguous', async () => {
    expect(await n({ entity: 'Apple Inc. annual report', period: '2023' })).toEqual({ count: 1, form: '10-K', cik: 320193 });
    expect(await n({ entity: 'Apple Inc. quarterly report', period: '2023' })).toEqual({ count: 3, form: '10-Q', cik: 320193 });
    expect(await n({ entity: 'Apple Inc. annual reports', period: '2023' })).toMatchObject({ count: 1, form: '10-K' });
    expect(await n({ entity: 'Apple Inc. 144 2023', period: '2023' })).toEqual({ count: 1, form: '144', cik: 320193 });
    // 3 E Network files 20-F, never 10-K: "annual report" is not unambiguously 10-K.
    await refuse({ entity: '3 E Network Technology Group Ltd annual report', period: '2025' }, 422, 'FORM_PHRASE_AMBIGUOUS');
  });

  it('J2-M1: separators glued to the form fold to the form; FedReg never fetched', async () => {
    for (const sep of ['\u2014', '\u2013', ':', '/', '\\', '|', ',', '_', '.', '; ', ' : ']) {
      const calls = newCalls();
      expect(await n({ entity: `Apple Inc.${sep}10-K`, period: '2023' }, stub({ calls })), JSON.stringify(sep)).toEqual({ count: 1, form: '10-K', cik: 320193 });
      expect(calls.fedreg).toBe(0);
    }
  });

  it('J2-M1: spaced and joined forms fold (10 K, 8 K, 20 F, 10 - Q, 10.Q, DEF14A, 144A, SC13G/A)', async () => {
    expect(await n({ entity: 'Apple Inc. 10 K', period: '2023' })).toMatchObject({ count: 1, form: '10-K' });
    expect(await n({ entity: 'Apple Inc. 8 K', period: '2023' })).toMatchObject({ count: 1, form: '8-K' });
    expect(await n({ entity: 'Apple Inc. 20 F', period: '2023' })).toMatchObject({ count: 0, form: '20-F' });
    expect(await n({ entity: 'Apple Inc. 10 - Q', period: '2023' })).toMatchObject({ count: 3, form: '10-Q' });
    expect(await n({ entity: 'Apple Inc. 10.Q', period: '2023' })).toMatchObject({ count: 3, form: '10-Q' });
    expect(await n({ entity: 'Apple Inc. DEF14A', period: '2023' })).toMatchObject({ count: 1, form: 'DEF 14A' });
    expect(await n({ entity: 'Apple Inc. 144A', period: '2023' })).toMatchObject({ count: 1, form: '144/A' });
    expect(await n({ entity: 'Apple Inc. SC13G/A', period: '2023' })).toMatchObject({ count: 1, form: 'SC 13G/A' });
    expect(await n({ entity: 'Apple Inc.', period: '2023', form_type: 'DEF14A' })).toMatchObject({ count: 1, form: 'DEF 14A' });
    expect(await n({ entity: 'Apple Inc.', period: '2023', form_type: 'SC13G/A' })).toMatchObject({ count: 1, form: 'SC 13G/A' });
  });

  it('J2-M1: homoglyphs — Cyrillic letters fold; digit/letter spoofs (1O, l0, F0rm) refuse', async () => {
    expect(await n({ entity: 'Apple Inc. F\u043erm 10-K', period: '2023' })).toMatchObject({ count: 1, form: '10-K' });
    expect(await n({ entity: 'Apple Inc. 10-\u041a', period: '2023' })).toMatchObject({ count: 1, form: '10-K' });
    for (const entity of ['Apple Inc. F0rm 10-K', 'Apple Inc. 1O-Q', 'Apple Inc. l0-Q']) {
      const calls = newCalls();
      await refuse({ entity, period: '2023' }, 422, undefined, stub({ calls }));
      expect(calls.fedreg + calls.submissions, entity).toBe(0);
    }
    for (const form of ['1O-Q', 'l0-Q', '1O-K']) {
      await refuse({ entity: 'Apple Inc.', period: '2023', form_type: form }, 422, 'CONFUSABLE_FORM_TYPE');
    }
  });

  it('J2-M1: a CIK padded past 10 digits is 422 INVALID_CIK', async () => {
    for (const entity of ['00000320193', '0000000320193', '00000000000320193', 'CIK 00000000320193', 'Apple Inc. 000000000320193']) {
      const calls = newCalls();
      await refuse({ entity, period: '2023' }, 422, 'INVALID_CIK', stub({ calls }));
      expect(calls.submissions + calls.fedreg).toBe(0);
    }
    expect(await n({ entity: '0000320193', period: '2023' })).toMatchObject({ cik: 320193 });
  });

  it('J2-M2: a digit inside a real SEC title is part of the name, never a form', async () => {
    expect(await n({ entity: 'Rice Acquisition Corp 3 filings', period: '2025' })).toEqual({ count: 5, form: null, cik: 2074872 });
    expect(await n({ entity: 'Rice Acquisition Corp 3', period: '2025' })).toEqual({ count: 5, form: null, cik: 2074872 });
    expect(await n({ entity: 'Rice Acquisition Corp 3 Form 3', period: '2025' })).toEqual({ count: 2, form: '3', cik: 2074872 });
    expect(await n({ entity: '3 E Network Technology Group Ltd filings', period: '2025' })).toEqual({ count: 2, form: null, cik: 1993097 });
    expect(await n({ entity: 'Form 3 filings by Rice Acquisition Corp 3', period: '2025' })).toEqual({ count: 2, form: '3', cik: 2074872 });
  });

  it('J2-M3: the Chubb ticker CB is the filer, not Form CB, unless "Form" says so', async () => {
    expect(await n({ entity: 'Chubb CB', period: '2023' })).toEqual({ count: 3, form: null, cik: 896159 });
    expect(await n({ entity: 'CB', period: '2023' })).toEqual({ count: 3, form: null, cik: 896159 });
    expect(await n({ entity: 'CB filings', period: '2023' })).toEqual({ count: 3, form: null, cik: 896159 });
    expect(await n({ entity: 'Chubb Ltd Form CB', period: '2023' })).toEqual({ count: 0, form: 'CB', cik: 896159 });
    expect(await n({ entity: 'Form CB (CIK 896159)', period: '2023' })).toEqual({ count: 0, form: 'CB', cik: 896159 });
  });

  it('ticker scan: capital-typed tickers that are also filler/form words resolve (ALL, FORM); lowercase stays refused', async () => {
    expect(await n({ entity: 'ALL filings', period: '2023' })).toMatchObject({ cik: 899051 });
    expect(await n({ entity: 'FORM', period: '2023' })).toMatchObject({ cik: 1039399 });
    await refuse({ entity: 'all filings', period: '2023' }, 400, 'MISSING_ENTITY');
    await refuse({ entity: 'FILINGS', period: '2023' }, 400, 'MISSING_ENTITY');
  });

  it('title scan: a real SEC title with a form-looking slash ("JOST Werke SE/ADR") resolves', async () => {
    expect(await n({ entity: 'JOST Werke SE/ADR', period: '2023' })).toMatchObject({ cik: 2155258, form: null });
    await refuse({ entity: 'Apple Inc. 10-K/A-1', period: '2023' }, 422, 'INVALID_FORM_TYPE');
  });

  it('J2-M5 / decision 1: former names and non-titles are 422 ENTITY_NOT_FOUND; FedReg is never fetched', async () => {
    for (const entity of ['Tesla Motors', 'Google', 'Facebook', '7-Eleven', 'Tesla quarterly', 'Environmental Protection Agency', 'Airbus S E', 'Apple Inc. Form']) {
      const calls = newCalls();
      await refuse({ entity, period: '2023' }, 422, undefined, stub({ calls }));
      expect(calls.fedreg, entity).toBe(0);
      expect(calls.submissions, entity).toBe(0);
    }
  });

  it('periods: fullwidth digits, "Y to Y", "date to date", "last 3 months filings"', async () => {
    expect(parsePeriod('\uFF12\uFF10\uFF12\uFF13')).toMatchObject({ start: '2023-01-01', end: '2023-12-31' });
    expect(parsePeriod('2023 to 2023')).toMatchObject({ start: '2023-01-01', end: '2023-12-31' });
    expect(parsePeriod('2023-11-03 to 2023-11-03')).toMatchObject({ start: '2023-11-03', end: '2023-11-03' });
    expect(await n({ entity: 'Apple Inc.', period: '\uFF12\uFF10\uFF12\uFF13' })).toMatchObject({ count: 11 });
    expect(await n({ entity: 'Apple Inc.', period: '2023-11-03 to 2023-11-03' })).toMatchObject({ count: 1 });
    const r = await handleFilings({ entity: 'Apple Inc.', period: 'last 3 months filings' }, { fetchImpl: stub() });
    expect(r.form_type).toBeNull();
  });

  it('minor: a hanging SEC fetch fails closed 504 SEC_TIMEOUT (headers, body, and history page)', async () => {
    __clearTickersCacheForTests();
    __seedTickersCacheForTests(R8_TICKERS as never);
    for (const hang of ['submissions', 'body'] as const) {
      const t0 = Date.now();
      await expect(
        handleFilings({ entity: 'AAPL', period: '2023' }, { fetchImpl: stub({ hang }), timeoutMs: 100, deadlineMs: 1000 }),
      ).rejects.toMatchObject({ status: 504, code: 'SEC_TIMEOUT' });
      expect(Date.now() - t0).toBeLessThan(3000);
    }
    const files = { 320193: [{ name: 'CIK0000320193-submissions-001.json', filingCount: 1, filingFrom: '2010-01-01', filingTo: '2010-12-31' }] };
    await expect(
      handleFilings({ entity: 'AAPL', period: '2010' }, { fetchImpl: stub({ hang: 'page', files }), timeoutMs: 100, deadlineMs: 1000 }),
    ).rejects.toMatchObject({ status: 504, code: 'SEC_TIMEOUT' });
  });

  it('minor: an empty, short or out-of-range history page fails closed 502 (never a verified undercount)', async () => {
    const name = 'CIK0000320193-submissions-001.json';
    const files = { 320193: [{ name, filingCount: 2, filingFrom: '2010-01-01', filingTo: '2010-12-31' }] };
    const good = JSON.stringify(recentOf([['0000320193-10-000001', '2010-01-25', '10-Q'], ['0000320193-10-000097', '2010-10-27', '10-K']]));
    expect(await n({ entity: 'AAPL', period: '2010' }, stub({ files, pages: { [name]: good } }))).toMatchObject({ count: 2 });
    for (const [label, body] of [
      ['empty', JSON.stringify(recentOf([]))],
      ['short', JSON.stringify(recentOf([['0000320193-10-000001', '2010-01-25', '10-Q']]))],
      ['out of range', JSON.stringify(recentOf([['0000320193-10-000001', '2010-01-25', '10-Q'], ['0000320193-09-000097', '2009-10-27', '10-K']]))],
      ['past the slack', JSON.stringify(recentOf([['0000320193-10-000001', '2010-01-25', '10-Q'], ['0000320193-11-000097', '2011-01-08', '10-K']]))],
      ['malformed', '{"accessionNumber":'],
      ['blank body', ''],
    ]) {
      await expect(
        handleFilings({ entity: 'AAPL', period: '2010' }, { fetchImpl: stub({ files, pages: { [name]: body } }) }),
        label,
      ).rejects.toMatchObject({ status: 502 });
    }
  });

  it('history pages: EDGAR\'s real 1-day filingTo drift is tolerated, and a boundary filing is counted', async () => {
    // Live EDGAR: filingTo is routinely one day before the page's last
    // filingDate (IBM -003: filingTo 2006-11-29, last row 2006-11-30).
    const name = 'CIK0000320193-submissions-001.json';
    const files = { 320193: [{ name, filingCount: 2, filingFrom: '2010-01-01', filingTo: '2010-12-30' }] };
    const body = JSON.stringify(recentOf([['0000320193-10-000001', '2010-01-25', '10-Q'], ['0000320193-10-000097', '2010-12-31', '10-K']]));
    expect(await n({ entity: 'AAPL', period: '2010' }, stub({ files, pages: { [name]: body } }))).toMatchObject({ count: 2 });
    // A period that starts after filingTo but within the drift still fetches the page.
    expect(await n({ entity: 'AAPL', period: '2010-12-31..2010-12-31' }, stub({ files, pages: { [name]: body } }))).toMatchObject({ count: 1 });
  });

  it('minor: the filings list is capped at 1000 while filing_count stays the full count', async () => {
    const rows: Row[] = Array.from({ length: 1500 }, (_v, i) => [
      `0000895421-23-${String(i).padStart(6, '0')}`,
      `2023-${String(1 + (i % 12)).padStart(2, '0')}-15`,
      '424B2',
    ]);
    const r = await handleFilings({ entity: 'MS', period: '2023' }, { fetchImpl: stub({ rows: { 895421: rows } }) });
    expect(r.filing_count).toBe(1500);
    expect((r.filings as unknown[]).length).toBe(1000);
    expect((r.urls as unknown[]).length).toBe(1000);
    expect(r.filings_listed).toBe(1000);
    expect(r.filings_truncated).toBe(true);
    const small = await handleFilings({ entity: 'AAPL', period: '2023' }, { fetchImpl: stub() });
    expect(small.filings_truncated).toBeUndefined();
  });

  it('receipts: main evidence AND every history page are stored with matching sha256 (G10 saveReceipt contract)', async () => {
    const name = 'CIK0000320193-submissions-001.json';
    const files = { 320193: [{ name, filingCount: 2, filingFrom: '2010-01-01', filingTo: '2010-12-31' }] };
    const pageBody = JSON.stringify(recentOf([['0000320193-10-000001', '2010-01-25', '10-Q'], ['0000320193-10-000097', '2010-10-27', '10-K']]));
    const r = await handleFilings({ entity: 'AAPL', period: '2010' }, { fetchImpl: stub({ files, pages: { [name]: pageBody } }) });
    const receipt = r.receipt as { receipt_id: string; raw_response_sha256: string };
    const main = getReceiptEvidence(receipt.receipt_id);
    expect(main.found).toBe(true);
    expect(main.evidence).not.toBeNull();
    expect(sha(main.evidence as Buffer)).toBe(receipt.raw_response_sha256);
    const pages = getReceiptPages(receipt.receipt_id);
    const upstreamPages = r.upstream_pages as Array<{ url: string; raw_response_sha256: string }>;
    expect(pages.length).toBe(1);
    expect(pages[0].url).toBe(upstreamPages[0].url);
    expect(pages[0].raw_response_sha256).toBe(sha(pageBody));
    const pe = getReceiptPageEvidence(receipt.receipt_id, 0);
    expect((pe.evidence as Buffer).toString('utf8')).toBe(pageBody);
    expect(r.upstream_bundle_sha256).toBe(
      sha([`${(r.receipt as { upstream_url: string }).upstream_url} ${receipt.raw_response_sha256}`, `${upstreamPages[0].url} ${sha(pageBody)}`].join('\n')),
    );
  });

  it('decision 2: the closed vocabulary is the committed EDGAR full-index union (r9: UNION live submissions forms), with its source and date', () => {
    expect(EDGAR_FORM_TYPES_SOURCE.retrieved).toBe('2026-11-21');
    expect(EDGAR_FORM_TYPES_SOURCE.entries).toBe(EDGAR_FORM_TYPES.length);
    expect(EDGAR_FORM_TYPES.length).toBe(739);
    for (const f of ['10-K', '10-K/A', '10-Q', '8-K', 'SD', 'UPLOAD', 'EFFECT', 'CB', '3', '144/A', 'SC 13G/A', 'DEF 14A', 'SEC STAFF LETTER', 'FWP']) {
      expect(EDGAR_FORM_TYPES, f).toContain(f);
      expect(canonicalFormOrThrow(f)).toBe(f);
    }
    for (const f of ['8-Z', '10-Z', '13D', 'SEC STAFF LETTE']) expect(EDGAR_FORM_TYPES, f).not.toContain(f);
  });
});

// ---------------------------------------------------------------------------
// LIVE — real SEC EDGAR, no stubs.
// ---------------------------------------------------------------------------

describe('A1 r8 LIVE (real SEC EDGAR)', () => {
  beforeAll(() => {
    process.env.SEC_USER_AGENT = process.env.SEC_USER_AGENT_LIVE || TEST_UA;
    __clearTickersCacheForTests();
  });
  afterAll(() => {
    __clearTickersCacheForTests();
  });

  const live = async (q: Record<string, string>) => {
    const r = await handleFilings(q);
    expect(r.source).toBe('SEC EDGAR Submissions API');
    expect(r.verdict).toBe('verified');
    return r;
  };

  it('J1 truth: AAPL SD 2023 = 1, TSLA UPLOAD 2019 = 5, TSLA EFFECT 2019 = 1, Apple 2023 FWP = 1 / 8-K = 6', async () => {
    expect((await live({ entity: 'AAPL SD 2023', period: '2023' })).filing_count).toBe(1);
    expect((await live({ entity: 'TSLA UPLOAD 2019', period: '2019' })).filing_count).toBe(5);
    expect((await live({ entity: 'TSLA EFFECT 2019', period: '2019' })).filing_count).toBe(1);
    expect((await live({ entity: 'Apple Inc. FWP', period: '2023' })).filing_count).toBe(1);
    expect((await live({ entity: 'Apple Inc. 8-K', period: '2023' })).filing_count).toBe(6);
  }, 120_000);

  it('J1-M2: the reference subjects verbatim -> 1 (Apple 10-K 2023) and 3 (Tesla 10-Q 2023)', async () => {
    expect((await live({ entity: 'Form 10-K filings by Apple Inc. (CIK 320193) in calendar 2023', period: 'calendar 2023' })).filing_count).toBe(1);
    expect((await live({ entity: 'Form 10-Q filings by Tesla, Inc. (CIK 1318605) in calendar 2023', period: 'calendar 2023' })).filing_count).toBe(3);
    expect((await live({ entity: 'Apple Inc. annual report', period: '2023' })).filing_count).toBe(1);
    expect((await live({ entity: 'Tesla, Inc. quarterly report', period: '2023' })).filing_count).toBe(3);
  }, 120_000);

  it('J2 truth: KRSP 2025 = 28 (Form 3 = 8), MASK 2025 = 35, Chubb CB 2023 = 105', async () => {
    expect((await live({ entity: 'Rice Acquisition Corp 3 filings', period: '2025' })).filing_count).toBe(28);
    expect((await live({ entity: 'Rice Acquisition Corp 3 Form 3', period: '2025' })).filing_count).toBe(8);
    expect((await live({ entity: '3 E Network Technology Group Ltd filings', period: '2025' })).filing_count).toBe(35);
    expect((await live({ entity: 'Chubb CB', period: '2023' })).filing_count).toBe(105);
    expect((await live({ entity: 'CB', period: '2023' })).filing_count).toBe(105);
  }, 120_000);

  it('J2 truth through history pages: AAPL 1996 = 17, AAPL 2010 = 89, AAPL 2014 Form 4 = 72, IBM 2005 = 634', async () => {
    const r2010 = await live({ entity: 'AAPL', period: '2010' });
    expect(r2010.filing_count).toBe(89);
    expect((r2010.upstream_pages as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((await live({ entity: 'AAPL', period: '1996' })).filing_count).toBe(17);
    expect((await live({ entity: 'AAPL Form 4', period: '2014' })).filing_count).toBe(72);
    expect((await live({ entity: 'IBM', period: '2005' })).filing_count).toBe(634);
  }, 180_000);

  it('size cap live: MS last 60 months lists 1000 filings with the full count (J2 measured 67,304)', async () => {
    const r = await live({ entity: 'MS', period: 'last 60 months' });
    expect(r.filings_truncated).toBe(true);
    expect((r.filings as unknown[]).length).toBe(1000);
    expect(r.filing_count as number).toBeGreaterThan(60_000);
    console.log(`LIVE MS last 60 months: filing_count=${r.filing_count}`);
  }, 300_000);

  it('former names / non-SEC entities are 422 live (Tesla Motors, Google, Facebook, 7-Eleven, Apple Inc.—10-K is 1)', async () => {
    for (const entity of ['Tesla Motors', 'Google', 'Facebook', '7-Eleven', 'Tesla quarterly']) {
      await expect(handleFilings({ entity, period: '2023' }), entity).rejects.toMatchObject({ status: 422 });
    }
    expect((await live({ entity: 'Apple Inc.\u201410-K', period: '2023' })).filing_count).toBe(1);
  }, 120_000);

  it('decision 4: the full SEC title + ticker scan (live company_tickers.json, submissions stubbed) has zero misreads', async () => {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': process.env.SEC_USER_AGENT as string } });
    expect(res.ok).toBe(true);
    const tickers = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
    const r = await scanAllTitles(tickers);
    console.log(`LIVE title scan: entries=${Object.keys(tickers).length} titles=${r.titles} queries=${r.queries} ambiguous=${r.ambiguousTitles} failures=${r.failures.length}`);
    expect(r.failures).toEqual([]);
    expect(r.fedregCalls).toBe(0);
    expect(r.titles).toBeGreaterThan(5000);
  }, 900_000);
});
