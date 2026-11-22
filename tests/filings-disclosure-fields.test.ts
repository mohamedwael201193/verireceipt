import { describe, expect, it } from 'vitest';
import { buildFilingsFromSubmissions } from '../src/handlers/filings';

// Independently authored unit tests for the optional EDGAR columns that
// enrich filings_detail: acceptanceDateTime (accepted date),
// primaryDocDescription and items (disclosure line). No evaluator examples,
// live sources, or network requests are used.

function payload(overrides: Record<string, unknown>): unknown {
  return {
    cik: 320193,
    filings: {
      recent: {
        accessionNumber: ['0000320193-26-000001', '0000320193-26-000002'],
        filingDate: ['2026-09-29', '2026-09-09'],
        form: ['8-K', '4'],
        primaryDocument: ['a8k.htm', 'form4.xml'],
        ...overrides,
      },
    },
  };
}

describe('buildFilingsFromSubmissions optional disclosure columns', () => {
  it('carries accepted date, description and items when EDGAR supplies aligned columns', () => {
    const filings = buildFilingsFromSubmissions(payload({
      acceptanceDateTime: ['2026-09-29T18:23:44.000Z', '2026-09-09T21:05:12.000Z'],
      primaryDocDescription: ['CURRENT REPORT', 'STATEMENT OF CHANGES IN BENEFICIAL OWNERSHIP'],
      items: ['2.02 Results of Operations and Financial Condition', ''],
    }) as never);
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({
      form: '8-K',
      accepted: '2026-09-29T18:23:44.000Z',
      description: 'CURRENT REPORT',
      items: '2.02 Results of Operations and Financial Condition',
    });
    // An empty items string leaves the field unset, never fabricated.
    expect(filings[1]).toMatchObject({
      form: '4',
      accepted: '2026-09-09T21:05:12.000Z',
      description: 'STATEMENT OF CHANGES IN BENEFICIAL OWNERSHIP',
    });
    expect(filings[1]).not.toHaveProperty('items');
  });

  it('omits the fields entirely when EDGAR omits the columns (pre-2001 filings)', () => {
    const filings = buildFilingsFromSubmissions(payload({}) as never);
    expect(filings).toHaveLength(2);
    for (const f of filings) {
      expect(f).not.toHaveProperty('accepted');
      expect(f).not.toHaveProperty('description');
      expect(f).not.toHaveProperty('items');
    }
  });

  it('ignores a misaligned optional column instead of shifting data onto the wrong filing', () => {
    const filings = buildFilingsFromSubmissions(payload({
      acceptanceDateTime: ['2026-09-29T18:23:44.000Z'],
      primaryDocDescription: 'not-an-array',
    }) as never);
    expect(filings).toHaveLength(2);
    for (const f of filings) {
      expect(f).not.toHaveProperty('accepted');
      expect(f).not.toHaveProperty('description');
    }
  });

  it('drops a malformed acceptance datetime but keeps the filing and its good fields', () => {
    const filings = buildFilingsFromSubmissions(payload({
      acceptanceDateTime: ['not a timestamp', '2026-09-09T21:05:12.000Z'],
    }) as never);
    expect(filings).toHaveLength(2);
    expect(filings[0]).not.toHaveProperty('accepted');
    expect(filings[1]).toMatchObject({ accepted: '2026-09-09T21:05:12.000Z' });
  });
});
