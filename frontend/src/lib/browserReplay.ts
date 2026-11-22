// Read-only browser subset of the historical judge replay. No wallet or purchase.
import run from '../../../docs/research-evidence/tesla-2024-10q-20261121.json';

// Pinned to the stored bytes independently recounted by the published CLI run.
export const PUBLIC_EVIDENCE = {
  receipt: 'rcpt_COU5RNZ6QEOSTT9C796BO1U5IH',
  digest: '62f75fb4293280aef09dc4a5190976f3ca39ca6ad2f7fa1600b0057b708e4150',
  source: 'https://data.sec.gov/submissions/CIK0001318605.json',
};
export interface BrowserReplay { checkedAt: string; count: number; digest: string; bytes: number; accessions: string[] }
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Malformed source object');
  return v as Record<string, unknown>;
}
export function recountPublishedSource(v: unknown): string[] {
  const main = object(v), filings = object(main.filings), recent = object(filings.recent);
  if (!/^\d{1,10}$/.test(String(main.cik)) || Number(main.cik) !== Number(run.plan.cik) || main.name !== run.result.source_name || !Array.isArray(filings.files)) throw new Error('Source identity or manifest unavailable');
  // This bounded browser verifier supports the published record with no required history.
  // It withholds a count if the manifest requires any historical page.
  for (const item of filings.files) {
    const f = object(item);
    if (typeof f.name !== 'string' || !/^CIK0001318605-submissions-\d{3}\.json$/.test(f.name) || typeof f.filingFrom !== 'string' || typeof f.filingTo !== 'string' || !validDate(f.filingFrom) || !validDate(f.filingTo) || f.filingFrom > f.filingTo) throw new Error('Invalid history manifest');
    if (f.filingFrom <= '2024-12-31' && f.filingTo >= '2024-01-01') throw new Error('History required. Use the full CLI replay');
  }
  const columns = ['form', 'accessionNumber', 'filingDate', 'primaryDocument'].map(k => recent[k]);
  if (columns.some(c => !Array.isArray(c)) || columns.some(c => (c as unknown[]).length !== (columns[0] as unknown[]).length) || (columns[0] as unknown[]).length > 10000) throw new Error('Invalid SEC columns');
  const rows = new Map<string, string>();
  const selected: string[] = [];
  for (let i = 0; i < (columns[0] as unknown[]).length; i++) {
    const [form, accession, date, document] = columns.map(c => (c as unknown[])[i]);
    if (typeof form !== 'string' || typeof accession !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || typeof date !== 'string' || !validDate(date) || typeof document !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(document) || document.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid SEC filing row');
    const canonical = JSON.stringify([form, date, document]);
    if (rows.has(accession)) {
      if (rows.get(accession) !== canonical) throw new Error('Conflicting accession');
      continue;
    }
    rows.set(accession, canonical);
    if (form === run.plan.form && date >= '2024-01-01' && date <= '2024-12-31') selected.push(accession);
  }
  const expected = run.result.rows.map(r => r.accession).sort();
  selected.sort();
  if (JSON.stringify(selected) !== JSON.stringify(expected) || selected.length !== run.result.observed_count) throw new Error('Recount differs from published record');
  return selected;
}
function validDate(v: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v; }
async function boundedBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error('Evidence unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 2_000_000) throw new Error('Evidence exceeds 2 MB limit'); chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return bytes;
}
export async function verifyPublishedSource(signal: AbortSignal, f: typeof fetch = fetch): Promise<BrowserReplay> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 45000);
  const budget = controller.signal;
  try {
  const base = `/api/receipts/${PUBLIC_EVIDENCE.receipt}`;
  const get = async (url: string) => boundedBytes(await f(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: budget }), budget);
  const decode = (b: Uint8Array) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
  const meta = object(decode(await get(base)));
  if (meta.receipt_id !== PUBLIC_EVIDENCE.receipt || meta.raw_response_sha256 !== PUBLIC_EVIDENCE.digest || meta.upstream_url !== PUBLIC_EVIDENCE.source || meta.intent !== run.receipt.intent || meta.hash_algorithm !== 'sha256' || meta.evidence_available !== true) throw new Error('Receipt metadata differs from published record');
  const bytes = await get(`${base}/raw`);
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
  if (digest !== PUBLIC_EVIDENCE.digest) throw new Error('Stored-byte SHA256 mismatch');
  const accessions = recountPublishedSource(decode(bytes));
  budget.throwIfAborted();
  return { checkedAt: new Date().toISOString(), count: accessions.length, digest, bytes: bytes.length, accessions };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
