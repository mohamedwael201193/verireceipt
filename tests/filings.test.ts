// Tests for the REGULATORY_FILING_MONITOR_GENERAL handler.
// Unit tests use local fixtures + a stub fetch transport injected via the
// handler's deps argument (no mocks inside handler logic). Live tests hit the
// real SEC EDGAR API with no stubbing.

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { ApiError } from '../src/core/errors';
import {
  handleFilings,
  parsePeriod,
  resolveCikFromTickers,
  isTooGenericEntity,
  buildFilingsFromSubmissions,
  filterFilingsByPeriod,
  __clearTickersCacheForTests,
  __seedTickersCacheForTests,
} from '../src/handlers/filings';

const TEST_UA = 'VeriReceipt-Test/2.0 (test-only)';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TICKERS_FIXTURE = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
  '2': { cik_str: 1318605, ticker: 'TSLA', title: 'Tesla, Inc.' },
  '3': { cik_str: 3201930, ticker: 'APLE', title: 'Apple Hospitality REIT, Inc.' },
};

const SUBMISSIONS_FIXTURE = {
  cik: '320193',
  name: 'Apple Inc.',
  filings: {
    recent: {
      accessionNumber: [
        '0000320193-26-000001',
        '0000320193-25-000108',
        '0000320193-25-000062',
        '0000320193-24-000123',
      ],
      filingDate: ['2026-01-05', '2025-11-03', '2025-08-01', '2024-11-01'],
      form: ['8-K', '10-K', '10-Q', '10-K'],
      primaryDocument: ['aapl-20260105.htm', 'aapl-20250927.htm', 'aapl-20250628.htm', 'aapl-20240928.htm'],
    },
  },
};

const FEDREG_FIXTURE = {
  count: 2,
  results: [
    {
      document_number: '2026-01234',
      publication_date: '2026-02-10',
      html_url: 'https://www.federalregister.gov/documents/2026/02/10/2026-01234/example-rule',
      title: 'Example Rule',
    },
    {
      document_number: '2025-09999',
      publication_date: '2025-06-15',
      html_url: 'https://www.federalregister.gov/documents/2025/06/15/2025-09999/older-rule',
      title: 'Older Rule',
    },
  ],
};

function sha256Hex(s: string): string {
  return '0x' + createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Stub fetch that serves the fixtures by URL host. */
function stubFetchFactory(opts: {
  submissions?: unknown;
  submissionsStatus?: number;
  submissionsRaw?: string;
  submissionsThrow?: boolean;
  fedreg?: unknown;
  fedregStatus?: number;
  fedregRaw?: string;
  tickersStatus?: number;
  calls?: { fedreg: number; submissions: number; tickers: number };
}): typeof fetch {
  const submissionsBody =
    opts.submissionsRaw !== undefined
      ? opts.submissionsRaw
      : opts.submissions !== undefined
        ? JSON.stringify(opts.submissions)
        : '';
  const fedregBody =
    opts.fedregRaw !== undefined
      ? opts.fedregRaw
      : opts.fedreg !== undefined
        ? JSON.stringify(opts.fedreg)
        : '';
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('data.sec.gov/submissions/')) {
      if (opts.calls) opts.calls.submissions += 1;
      if (opts.submissionsThrow) throw new Error('stub network failure');
      return new Response(submissionsBody, { status: opts.submissionsStatus ?? 200 });
    }
    if (url.includes('federalregister.gov')) {
      if (opts.calls) opts.calls.fedreg += 1;
      return new Response(fedregBody, { status: opts.fedregStatus ?? 200 });
    }
    if (url.includes('sec.gov/files/company_tickers.json')) {
      if (opts.calls) opts.calls.tickers += 1;
      return new Response(JSON.stringify(TICKERS_FIXTURE), {
        status: opts.tickersStatus ?? 200,
      });
    }
    throw new Error(`stub fetch: unexpected URL ${url}`);
  }) as unknown as typeof fetch;
}

