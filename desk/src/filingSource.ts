// Independent SEC recount, not a benchmark-answer lookup. The requested CIK,
// form and date range determine what is fetched and counted for any provider.
import { extractForms, mergeFormSpecs, parseFormType } from '../../src/handlers/filingsForms.js';
import { finishSource, isoDate, object, readPrimaryJson, sourceCheck, sourceResult, type SourceOptions, type SourceVerification } from './sourceTypes.js';

interface Filing { accession: string; date: string; form: string }
function parseRows(raw: unknown): Filing[] {
  const j = object(raw);
  const arrays = [j.accessionNumber, j.filingDate, j.form];
  if (arrays.some(x => !Array.isArray(x)) || arrays.some(x => x.length !== arrays[0].length) || arrays[0].length > 500000) {
    throw new Error('incomplete SEC filing arrays');
  }
  return j.accessionNumber.map((accession: unknown, i: number) => {
    const date = j.filingDate[i], form = j.form[i];
    if (typeof accession !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || !isoDate(date) || typeof form !== 'string' || !form.trim()) {
      throw new Error('malformed SEC accession/date/form');
    }
    return { accession, date, form };
  });
}
function periodBounds(period: string, now: Date): {start: string; end: string} {
  const year = /^(?:calendar\s+)?(\d{4})$/i.exec(period.trim());
  if (year) {
    const y = Number(year[1]);
    if (y < 1993 || y > now.getUTCFullYear()) throw new Error('unsupported filing year');
    return {start:year[1]+'-01-01',end:year[1]+'-12-31'};
  }
  const range = /^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/.exec(period.trim());
  if (!range || !isoDate(range[1]) || !isoDate(range[2]) || range[1] > range[2] || range[2] > now.toISOString().slice(0,10)) {
    throw new Error('filing period must be an explicit supported year or date range');
  }
  return {start:range[1],end:range[2]};
}
function nameKey(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]/g,''); }

