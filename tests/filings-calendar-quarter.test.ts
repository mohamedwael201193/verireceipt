import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/core/errors';
import { filterFilingsByPeriod, handleFilings, parsePeriod, tryParsePeriod, type Filing } from '../src/handlers/filings';
import { createHash } from 'node:crypto';

// Independently authored calendar grammar tests. No evaluator examples, live
// sources, real database, or network requests are used by this unit suite.
const noNetwork = vi.fn(async () => { throw new Error('Unexpected network in calendar period unit test'); });
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T07:00:00.000Z'));
  vi.stubGlobal('fetch', noNetwork);
  vi.stubEnv('SEC_USER_AGENT', 'VeriReceipt isolated unit coverage, no external HTTP');
});
afterAll(() => {
  expect(noNetwork).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const accepted: Array<[string, string, string]> = [
  ['quarter ending 2021-03-31', '2021-01-01', '2021-03-31'],
  ['quarter ended 2021-06-30', '2021-04-01', '2021-06-30'],
  ['the quarter ending 2021-09-30', '2021-07-01', '2021-09-30'],
  ['for the quarter ended 2021-12-31', '2021-10-01', '2021-12-31'],
  ['during the calendar quarter ending March 31, 2020', '2020-01-01', '2020-03-31'],
  ['in calendar quarter ended 30 June 2020', '2020-04-01', '2020-06-30'],
  ['quarter ending on September 30, 2018', '2018-07-01', '2018-09-30'],
  ['Quarter Ended Dec. 31, 2017', '2017-10-01', '2017-12-31'],
  ['quarter ended 31 Mar 2016', '2016-01-01', '2016-03-31'],
  ['quarter ending Sept 30 2015', '2015-07-01', '2015-09-30'],
  ['over the quarter ending June 30th, 2014', '2014-04-01', '2014-06-30'],
  ['quarter ended 31st December 2013', '2013-10-01', '2013-12-31'],
  ['quarter ending March 31st 2012', '2012-01-01', '2012-03-31'],
  ['  quarter   ending   2024-06-30  ', '2024-04-01', '2024-06-30'],
  ['ｑｕａｒｔｅｒ ｅｎｄｉｎｇ ２０２４－０３－３１', '2024-01-01', '2024-03-31'],
];

function expectPeriodError(text: string, code: string): void {
  try {
    parsePeriod(text);
    throw new Error('Invalid period was accepted');
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe(code);
  }
}

describe('calendar quarter-ending periods, original isolated grammar coverage', () => {
  it.each(accepted)('maps %s to exact inclusive filing-date boundaries', (text, start, end) => {
    expect(parsePeriod(text)).toEqual({ start, end, label: text.trim() });
  });

  it.each([
    'quarter ending 2024-02-29', 'quarter ending April 30, 2024',
    'quarter ending 2024-06-31', 'quarter ending 2024-09-31',
    'quarter ending 2024-03-30', 'quarter ending 2024-12-30',
    'quarter ending 2024-3-31', 'quarter ending 03/31/2024',
    'quarter ending March 31', 'quarter ending 30 September',
    'quarter ending March 31th, 2024', 'quarter ending 30st June 2024',
    'quarter ending June 30nd 2024', 'quarter ending constructor 31, 2024',
    'quarter ending 1992-12-31', 'quarter ending 2027-03-31',
    'quarter ending 2024-06-30 or 2024-09-30',
    'quarter ending 2024-06-30 excluding amendments',
    'quarter ending 2024-06-30 report period',
    'the two quarters ending 2024-06-30',
    'quarter starting 2024-04-01',
  ])('rejects ambiguous, invalid, non-calendar or unsupported wording: %s', text => {
    expectPeriodError(text, 'INVALID_PERIOD');
    expect(tryParsePeriod(text)).toBeNull();
  });

  it.each([
    'fiscal quarter ending 2024-06-30',
    'for the fiscal quarter ended September 30, 2024',
    'FY 2024 quarter ending 2024-12-31',
  ])('preserves fiscal-period refusal: %s', text => {
    expectPeriodError(text, 'FISCAL_PERIOD_UNSUPPORTED');
    expect(() => tryParsePeriod(text)).toThrow(ApiError);
  });

  it('filters filing_date inclusively, not an inferred company reporting quarter', () => {
    const dates = ['2024-03-31', '2024-04-01', '2024-05-20', '2024-06-30', '2024-07-01'];
    const filings: Filing[] = dates.map((date, i) => ({
      form: '10-Q', accession: `unit-only-${i}`, filing_date: date,
      url: `https://example.invalid/unit-only/${i}`,
    }));
    const result = filterFilingsByPeriod(filings, parsePeriod('calendar quarter ending 2024-06-30'));
    expect(result.map(f => f.filing_date)).toEqual(dates.slice(1, 4));
    expect(filings).toHaveLength(5);
  });

  it('carries quarter boundaries through handler form filtering and receipted raw bytes', async () => {
    // Synthetic SEC-shaped data only, never published or sent to a live endpoint.
    const body = JSON.stringify({
      cik: '0007654321', name: 'UNIT ONLY CALENDAR FIXTURE',
      filings: {
        recent: {
          accessionNumber: [1, 2, 3, 4, 5].map(n => `0007654321-24-${String(n).padStart(6, '0')}`),
          filingDate: ['2024-07-01', '2024-06-30', '2024-05-20', '2024-04-01', '2024-03-31'],
          form: ['10-Q', '10-Q', '10-Q/A', '10-Q', '10-Q'],
          primaryDocument: [1, 2, 3, 4, 5].map(n => `unit-only-${n}.htm`),
        }, files: [],
      },
    });
    const fetchFixture = vi.fn(async () => new Response(body, { status: 200 }));
    const storeFixture = vi.fn();
    const answer = await handleFilings(
      { entity: '7654321', period: 'calendar quarter ending June 30, 2024', form_type: '10-Q' },
      { fetchImpl: fetchFixture, saveReceiptImpl: storeFixture },
    );
    expect(answer.filing_count).toBe(2);
    expect(answer.form_counts).toEqual({ '10-Q': 2 });
    expect((answer.filings_detail as Filing[]).map(f => f.filing_date)).toEqual(['2024-06-30', '2024-04-01']);
    expect(answer.verdict).toBe('verified');
    expect(fetchFixture).toHaveBeenCalledTimes(1);
    expect(storeFixture).toHaveBeenCalledTimes(1);
    const [receipt, storedBody] = storeFixture.mock.calls[0];
    expect(storedBody).toBe(body);
    expect(receipt.raw_response_sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it.each([
    ['quarter ending 2024-04-30', 'INVALID_PERIOD'],
    ['fiscal quarter ending 2024-06-30', 'FISCAL_PERIOD_UNSUPPORTED'],
  ])('refuses %s before source transport or receipt writes', async (period, code) => {
    const fetchFixture = vi.fn(async () => new Response('{}'));
    const storeFixture = vi.fn();
    await expect(handleFilings(
      { entity: '7654321', period, form_type: '10-Q' },
      { fetchImpl: fetchFixture, saveReceiptImpl: storeFixture },
    )).rejects.toMatchObject({ status: 400, code });
    expect(fetchFixture).not.toHaveBeenCalled();
    expect(storeFixture).not.toHaveBeenCalled();
  });

  it.each([
    ['2014', '2014-01-01', '2014-12-31'],
    ['during calendar year 2017', '2017-01-01', '2017-12-31'],
    ['2018 through 2020', '2018-01-01', '2020-12-31'],
    ['2024-02-28..2024-03-01', '2024-02-28', '2024-03-01'],
    ['2024-02-29 to 2024-03-31', '2024-02-29', '2024-03-31'],
    ['last 1 month', '2026-10-22', '2026-11-22'],
  ])('keeps existing period grammar: %s', (text, start, end) => {
    expect(parsePeriod(text)).toEqual({ start, end, label: text });
  });
});