async function expectApiError(
  p: Promise<unknown>,
  status: number,
  code?: string,
): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(status);
    if (code !== undefined) expect(apiErr.code).toBe(code);
    return apiErr;
  }
  throw new Error(`expected ApiError ${status}${code ? `/${code}` : ''}, promise resolved`);
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('handleFilings — validation (400s)', () => {
  beforeAll(() => {
    process.env.SEC_USER_AGENT = TEST_UA;
  });

  it('missing entity -> 400', async () => {
    await expectApiError(handleFilings({ period: 'last 12 months' }), 400, 'MISSING_ENTITY');
  });

  it('empty entity -> 400', async () => {
    await expectApiError(handleFilings({ entity: '   ', period: '2026' }), 400, 'MISSING_ENTITY');
  });

  it('missing period -> 400', async () => {
    await expectApiError(handleFilings({ entity: 'AAPL' }), 400, 'MISSING_PERIOD');
  });

  it('empty period -> 400', async () => {
    await expectApiError(handleFilings({ entity: 'AAPL', period: '' }), 400, 'MISSING_PERIOD');
  });

  it('unparseable period -> 400', async () => {
    for (const bad of [
      'sometime',
      'last year',
      '2026-13-01..2026-13-02',
      '2026-02-30..2026-03-01',
      '2026-05-01..2026-01-01',
      'last 0 months',
      'Q1 2026',
      '12 months',
    ]) {
      await expectApiError(
        handleFilings({ entity: 'AAPL', period: bad }),
        400,
        'INVALID_PERIOD',
      );
    }
  });
});

