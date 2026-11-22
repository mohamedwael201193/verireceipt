// Hosted testnet research policy. Disabled unless explicitly enabled by the operator.
import { createHash } from 'node:crypto';
export const VISITOR_LIMITS = Object.freeze({
  network: 'eip155:11155111', perCallUusdc: 10_000n, dailyUusdc: 100_000_000n,
  minimumReserveUusdc: 1_000_000n, requestsPerMinute: 10, networkRequestsPerMinute: 100, executionMs: 90_000,
  uncertainLeaseSeconds: 180, maxBodyBytes: 2048,
  dailyStoredBytes: 512_000_000, maxJobStoredBytes: 4_200_000,
});
export interface VisitorInput { cik: string; year: number; form: '10-Q' | '10-K' | '8-K'; minimum_count: number }
export function validateVisitorInput(v: unknown, now = new Date()): VisitorInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid research input');
  const p = v as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'cik,form,minimum_count,year' || typeof p.cik !== 'string' || !/^[1-9][0-9]{0,9}$/.test(p.cik) || typeof p.year !== 'number' || !Number.isInteger(p.year) || p.year < 1994 || p.year >= now.getUTCFullYear() || !['10-Q','10-K','8-K'].includes(String(p.form)) || typeof p.minimum_count !== 'number' || !Number.isInteger(p.minimum_count) || p.minimum_count < 1 || p.minimum_count > 1000) throw new Error('Use canonical CIK, completed year, exact form and integer minimum from 1 to 1000');
  return { cik: p.cik, year: p.year, form: p.form as VisitorInput['form'], minimum_count: p.minimum_count };
}
export function visitorHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function validateRequestId(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)) throw new Error('Provide a UUID-v4 request id');
  return v.toLowerCase();
}
