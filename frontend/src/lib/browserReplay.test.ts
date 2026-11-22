// Captured real evidence is used for the passing case. Deliberate negative tests
// alter copies in test memory only; no altered evidence is shipped as product data.
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_EVIDENCE, recountPublishedSource, verifyPublishedSource } from './browserReplay';
const raw = readFileSync('tests/fixtures/tesla-stored-sec-20261121.json');
const real = () => JSON.parse(raw.toString());
const metadata = () => ({ receipt_id: PUBLIC_EVIDENCE.receipt, raw_response_sha256: PUBLIC_EVIDENCE.digest, upstream_url: PUBLIC_EVIDENCE.source, intent: 'REGULATORY_FILING_MONITOR_GENERAL', hash_algorithm: 'sha256', evidence_available: true });
const f = (meta: unknown = metadata(), bytes: Uint8Array = raw) => vi.fn<typeof fetch>(async url => String(url).endsWith('/raw') ? new Response(bytes as BodyInit) : Response.json(meta));
afterEach(() => vi.unstubAllGlobals());
describe('real published source browser subset', () => {
  it('recounts the exact three accessions from captured real stored SEC evidence', () => { expect(recountPublishedSource(real())).toHaveLength(3); });
  it('fetches only two fixed GET paths and verifies real byte hash', async () => {
    vi.stubGlobal('crypto', webcrypto); const fetcher = f(); const out = await verifyPublishedSource(new AbortController().signal, fetcher);
    expect(out.count).toBe(3); expect(out.digest).toBe(PUBLIC_EVIDENCE.digest); expect(out.bytes).toBe(162971);
    expect(fetcher.mock.calls).toHaveLength(2);
    for (const [url, init] of fetcher.mock.calls) { expect(url).toMatch(/^\/api\/receipts\/rcpt_COU5RNZ6QEOSTT9C796BO1U5IH(?:\/raw)?$/); expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' }); }
  });
  it.each(['receipt_id', 'raw_response_sha256', 'upstream_url', 'intent', 'hash_algorithm', 'evidence_available'])('HOLD deliberate metadata mutation: %s', async key => {
    const m = { ...metadata(), [key]: false }; const fetcher = f(m); await expect(verifyPublishedSource(new AbortController().signal, fetcher)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('HOLD deliberate one-byte raw mutation', async () => {
    vi.stubGlobal('crypto', webcrypto); const altered = Buffer.from(raw); altered[100] ^= 1;
    await expect(verifyPublishedSource(new AbortController().signal, f(metadata(), altered))).rejects.toThrow('SHA256 mismatch');
  });
  it('HOLD public evidence unavailable without retry', async () => { const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 404 })); await expect(verifyPublishedSource(new AbortController().signal, fetcher)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1); });
  it('HOLD evidence larger than 2 MB', async () => { await expect(verifyPublishedSource(new AbortController().signal, f(metadata(), new Uint8Array(2_000_001)))).rejects.toThrow('2 MB'); });
  it('HOLD an aborted check', async () => { const c = new AbortController(); c.abort(); await expect(verifyPublishedSource(c.signal, f())).rejects.toThrow(); });
  it.each(['cik', 'name'])('HOLD deliberate source identity mutation: %s', key => { const x = real(); x[key] = 'wrong'; expect(() => recountPublishedSource(x)).toThrow(); });
  it('HOLD a newly required history page', () => { const x = real(); x.filings.files.push({ name: 'CIK0001318605-submissions-999.json', filingFrom: '2024-01-01', filingTo: '2024-12-31' }); expect(() => recountPublishedSource(x)).toThrow('History required'); });
  it('HOLD unequal SEC columns', () => { const x = real(); x.filings.recent.form.pop(); expect(() => recountPublishedSource(x)).toThrow('columns'); });
  it('HOLD deliberately changed accession', () => { const x = real(); const a = x.filings.recent.accessionNumber; a[a.indexOf('0001628280-24-043486')] = '0001628280-24-999999'; expect(() => recountPublishedSource(x)).toThrow('Recount differs'); });
  it('HOLD an impossible calendar date', () => { const x = real(); x.filings.recent.filingDate[0] = '2024-02-30'; expect(() => recountPublishedSource(x)).toThrow('filing row'); });
  it('HOLD document traversal', () => { const x = real(); x.filings.recent.primaryDocument[0] = '../secret'; expect(() => recountPublishedSource(x)).toThrow('filing row'); });
  it('HOLD unknown history date format', () => { const x = real(); x.filings.files[0].filingFrom = 'unknown'; expect(() => recountPublishedSource(x)).toThrow(); });
});
