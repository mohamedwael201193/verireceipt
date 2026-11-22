// Escrow-paid Engine asks (escrow-inference.md "Putting It Together"),
// with the Desk's spend policy enforced before anything is signed.
import { randomUUID } from "node:crypto";
import { DESK_MAX_CALL_UUSDC, ENGINE_URL, NODE_URL } from "./constants.js";
import {
  buildAuthorization,
  decodeReceipt,
  encodePayment,
  EscrowRefusal,
  fillTemplate,
  parseEscrowChallenge,
  type Authorization,
  type TelegraphReceipt,
} from "./escrow.js";

export type Fetch = typeof fetch;
export type SignMessage = (message: string) => Promise<string>;

export interface Payer {
  address: string;
  signMessage: SignMessage;
}

export interface LedgerAccount {
  deposited: string;
  balance: string;
  available: string;
  unbilled: string;
  charged: string;
}

/** GET /v1/ledger/account/{address} (escrow-inference.md "Read your balance back"). */
export async function readLedgerAccount(address: string, f: Fetch = fetch): Promise<LedgerAccount> {
  const res = await f(`${NODE_URL}/v1/ledger/account/${address.toLowerCase()}`);
  if (!res.ok) throw new Error(`ledger account HTTP ${res.status}`);
  return (await res.json()) as LedgerAccount;
}

export interface PaidAsk {
  status: number;
  body: unknown;
  receipt: TelegraphReceipt;
  authorization: Authorization;
  quotedUusdc: bigint;
  /** The fully filled message that was signed (contains no secret). */
  signedMessage: string;
}

export interface AskOptions {
  /** μUSDC already signed today (UTC); the Desk refuses to cross its daily cap. */
  spentTodayUusdc: bigint;
  dailyCapUusdc: bigint;
  now?: () => number;
  nonce?: () => string;
  f?: Fetch;
  /** Every id the node may use for this miner in the receipt (catalogue id, registration id). */
  minerIds?: readonly string[];
  /** Called with the raw served response BEFORE any check, so evidence is never lost. */
  onRawResponse?: (raw: RawResponse) => void | Promise<void>;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  authorization: Authorization;
  signedMessage: string;
}

/**
 * Direct canonical ask to one miner, paid from escrow:
 * 1) POST without payment -> 402 challenge; 2) check + sign the escrow
 * template; 3) POST the same body with X-PAYMENT; 4) decode the receipt.
 * Refuses before signing if the quote exceeds one flat call, the daily cap,
 * or the escrow's `available` balance.
 */
export async function escrowAskMiner(
  minerId: string,
  requestBody: Record<string, unknown>,
  payer: Payer,
  opts: AskOptions,
): Promise<PaidAsk> {
  const f = opts.f ?? fetch;
  const url = `${ENGINE_URL}/v1/ask/${minerId}`;
  const resource = `/v1/ask/${minerId}`;
  const body = JSON.stringify(requestBody);
  const json = { "Content-Type": "application/json" };

  const first = await f(url, { method: "POST", headers: json, body });
  if (first.status !== 402) {
    throw new EscrowRefusal(`expected a 402 challenge, got HTTP ${first.status}: ${(await first.text()).slice(0, 300)}`);
  }
  const challenge = parseEscrowChallenge(await first.json(), resource);

  if (challenge.amountUusdc > DESK_MAX_CALL_UUSDC) {
    throw new EscrowRefusal(`quote ${challenge.amountUusdc} μUSDC exceeds the Desk per-call cap ${DESK_MAX_CALL_UUSDC}`);
  }
  if (opts.spentTodayUusdc + challenge.amountUusdc > opts.dailyCapUusdc) {
    throw new EscrowRefusal(`quote would cross the Desk daily cap ${opts.dailyCapUusdc} μUSDC`);
  }
  const account = await readLedgerAccount(payer.address, f);
  if (BigInt(account.available) < challenge.amountUusdc) {
    throw new EscrowRefusal(`escrow available ${account.available} μUSDC < quote ${challenge.amountUusdc}`);
  }

  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const nonce = (opts.nonce ?? (() => `vr-desk-${randomUUID()}`))();
  const authorization = buildAuthorization(challenge, payer.address, now, nonce);
  const signedMessage = fillTemplate(challenge.accept.extra.message, authorization);
  const signature = await payer.signMessage(signedMessage);
  const payment = encodePayment(challenge.accept.network, signature, authorization);

  const paid = await f(url, { method: "POST", headers: { ...json, "X-PAYMENT": payment }, body });
  const text = await paid.text();
  await opts.onRawResponse?.({
    status: paid.status,
    headers: Object.fromEntries(paid.headers.entries()),
    bodyText: text,
    authorization,
    signedMessage,
  });
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (paid.status !== 200) {
    const reason = (parsed as { reason?: string; error?: string })?.reason ?? (parsed as { error?: string })?.error;
    throw new EscrowRefusal(`paid ask refused: HTTP ${paid.status} ${reason ?? text.slice(0, 300)} (not charged; header ${paid.headers.get("x-payment-response") ? "present" : "absent"})`);
  }
  const receipt = decodeReceipt(paid.headers.get("x-payment-response"), {
    payer: authorization.from,
    miners: opts.minerIds ?? [minerId],
    amountUusdc: authorization.value,
  });
  return { status: paid.status, body: parsed, receipt, authorization, quotedUusdc: challenge.amountUusdc, signedMessage };
}
