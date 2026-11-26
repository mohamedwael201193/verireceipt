import { upstreamUnavailable } from './errors';

// Private diagnostic labels, set only where the reader observes the failure.
const publicFailures=new WeakMap<object,string>();
export function publicSourceFailure(error:unknown):string {try{return error!==null&&typeof error==='object'?publicFailures.get(error)??'unknown':'unknown';}catch{return 'unknown';}}
/** Small bounded public-source reader. URLs are constructed by adapters, never user URLs. */
export interface PublicBody { url: string; raw: string; fetchedAt: string }
export async function readPublicBody(url: string, maxBytes = 1_000_000, timeoutMs = 4000, userAgent = 'VeriReceipt/2.0 public-source observer', accept = 'application/json'): Promise<PublicBody> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let failure="transport";
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { accept, 'user-agent': userAgent } });
    if (!response.ok) { failure=response.status===403?'http_403':response.status===429?'http_429':response.status>=400&&response.status<500?'http_4xx':response.status>=500?'http_5xx':'http_other'; throw upstreamUnavailable('PUBLIC_SOURCE_HTTP', `public source returned HTTP ${response.status}`); }
    failure="body_read";
    const size = response.headers.get('content-length');
    if (size && Number(size) > maxBytes) { await response.body?.cancel(); throw new Error('source body exceeds limit'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('source body missing');
    const parts: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw new Error('source body exceeds limit'); }
        parts.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return { url, raw: Buffer.concat(parts).toString('utf8'), fetchedAt: new Date().toISOString() };
  } catch(error) {try{if(error!==null&&typeof error==='object')publicFailures.set(error,controller.signal.aborted?'timeout':failure);}catch{}throw error;} finally { clearTimeout(timer); }
}

/** Single-process start budget; never queues callers past their response budget. */
export class StartBudget {
  private starts: number[] = [];
  constructor(readonly limit: number, readonly windowMs: number, private now: () => number = Date.now) {}
  take(): boolean {
    const now = this.now(); this.starts = this.starts.filter(t => t > now - this.windowMs);
    if (this.starts.length >= this.limit) return false;
    this.starts.push(now); return true;
  }
}

/** Bounded TTL/LRU source-body cache and same-key in-flight coalescing. Rejections are not cached. */
export class PublicBodyCache {
  private entries = new Map<string, { body: PublicBody; expires: number }>();
  private pending = new Map<string, Promise<PublicBody>>();
  constructor(readonly capacity: number, readonly ttlMs: number, private now: () => number = Date.now) {}
  get(key: string, load: () => Promise<PublicBody>): Promise<PublicBody> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) { this.entries.delete(key); this.entries.set(key, hit); return Promise.resolve({ ...hit.body }); }
    if (hit) this.entries.delete(key);
    const existing = this.pending.get(key); if (existing) return existing.then(body => ({ ...body }));
    if (this.pending.size >= this.capacity) return Promise.reject(new Error('source concurrency capacity reached'));
    const request = Promise.resolve().then(load).then(body => {
      this.entries.set(key, { body: { ...body }, expires: this.now() + this.ttlMs });
      while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
      return body;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request); return request.then(body => ({ ...body }));
  }
}
