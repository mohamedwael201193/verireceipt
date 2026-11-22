// A distinct build entry bundles only the existing research payment/verifier path.
// No request may provide a key, miner, endpoint, network or signing message.
import { privateKeyToAccount } from 'viem/accounts';
import { normalizePrivateKey } from './secrets.js';
import { makeResearchPlan, planHash } from './research.js';
import { runResearch } from './researchAgent.js';
import { readLedgerAccount } from './client.js';
import { makeVisitorFetch } from './visitorTransport.js';
function configuredPayer() {
  const secret = process.env.VISITOR_PAYER_PRIVATE_KEY;
  const expected = process.env.VISITOR_PAYER_ADDRESS;
  if (!secret || !expected || !/^0x[0-9a-fA-F]{40}$/.test(expected)) throw new Error('Hosted payer is not configured');
  const account = privateKeyToAccount(normalizePrivateKey(secret));
  if (account.address.toLowerCase() !== expected.toLowerCase()) throw new Error('Hosted payer address mismatch');
  return account;
}
/** Fail closed at service startup, before accepting sponsored jobs. */
export function assertVisitorConfiguration(): void { configuredPayer(); }
export async function executeVisitorResearch(input: { cik: string; year: number; form: string; minimum_count: number }, options: {
  spentTodayUusdc: string; dailyCapUusdc: string; reserveUusdc: string;
  signal: AbortSignal;
  recordHeaders: (response: { status: number; receiptHeader: string | null }) => Promise<void>;
  recordResponse: (response: { status: number; receiptHeader: string | null; bodyText: string }) => Promise<void>;
  beforeSign: (reservation: { plan_hash: string; at: string; reserved_uusdc: string; nonce: string }) => Promise<void>;
}) {
  const account = configuredPayer();
  const f = makeVisitorFetch(options.signal,account.address,fetch,options.recordHeaders);
  const available = await readLedgerAccount(account.address, f);
  if (!/^\d+$/.test(available.available) || BigInt(available.available) < BigInt(options.reserveUusdc) + 10_000n) throw new Error('Hosted payer reserve reached');
  const p = makeResearchPlan(input), hash = planHash(p);
  const result = await runResearch(p, hash, { address: account.address, signMessage: message => account.signMessage({ message }) }, {
    spentTodayUusdc: BigInt(options.spentTodayUusdc), dailyCapUusdc: BigInt(options.dailyCapUusdc),
    beforeSign: async reservation => {
      options.signal.throwIfAborted();
      if (reservation.reserved_uusdc !== '10000') throw new Error('Unexpected hosted quote');
      await options.beforeSign(reservation);
      options.signal.throwIfAborted();
    },
    // Only response status/body and the public receipt header are kept privately.
    // The signed request authorization and signed message are never stored here.
    onRawResponse: raw => options.recordResponse({ status:raw.status,receiptHeader:raw.headers['x-payment-response'] ?? null,bodyText:raw.bodyText }), f,
  });
  // Existing runResearch result has receipt/nonce but no signature or private key.
  return result;
}
