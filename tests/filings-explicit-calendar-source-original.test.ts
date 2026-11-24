import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePeriod } from '../src/handlers/filings';
const source = JSON.parse(readFileSync(join(__dirname, 'fixtures/source-qualified-real-inputs.json'), 'utf8'));
const captureClock = Math.max(...source.sources.map((s: { captured_at: string }) => Date.parse(s.captured_at))) + 1000;
const networkBoundary = vi.fn(async () => { throw new Error('Unexpected external IO in captured-source controls'); });
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(captureClock); vi.stubGlobal('fetch', networkBoundary); });
afterAll(() => { expect(networkBoundary).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); });
// Mechanically separated from the original 88-control file; assertion block unchanged.
const year = source.issuer.calendar_year as number;
for (const quarter of [1, 2, 3, 4]) {
  const start = new Date(Date.UTC(year, (quarter - 1) * 3, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10);
  for (const label of [`calendar Q${quarter} ${year}`, `calendar quarter ${quarter} of ${year}`,
    `during the calendar Q${quarter} ${year}`]) {
    it(`explicit calendar-only quarter has exact boundaries: ${label}`, () => {
      expect(parsePeriod(label)).toEqual({ start, end, label });
      if (quarter === source.issuer.calendar_quarter) {
        expect((source.filing_dates as string[]).filter(date => date >= start && date <= end))
          .toHaveLength(source.issuer.expected_count);
      }
    });
  }
}
for (const label of [`${source.issuer.start}..${source.issuer.end}`, `calendar quarter ending ${source.issuer.end}`]) {
  it(`keeps the existing equivalent real-source period: ${label}`, () => {
    expect(parsePeriod(label)).toMatchObject({ start: source.issuer.start, end: source.issuer.end });
  });
}
for (const label of [`calendar Q0 ${year}`, `calendar Q5 ${year}`, `calendar Q4 ${year} or calendar Q3 ${year}`]) {
  it(`does not infer an unqualified or invalid quarter: ${label}`, () => {
    expect(() => parsePeriod(label)).toThrow();
  });
}
// F1: an unqualified Q<n> year is now read as the CALENDAR quarter with the
// resolved range disclosed in the label; the fiscal boundary below is unchanged.
{
  const q = source.issuer.calendar_quarter as number;
  const qStart = new Date(Date.UTC(year, (q - 1) * 3, 1)).toISOString().slice(0, 10);
  const qEnd = new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10);
  it(`accepts an unqualified quarter as the disclosed calendar quarter: Q${q} ${year}`, () => {
    expect(parsePeriod(`Q${q} ${year}`)).toEqual({
      start: qStart, end: qEnd, label: `Q${q} ${year} (calendar quarter ${qStart}..${qEnd})`,
    });
    expect((source.filing_dates as string[]).filter(date => date >= qStart && date <= qEnd))
      .toHaveLength(source.issuer.expected_count);
  });
}
for (const label of [`fiscal Q4 ${year}`, `calendar fiscal Q4 ${year}`, `FY ${year} Q4`]) {
  it(`preserves the fiscal boundary: ${label}`, () => {
    try { parsePeriod(label); throw new Error('Fiscal wording accepted'); }
    catch (error) { expect(error).toMatchObject({ status: 400, code: 'FISCAL_PERIOD_UNSUPPORTED' }); }
  });
}