export async function verifyFilingSource(
  input: { params: Record<string, string>; result: Record<string, unknown> },
  options: SourceOptions = {},
): Promise<SourceVerification> {
  const r = sourceResult();
  try {
    const ua = (options.secUserAgent ?? process.env.SEC_USER_AGENT ?? '').trim();
    if (!ua || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(ua)) throw new Error('SEC source verification needs SEC_USER_AGENT with a contact email');
    const headers = {'User-Agent':ua,Accept:'application/json'};
    const bounds = periodBounds(input.params.period ?? '',options.now ?? new Date());
    const entity = input.params.entity ?? '';
    const extracted = extractForms(entity,{allowCik:true,bareNumberCik:false});
    const explicitForms = [parseFormType(input.params.form_type),parseFormType(input.params.form)];
    const spec = mergeFormSpecs([
      {field:'entity',forms:extracted.forms},
      ...explicitForms.map((x,i) => ({field:i===0?'form_type':'form',forms:x.kind==='form'?[x.form]:[]})),
    ]);
    if (spec.kind !== 'form') throw new Error('an exact SEC form constraint is required');
    const explicitCiks = [...extracted.ciks];
    if (input.params.cik !== undefined) {
      if (!/^\d{1,10}$/.test(input.params.cik)) throw new Error('invalid explicit CIK');
      explicitCiks.push(Number(input.params.cik));
    }
    const uniqueCiks = [...new Set(explicitCiks)];
    if (uniqueCiks.length > 1 || uniqueCiks.some(c => !Number.isSafeInteger(c) || c <= 0 || c > 9999999999)) throw new Error('conflicting CIK constraints');
    let cik = uniqueCiks[0];
    const entityName = extracted.rest.replace(/\b(?:filings?|filed|forms?|reports?|by|for|of|on|the|sec|edgar)\b/gi,' ').replace(/[()]/g,' ').trim();
    if (!cik) {
      const tickers = await readPrimaryJson('https://www.sec.gov/files/company_tickers.json',r,options,{headers});
      const matches = Object.values(tickers).filter((x: any) => x && (String(x.ticker).toUpperCase() === entityName.toUpperCase() || nameKey(String(x.title)) === nameKey(entityName)));
      const ids = [...new Set(matches.map((x:any) => x.cik_str))];
      if (ids.length !== 1 || !Number.isSafeInteger(ids[0]) || Number(ids[0]) <= 0) throw new Error('SEC issuer does not resolve uniquely');
      cik = Number(ids[0]);
    }
    const cik10 = String(cik).padStart(10,'0');
    const main = await readPrimaryJson(`https://data.sec.gov/submissions/CIK${cik10}.json`,r,options,{headers});
    if (Number(main.cik) !== cik || typeof main.name !== 'string') throw new Error('SEC issuer CIK missing or mismatched');
    // An explicit company name beside a CIK cannot quietly refer to a different issuer.
    if (entityName && nameKey(entityName) !== nameKey(main.name)) {
      // Exact ticker aliases are verified through the official mapping, never guessed.
      const tickers = await readPrimaryJson('https://www.sec.gov/files/company_tickers.json',r,options,{headers});
      if (!Object.values(tickers).some((x:any) => x && x.cik_str === cik && String(x.ticker).toUpperCase() === entityName.toUpperCase())) {
        throw new Error('named issuer does not match SEC CIK identity');
      }
    }
    const filings = object(main.filings);
    if (!Array.isArray(filings.files) || filings.files.length > 64) throw new Error('missing or unbounded SEC history coverage');
    const all = parseRows(filings.recent);
    const names = new Set<string>();
    // Read all official history pages. Do not trust date-range metadata as a
    // reason to omit a page and silently undercount a requested period.
    for (const raw of filings.files) {
      const file = object(raw);
      if (typeof file.name !== 'string' || !new RegExp(`^CIK${cik10}-submissions-\\d{3,}\\.json$`).test(file.name) || names.has(file.name)) throw new Error('unsafe or duplicate SEC history filename');
      if (!Number.isSafeInteger(file.filingCount) || file.filingCount < 0) throw new Error('missing SEC history filingCount');
      names.add(file.name);
      const page = await readPrimaryJson(`https://data.sec.gov/submissions/${file.name}`,r,options,{headers});
      const more = parseRows(page);
      if (more.length !== file.filingCount) throw new Error('incomplete SEC history page');
      all.push(...more);
      if (all.length > 500000) throw new Error('SEC row evidence bound exceeded');
    }
    const unique = new Map<string,Filing>();
    for (const row of all) {
      const previous = unique.get(row.accession);
      if (previous && (previous.date !== row.date || previous.form !== row.form)) throw new Error('conflicting SEC duplicate accession');
      unique.set(row.accession,row);
    }
    const matching = [...unique.values()].filter(x => x.form === spec.form && x.date >= bounds.start && x.date <= bounds.end);
    r.details = {cik,form:spec.form,start:bounds.start,end:bounds.end,primary_count:matching.length,history_pages:names.size,unique_source_rows:unique.size};
    sourceCheck(r,'filing completeness',true,`read main document and all ${names.size} history pages, deduplicated by accession`);
    sourceCheck(r,'filing count',Number.isSafeInteger(input.result.filing_count) && input.result.filing_count === matching.length,`provider count ${String(input.result.filing_count)}; primary recount ${matching.length}`);
    let assertionsOk = input.result.form_type === undefined || input.result.form_type === spec.form;
    if (Array.isArray(input.result.urls)) assertionsOk &&= input.result.urls.every(url => typeof url === 'string' && /^https:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\//.test(url));
    if (Array.isArray(input.result.filings)) {
      for (const title of input.result.filings) {
        if (typeof title !== 'string') { assertionsOk=false;continue; }
        const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(title)?.[1];
        const form = /\bForm\s+([A-Z0-9-]+(?:\/A)?)\b/i.exec(title)?.[1];
        if (date && (date < bounds.start || date > bounds.end || !isoDate(date))) assertionsOk=false;
        if (form && form.toUpperCase() !== spec.form) assertionsOk=false;
      }
    }
    if (Array.isArray(input.result.filings_detail)) {
      for (const raw of input.result.filings_detail) {
        const row = object(raw);
        if (row.form !== spec.form || !isoDate(row.filing_date) || row.filing_date < bounds.start || row.filing_date > bounds.end) assertionsOk=false;
      }
    }
    sourceCheck(r,'returned filing assertions',assertionsOk,'returned form/date/source assertions must not contradict the committed query');
  } catch (error) {
    sourceCheck(r,'filing evidence available',false,error instanceof Error?error.message:'source verification failed');
  }
  return finishSource(r);
}