describe('parsePeriod', () => {
  it('parses "YYYY" to the full calendar year', () => {
    expect(parsePeriod('2026')).toEqual({ start: '2026-01-01', end: '2026-12-31', label: '2026' });
  });

  it('parses an explicit range', () => {
    expect(parsePeriod('2025-03-01..2025-03-31')).toEqual({
      start: '2025-03-01',
      end: '2025-03-31',
      label: '2025-03-01..2025-03-31',
    });
  });

  it('parses "last N months" ending today', () => {
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const p = parsePeriod('last 12 months');
    expect(p.end).toBe(`${yyyy}-${mm}-${dd}`);
    expect(p.start < p.end).toBe(true);
    expect(p.label).toBe('last 12 months');
  });

  it('throws 400 for unparseable input', () => {
    expect(() => parsePeriod('whenever')).toThrow(ApiError);
    try {
      parsePeriod('whenever');
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
    }
  });

  it('year outside 1993..current year -> 400 INVALID_PERIOD; 2024 still works', () => {
    for (const bad of ['0000', '9999', '1992']) {
      try {
        parsePeriod(bad);
        throw new Error(`expected parsePeriod(${bad}) to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).code).toBe('INVALID_PERIOD');
      }
    }
    expect(parsePeriod('2024')).toEqual({
      start: '2024-01-01',
      end: '2024-12-31',
      label: '2024',
    });
    expect(parsePeriod('1993')).toEqual({
      start: '1993-01-01',
      end: '1993-12-31',
      label: '1993',
    });
  });

  it('month overflow is clamped: Mar 31 minus 1 month starts Feb 28', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-31T12:00:00Z'));
      const p = parsePeriod('last 1 months');
      expect(p.start).toBe('2026-02-28');
      expect(p.end).toBe('2026-03-31');

      vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));
      const q = parsePeriod('last 1 months');
      expect(q.start).toBe('2025-12-31');
      expect(q.end).toBe('2026-01-31');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveCikFromTickers', () => {
  it('ticker -> CIK, case-insensitive exact', () => {
    expect(resolveCikFromTickers('AAPL', TICKERS_FIXTURE)).toEqual({
      cik: 320193,
      cik10: '0000320193',
      matchKind: 'ticker',
    });
    expect(resolveCikFromTickers('aapl', TICKERS_FIXTURE)?.cik).toBe(320193);
    expect(resolveCikFromTickers('msft', TICKERS_FIXTURE)?.cik).toBe(789019);
  });

  it('bare CIK digits resolve directly', () => {
    expect(resolveCikFromTickers('320193', TICKERS_FIXTURE)).toEqual({
      cik: 320193,
      cik10: '0000320193',
      matchKind: 'cik',
    });
  });

  it('company-name substring resolves, shortest title wins', () => {
    // "apple" matches both Apple Inc. and Apple Hospitality REIT, Inc.;
    // the shortest title (Apple Inc.) must win.
    const m = resolveCikFromTickers('apple', TICKERS_FIXTURE);
    expect(m?.cik).toBe(320193);
    expect(m?.matchKind).toBe('name');
    expect(resolveCikFromTickers('Tesla', TICKERS_FIXTURE)?.cik).toBe(1318605);
  });

  it('no match -> null', () => {
    expect(resolveCikFromTickers('ZZZZNOTREAL', TICKERS_FIXTURE)).toBeNull();
  });

  it('degenerate substrings never resolve by name; word-boundary prefixes still do', () => {
    // Live company_tickers.json proof: "a" -> Apple Inc., "the" -> The9 Ltd,
    // "co" -> 3M, "inc" -> HP Inc. — all unsafe, all must be null here.
    expect(resolveCikFromTickers('a', TICKERS_FIXTURE)).toBeNull();
    expect(resolveCikFromTickers('the', TICKERS_FIXTURE)).toBeNull();
    expect(resolveCikFromTickers('co', TICKERS_FIXTURE)).toBeNull();
    expect(resolveCikFromTickers('inc', TICKERS_FIXTURE)).toBeNull();
    expect(resolveCikFromTickers('pple', TICKERS_FIXTURE)).toBeNull();
    expect(isTooGenericEntity('a')).toBe(true);
    expect(isTooGenericEntity('the')).toBe(true);
    expect(isTooGenericEntity('inc')).toBe(true);
    expect(isTooGenericEntity('Apple')).toBe(false);
    // Legitimate names still resolve, including a word-boundary prefix.
    expect(resolveCikFromTickers('Apple', TICKERS_FIXTURE)?.cik).toBe(320193);
    expect(resolveCikFromTickers('Microsoft', TICKERS_FIXTURE)?.cik).toBe(789019);
    expect(resolveCikFromTickers('Micro', TICKERS_FIXTURE)?.cik).toBe(789019);
  });
});

describe('buildFilingsFromSubmissions + period filtering', () => {
  it('builds SEC Archives URLs from the submissions fixture', () => {
    const filings = buildFilingsFromSubmissions(SUBMISSIONS_FIXTURE);
    expect(filings).toHaveLength(4);
    expect(filings[0]).toEqual({
      form: '8-K',
      accession: '0000320193-26-000001',
      filing_date: '2026-01-05',
      url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260105.htm',
    });
  });

  it('period filtering keeps only filings inside the period', () => {
    const filings = buildFilingsFromSubmissions(SUBMISSIONS_FIXTURE);
    const in2026 = filterFilingsByPeriod(filings, parsePeriod('2026'));
    expect(in2026.map((f) => f.accession)).toEqual(['0000320193-26-000001']);

    const range = filterFilingsByPeriod(
      filings,
      parsePeriod('2025-07-01..2025-12-31'),
    );
    expect(range.map((f) => f.accession)).toEqual([
      '0000320193-25-000108',
      '0000320193-25-000062',
    ]);

    const last12 = filterFilingsByPeriod(filings, parsePeriod('last 12 months'));
    // Fixture dates: 2026-01-05, 2025-11-03, 2025-08-01, 2024-11-01.
    // "last 12 months" from 2026-11-20 starts 2025-11-20, so only 2026-01-05 survives.
    expect(last12.map((f) => f.accession)).toEqual(['0000320193-26-000001']);
  });
});

describe('handleFilings — envelope shape (stubbed upstream)', () => {
  beforeEach(() => {
    process.env.SEC_USER_AGENT = TEST_UA;
    __clearTickersCacheForTests();
    __seedTickersCacheForTests(TICKERS_FIXTURE);
  });
  afterEach(() => {
    __clearTickersCacheForTests();
  });

  it('returns root fields + receipt with 0x sha256 of the raw body', async () => {
    const fetchImpl = stubFetchFactory({ submissions: SUBMISSIONS_FIXTURE });
    const result = await handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl });

    expect(result.entity).toBe('AAPL');
    expect(result.filing_count).toBe(1);
    expect(result.filings).toEqual([
      {
        form: '8-K',
        accession: '0000320193-26-000001',
        filing_date: '2026-01-05',
        url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260105.htm',
      },
    ]);
    expect(result.urls).toEqual([
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260105.htm',
    ]);
    expect(result.verdict).toBe('verified');
    expect(result.confidence).toBe(1.0);
    expect(result.source).toBe('SEC EDGAR Submissions API');
    expect(typeof result.answer).toBe('string');
    expect(result.answer as string).toContain('AAPL');
    expect(result.answer as string).toContain('1');

    const receipt = result.receipt as Record<string, unknown>;
    expect(receipt).toBeDefined();
    expect(receipt.intent).toBe('REGULATORY_FILING_MONITOR_GENERAL');
    expect(receipt.upstream_url).toBe('https://data.sec.gov/submissions/CIK0000320193.json');
    expect(receipt.quorum_votes).toBe('1/1 primary source');
    expect(receipt.raw_response_sha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.raw_response_sha256).toBe(sha256Hex(JSON.stringify(SUBMISSIONS_FIXTURE)));
  });

  it('name-substring match gives confidence 0.9', async () => {
    const fetchImpl = stubFetchFactory({ submissions: SUBMISSIONS_FIXTURE });
    const result = await handleFilings({ entity: 'apple', period: '2026' }, { fetchImpl });
    expect(result.confidence).toBe(0.9);
    expect(result.entity).toBe('apple');
    expect(result.filing_count).toBe(1);
  });

  it('unknown entity (no CIK, no FedReg hits) -> 422 ENTITY_NOT_FOUND', async () => {
    const fetchImpl = stubFetchFactory({ fedreg: { count: 0, results: [] } });
    await expectApiError(
      handleFilings({ entity: 'ZZZZNOTREAL', period: 'last 12 months' }, { fetchImpl }),
      422,
      'ENTITY_NOT_FOUND',
    );
  });

  it('FedReg failover: agency-like entity returns Federal Register filings', async () => {
    const fetchImpl = stubFetchFactory({ fedreg: FEDREG_FIXTURE });
    const result = await handleFilings(
      { entity: 'Environmental Protection Agency', period: '2026' },
      { fetchImpl },
    );
    expect(result.source).toBe('Federal Register API');
    expect(result.confidence).toBe(0.9);
    expect(result.filing_count).toBe(1);
    expect(result.filings).toEqual([
      {
        form: 'Federal Register',
        accession: '2026-01234',
        filing_date: '2026-02-10',
        url: 'https://www.federalregister.gov/documents/2026/02/10/2026-01234/example-rule',
      },
    ]);
    expect(result.urls).toEqual([
      'https://www.federalregister.gov/documents/2026/02/10/2026-01234/example-rule',
    ]);
  });

  it('EDGAR 429 for a resolved ticker -> 502 SEC_UNAVAILABLE, FedReg never called', async () => {
    // FedReg is a full-text term search: its hits are never checked against
    // the entity, so it must NEVER stand in for a resolved company's filings
    // (live proof: term AAPL returns "Regulation NMS" / "Accredited Investor
    // Definition" — neither is an Apple filing). Fail closed instead.
    const calls = { fedreg: 0, submissions: 0, tickers: 0 };
    const fetchImpl = stubFetchFactory({
      submissionsStatus: 429,
      submissions: {},
      fedreg: FEDREG_FIXTURE,
      calls,
    });
    const err = await expectApiError(
      handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
      502,
      'SEC_UNAVAILABLE',
    );
    expect(err.retryAfterSec).toBe(60);
    expect(calls.fedreg).toBe(0);
    expect(calls.submissions).toBe(1);
  });

  it('EDGAR network error for a resolved ticker -> 502 SEC_UNAVAILABLE, FedReg never called', async () => {
    const calls = { fedreg: 0, submissions: 0, tickers: 0 };
    const fetchImpl = stubFetchFactory({
      submissionsThrow: true,
      fedreg: FEDREG_FIXTURE,
      calls,
    });
    await expectApiError(
      handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
      502,
      'SEC_UNAVAILABLE',
    );
    expect(calls.fedreg).toBe(0);
    expect(calls.submissions).toBe(1);
  });

  it('EDGAR 429 + empty FedReg still -> 502 SEC_UNAVAILABLE (never 422)', async () => {
    const calls = { fedreg: 0, submissions: 0, tickers: 0 };
    const fetchImpl = stubFetchFactory({
      submissionsStatus: 429,
      submissions: {},
      fedreg: { count: 0, results: [] },
      calls,
    });
    await expectApiError(
      handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
      502,
      'SEC_UNAVAILABLE',
    );
    expect(calls.fedreg).toBe(0);
  });

  it('EDGAR 500 for a resolved ticker -> 502 SEC_UNAVAILABLE, FedReg never called', async () => {
    const calls = { fedreg: 0, submissions: 0, tickers: 0 };
    const fetchImpl = stubFetchFactory({
      submissionsStatus: 500,
      submissions: {},
      fedreg: FEDREG_FIXTURE,
      calls,
    });
    await expectApiError(
      handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
      502,
      'SEC_UNAVAILABLE',
    );
    expect(calls.fedreg).toBe(0);
  });

  it('EDGAR 404 -> 422 ENTITY_NOT_FOUND', async () => {
    // EDGAR returns 404 for CIK9999999999 (verified live); the 404 -> 422
    // mapping is correct and must keep working.
    const fetchImpl = stubFetchFactory({ submissionsStatus: 404, submissions: {} });
    await expectApiError(
      handleFilings({ entity: '9999999999', period: '2026' }, { fetchImpl }),
      422,
      'ENTITY_NOT_FOUND',
    );
  });

  it('missing SEC_USER_AGENT -> 502 SEC_USER_AGENT_MISSING', async () => {
    const saved = process.env.SEC_USER_AGENT;
    delete process.env.SEC_USER_AGENT;
    try {
      const fetchImpl = stubFetchFactory({ submissions: SUBMISSIONS_FIXTURE });
      await expectApiError(
        handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
        502,
        'SEC_USER_AGENT_MISSING',
      );
    } finally {
      if (saved !== undefined) process.env.SEC_USER_AGENT = saved;
    }
  });
});

describe('handleFilings — upstream hardening (stubbed upstream)', () => {
  beforeEach(() => {
    process.env.SEC_USER_AGENT = TEST_UA;
    __clearTickersCacheForTests();
    __seedTickersCacheForTests(TICKERS_FIXTURE);
  });
  afterEach(() => {
    __clearTickersCacheForTests();
  });

  it('EDGAR 200 with malformed JSON -> 502 SEC_UNAVAILABLE (ApiError, not raw SyntaxError)', async () => {
    const fetchImpl = stubFetchFactory({ submissionsRaw: '<html>not json</html>' });
    await expectApiError(
      handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
      502,
      'SEC_UNAVAILABLE',
    );
  });

  it('EDGAR 200 with empty body -> 502 SEC_UNAVAILABLE', async () => {
    const fetchImpl = stubFetchFactory({ submissionsRaw: '' });
    await expectApiError(
      handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
      502,
      'SEC_UNAVAILABLE',
    );
  });

  it('FedReg 200 with malformed JSON -> 502 FEDREG_UNAVAILABLE', async () => {
    const fetchImpl = stubFetchFactory({ fedregRaw: '{bad json' });
    await expectApiError(
      handleFilings({ entity: 'ZZZZNOTREAL', period: '2026' }, { fetchImpl }),
      502,
      'FEDREG_UNAVAILABLE',
    );
  });

  it('EDGAR 200 payload without cik -> 502 SEC_UNAVAILABLE (never a "verified" zero)', async () => {
    const noCik = { filings: SUBMISSIONS_FIXTURE.filings };
    const fetchImpl = stubFetchFactory({ submissions: noCik });
    await expectApiError(
      handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
      502,
      'SEC_UNAVAILABLE',
    );
  });

  it('EDGAR 200 payload with malformed filingDate -> 502 SEC_UNAVAILABLE', async () => {
    const badDate = {
      ...SUBMISSIONS_FIXTURE,
      filings: {
        recent: {
          ...SUBMISSIONS_FIXTURE.filings.recent,
          filingDate: ['2026-1-5', '2025-11-03', '2025-08-01', '2024-11-01'],
        },
      },
    };
    const fetchImpl = stubFetchFactory({ submissions: badDate });
    await expectApiError(
      handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl }),
      502,
      'SEC_UNAVAILABLE',
    );
  });

  it('generic entities -> 422 AMBIGUOUS_ENTITY', async () => {
    const fetchImpl = stubFetchFactory({
      submissions: SUBMISSIONS_FIXTURE,
      fedreg: FEDREG_FIXTURE,
    });
    for (const generic of ['a', 'the', 'co', 'inc']) {
      await expectApiError(
        handleFilings({ entity: generic, period: '2026' }, { fetchImpl }),
        422,
        'AMBIGUOUS_ENTITY',
      );
    }
  });

  it('Apple still resolves (name match, confidence 0.9)', async () => {
    const fetchImpl = stubFetchFactory({ submissions: SUBMISSIONS_FIXTURE });
    const result = await handleFilings({ entity: 'Apple', period: '2026' }, { fetchImpl });
    expect(result.confidence).toBe(0.9);
    expect(result.entity).toBe('Apple');
    expect(result.filing_count).toBe(1);
    expect(result.source).toBe('SEC EDGAR Submissions API');
  });

  it('year 9999 via handler -> 400 INVALID_PERIOD', async () => {
    await expectApiError(
      handleFilings({ entity: 'AAPL', period: '9999' }),
      400,
      'INVALID_PERIOD',
    );
  });

  it('no-CIK path still fails over to FedReg (called exactly once) and returns its hits', async () => {
    const calls = { fedreg: 0, submissions: 0, tickers: 0 };
    const fetchImpl = stubFetchFactory({ fedreg: FEDREG_FIXTURE, calls });
    const result = await handleFilings(
      { entity: 'Environmental Protection Agency', period: '2026' },
      { fetchImpl },
    );
    expect(calls.fedreg).toBe(1);
    expect(calls.submissions).toBe(0);
    expect(result.source).toBe('Federal Register API');
    expect(result.filing_count).toBe(1);
  });

  it('tickers 403 after TTL reuses the stale cache', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
      __clearTickersCacheForTests();
      __seedTickersCacheForTests(TICKERS_FIXTURE);
      // Advance past the 24h TTL so the next load re-fetches tickers.
      vi.setSystemTime(new Date('2026-11-21T13:00:00Z'));
      const calls = { fedreg: 0, submissions: 0, tickers: 0 };
      const fetchImpl = stubFetchFactory({
        submissions: SUBMISSIONS_FIXTURE,
        tickersStatus: 403,
        calls,
      });
      const result = await handleFilings({ entity: 'AAPL', period: '2026' }, { fetchImpl });
      expect(calls.tickers).toBe(1);
      expect(result.source).toBe('SEC EDGAR Submissions API');
      expect(result.filing_count).toBe(1);
    } finally {
      vi.useRealTimers();
      __clearTickersCacheForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// Live tests — REAL SEC EDGAR, no mocks/stubs.
// ---------------------------------------------------------------------------

describe('handleFilings — live SEC EDGAR', () => {
  beforeAll(() => {
    process.env.SEC_USER_AGENT = TEST_UA;
  });
  beforeEach(() => {
    __clearTickersCacheForTests();
  });
  afterEach(() => {
    __clearTickersCacheForTests();
  });

  it(
    'AAPL, last 12 months -> filing_count > 0 with a real accession URL that returns 200',
    async () => {
      const result = await handleFilings({ entity: 'AAPL', period: 'last 12 months' });
      expect(typeof result.filing_count).toBe('number');
      expect(result.filing_count as number).toBeGreaterThan(0);
      const filings = result.filings as Array<Record<string, string>>;
      expect(filings.length).toBeGreaterThan(0);
      expect(filings[0].accession).toMatch(/^\d{10}-\d{2}-\d{6}$/);
      expect(filings[0].url).toMatch(
        /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/\d+\//,
      );
      // Verify one real accession URL returns HTTP 200.
      const res = await fetch(filings[0].url, {
        headers: { 'User-Agent': TEST_UA },
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();
      // Report the exact live numbers in the test output.
      console.log(
        `LIVE AAPL last 12 months: filing_count=${result.filing_count} first_accession=${filings[0].accession} first_url=${filings[0].url} url_status=${res.status}`,
      );
    },
    60_000,
  );

  it(
    'ZZZZNOTREAL, last 12 months -> 422 ENTITY_NOT_FOUND',
    async () => {
      await expectApiError(
        handleFilings({ entity: 'ZZZZNOTREAL', period: 'last 12 months' }),
        422,
        'ENTITY_NOT_FOUND',
      );
    },
    60_000,
  );
});
