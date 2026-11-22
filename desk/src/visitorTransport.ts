// Server-only transport: fixed testnet node and receipt reads, bounded bytes/time.
import { ENGINE_URL, MINER_BASE_URL, NODE_URL, VERIRECEIPT_MINER_ID } from './constants.js';
import type { Fetch } from './client.js';
export function makeVisitorFetch(signal: AbortSignal, payer: string, transport: Fetch = fetch, recordHeaders?: (r: { status:number; receiptHeader:string|null }) => Promise<void>): Fetch {
  let totalBytes = 0, calls = 0;
  return async (input, init) => {
    signal.throwIfAborted();
    const raw = String(input), url = new URL(raw), method = (init?.method ?? 'GET').toUpperCase();
    if (url.href !== raw || url.username || url.password || url.search || url.hash) throw new Error('Noncanonical hosted evidence URL');
    const nodeGet = url.origin === NODE_URL && method === 'GET' && (
      url.pathname === `/v1/ledger/account/${payer.toLowerCase()}` ||
      /^\/engine\/v1\/signal\/0x[0-9a-f]{64}$/.test(url.pathname) ||
      /^\/v1\/blocks\/[0-9]{1,10}(?:\/deliveries\/0x[0-9a-f]{64})?$/.test(url.pathname));
    const nodeAsk = raw === `${ENGINE_URL}/v1/ask/${VERIRECEIPT_MINER_ID}` && method === 'POST';
    const receiptGet = url.origin === MINER_BASE_URL && method === 'GET' && /^\/receipts\/rcpt_[A-Z0-9]{26}(?:\/raw|\/pages\/(?:[0-9]|1[0-9])\/raw)?$/.test(url.pathname);
    if ((!nodeGet && !nodeAsk && !receiptGet) || ++calls > 40) throw new Error('Hosted evidence destination or request count refused');
    const response = await transport(raw, { ...init,redirect:'error',signal: init?.signal ? AbortSignal.any([signal,init.signal]) : signal });
    if (nodeAsk && new Headers(init?.headers).has('X-PAYMENT')) {
      if (!recordHeaders) { await response.body?.cancel(); throw new Error('Durable response header capture required'); }
      try { await recordHeaders({ status:response.status,receiptHeader:response.headers.get('x-payment-response') }); }
      catch (error) { await response.body?.cancel(); throw error; }
    }
    if (!response.body) return response;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done,value } = await reader.read(); if (done) break;
        size += value.length; totalBytes += value.length;
        if (size > 2_000_000 || totalBytes > 12_000_000) throw new Error('Hosted evidence byte budget reached');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    return new Response(bytes,{ status:response.status,statusText:response.statusText,headers:response.headers });
  };
}
