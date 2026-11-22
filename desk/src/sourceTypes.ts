import { createHash } from 'node:crypto';
import type { Fetch } from './client.js';
import type { Check } from './verify.js';

export interface PrimarySource { url: string; sha256: string; retrieved_at: string; raw_text: string; encoding?: 'utf8' | 'base64' }
export interface SourceVerification {
  status: 'verified' | 'failed' | 'not_applicable';
  checks: Check[];
  sources: PrimarySource[];
  details: Record<string, unknown>;
}
export interface SourceOptions { f?: Fetch; now?: Date; secUserAgent?: string }
export function sourceResult(): SourceVerification {
  return { status: 'failed', checks: [], sources: [], details: {} };
}
export function sourceCheck(r: SourceVerification, name: string, ok: boolean, detail: string): void {
  r.checks.push({ name: `primary source ${name}`, ok, detail });
}
export function finishSource(r: SourceVerification): SourceVerification {
  r.status = r.checks.length > 0 && r.checks.every(c => c.ok) ? 'verified' : 'failed';
  return r;
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('primary response must be an object');
  return value as Record<string, any>;
}
export function isoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value+'T00:00:00Z'))
    && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
}
export async function readPrimaryJson(url: string, r: SourceVerification, options: SourceOptions, init?: RequestInit): Promise<Record<string, any>> {
  const response = await (options.f ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`primary HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 8_000_000) throw new Error('primary response exceeds evidence limit');
  if (r.sources.reduce((n,s) => n + Buffer.byteLength(s.raw_text),0) + Buffer.byteLength(text) > 16_000_000) throw new Error('primary evidence bundle exceeds limit');
  const parsed = object(JSON.parse(text));
  r.sources.push({ url: response.url || url, sha256: createHash('sha256').update(text).digest('hex'), retrieved_at: new Date().toISOString(), raw_text: text });
  return parsed;
}
