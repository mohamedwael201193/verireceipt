// A1 round 8 — reproduction of J2-r7's full SEC-title scan, run through the
// REAL handler (handleFilings) with ONLY the submissions fetch stubbed: the
// stub answers every data.sec.gov/submissions/CIK##########.json request
// with an empty-but-valid payload for exactly the CIK asked, so the scan
// measures entity/form resolution and never hammers SEC. The tickers map
// is whatever the caller passes (the LIVE test passes the real
// company_tickers.json fetched once).
//
// For every distinct SEC title T the scan asks:
//   1. "T filings"                     -> T's CIK, form_type null
//   2. "T"                             -> T's CIK, form_type null
//   3. "Form 10-K filings by T"        -> T's CIK, form_type 10-K
// A title whose canonical key is shared by more than one CIK must instead
// be 422 AMBIGUOUS_ENTITY (never a silent pick).
import { handleFilings, normalizeCompanyName } from '../../src/handlers/filings';
import { separatorsToSpaces } from '../../src/handlers/filingsEntity';

export interface ScanFailure {
  title: string;
  query: string;
  want: string;
  got: string;
}

export interface ScanResult {
  titles: number;
  queries: number;
  ambiguousTitles: number;
  failures: ScanFailure[];
}

type TickerMap = Record<string, { cik_str: number; ticker: string; title: string }>;

export function scanStubFetch(tickers: TickerMap, calls?: { fedreg: number }): typeof fetch {
  const body = JSON.stringify(tickers);
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('sec.gov/files/company_tickers.json')) return new Response(body, { status: 200 });
    const m = /data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/.exec(url);
    if (m) {
      return new Response(
        JSON.stringify({
          cik: String(Number(m[1])),
          name: 'stub',
          filings: { recent: { accessionNumber: [], filingDate: [], form: [], primaryDocument: [] }, files: [] },
        }),
        { status: 200 },
      );
    }
    if (url.includes('federalregister.gov') && calls) calls.fedreg += 1;
    return new Response('unexpected', { status: 599 });
  }) as unknown as typeof fetch;
}

export async function scanAllTitles(
  tickers: TickerMap,
  period = '2023',
  onProgress?: (done: number) => void,
  only?: string[],
): Promise<ScanResult & { fedregCalls: number }> {
  const byKey = new Map<string, Set<number>>();
  const titleOf = new Map<string, string>();
  // A one-word title that is also ANOTHER filer's ticker ("SUN": the title
  // of CIK 2070845 and Sunoco LP's ticker) is a genuine ambiguity.
  const tickerCik = new Map<string, number>();
  for (const e of Object.values(tickers)) if (!tickerCik.has(e.ticker.toUpperCase())) tickerCik.set(e.ticker.toUpperCase(), Number(e.cik_str));
  for (const e of Object.values(tickers)) {
    const k = normalizeCompanyName(separatorsToSpaces(e.title));
    const set = byKey.get(k) ?? new Set<number>();
    set.add(Number(e.cik_str));
    byKey.set(k, set);
    if (!titleOf.has(e.title)) titleOf.set(e.title, k);
  }
  const calls = { fedreg: 0 };
  const fetchImpl = scanStubFetch(tickers, calls);
  const failures: ScanFailure[] = [];
  let queries = 0;
  let ambiguousTitles = 0;
  let done = 0;
  const onlySet = only ? new Set(only) : null;
  for (const [title, key] of titleOf) {
    if (onlySet && !onlySet.has(title)) continue;
    done += 1;
    if (onProgress && done % 500 === 0) onProgress(done);
    const ciks = byKey.get(key) ?? new Set<number>();
    const asTicker = /\s/.test(title.trim()) ? undefined : tickerCik.get(title.trim().toUpperCase());
    const ambiguous = ciks.size > 1 || (asTicker !== undefined && !ciks.has(asTicker));
    if (ambiguous) ambiguousTitles += 1;
    for (const [query, form] of [
      [`${title} filings`, null],
      [title, null],
      [`Form 10-K filings by ${title}`, '10-K'],
    ] as Array<[string, string | null]>) {
      queries += 1;
      const want = ambiguous ? '422 AMBIGUOUS_ENTITY' : `CIK ${[...ciks][0]} form ${form}`;
      let got: string;
      try {
        const r = await handleFilings({ entity: query, period }, { fetchImpl });
        const url = String((r.receipt as { upstream_url?: string } | undefined)?.upstream_url ?? '');
        const cik = Number(/CIK(\d{10})\.json/.exec(url)?.[1] ?? NaN);
        got = `CIK ${cik} form ${(r.form_type as string | null) ?? null}`;
      } catch (err) {
        const e = err as { status?: number; code?: string; message?: string };
        got = `${e.status ?? 'throw'} ${e.code ?? e.message}`;
      }
      if (got !== want) failures.push({ title, query, want, got });
    }
  }
  // Every distinct ticker, alone and with "filings": the first
  // company_tickers entry with that ticker (the resolver's rule), unless
  // the ticker is also the exact title key of a different filer.
  const seenTicker = new Set<string>();
  for (const e of Object.values(tickers)) {
    const tk = e.ticker;
    if (onlySet && !onlySet.has(e.title)) continue;
    if (seenTicker.has(tk.toUpperCase())) continue;
    seenTicker.add(tk.toUpperCase());
    const titleCiks = byKey.get(normalizeCompanyName(separatorsToSpaces(tk)));
    const cik = Number(e.cik_str);
    const ambiguous = titleCiks !== undefined && [...titleCiks].some((c) => c !== cik);
    for (const query of [tk, `${tk} filings`]) {
      queries += 1;
      const want = ambiguous ? '422 AMBIGUOUS_ENTITY' : `CIK ${cik} form null`;
      let got: string;
      try {
        const r = await handleFilings({ entity: query, period }, { fetchImpl });
        const url = String((r.receipt as { upstream_url?: string } | undefined)?.upstream_url ?? '');
        got = `CIK ${Number(/CIK(\d{10})\.json/.exec(url)?.[1] ?? NaN)} form ${(r.form_type as string | null) ?? null}`;
      } catch (err) {
        const x = err as { status?: number; code?: string; message?: string };
        got = `${x.status ?? 'throw'} ${x.code ?? x.message}`;
      }
      if (got !== want) failures.push({ title: `ticker ${tk}`, query, want, got });
    }
  }
  return { titles: titleOf.size, queries, ambiguousTitles, failures, fedregCalls: calls.fedreg };
}
