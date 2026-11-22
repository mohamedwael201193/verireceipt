// Escrow-paid Engine asks (escrow-inference.md "Putting It Together"),
// with the Desk's spend policy enforced before anything is signed.
import { randomUUID } from "node:crypto";
import { DESK_MAX_CALL_UUSDC, ENGINE_URL, NODE_URL, ONE_CALL_UUSDC } from "./constants.js";
import {
  assertBudget,
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
  /**
   * Called with the quote and the filled authorization AFTER the challenge
   * checks but BEFORE the message is signed, so the caller can journal the
   * spend reservation. A throw aborts the purchase before any signature.
   */
  onBeforeSign?: (notice: SignNotice) => void;
}

export interface SignNotice {
  amountUusdc: bigint;
  authorization: Authorization;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  authorization: Authorization;
  signedMessage: string;
}

interface AskTarget {
  url: string;
  /** The exact resource string the node's 402 template must name. */
  resource: string;
  /** The exact body sent both times (challenge probe and paid call). */
  body: string;
  /** Ids the receipt may name; omitted for an auto-routed ask (network picks the provider). */
  expectMiners?: readonly string[];
}

/**
 * Shared escrow-paid ask flow, per using/escrow-inference.md (Steps 2-4):
 * 1) POST without payment -> 402 challenge; 2) check + sign the escrow
 * template; 3) POST the same body with X-PAYMENT; 4) decode the receipt.
 * Refuses before signing if the quote exceeds one flat call, the daily cap,
 * or the escrow's `available` balance.
 */
async function escrowPaidAsk(target: AskTarget, payer: Payer, opts: AskOptions): Promise<PaidAsk> {
  const f = opts.f ?? fetch;
  const json = { "Content-Type": "application/json" };

  const first = await f(target.url, { method: "POST", headers: json, body: target.body });
  if (first.status !== 402) {
    throw new EscrowRefusal(`expected a 402 challenge, got HTTP ${first.status}: ${(await first.text()).slice(0, 300)}`);
  }
  const challenge = parseEscrowChallenge(await first.json(), target.resource);

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
  opts.onBeforeSign?.({ amountUusdc: challenge.amountUusdc, authorization });
  const signature = await payer.signMessage(signedMessage);
  const payment = encodePayment(challenge.accept.network, signature, authorization);

  const paid = await f(target.url, { method: "POST", headers: { ...json, "X-PAYMENT": payment }, body: target.body });
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
    miners: target.expectMiners,
    amountUusdc: authorization.value,
  });
  return { status: paid.status, body: parsed, receipt, authorization, quotedUusdc: challenge.amountUusdc, signedMessage };
}

/**
 * Direct canonical ask to one miner, paid from escrow. The receipt must name
 * one of `opts.minerIds` (or the called id), binding payment to that miner.
 */
export function escrowAskMiner(
  minerId: string,
  requestBody: Record<string, unknown>,
  payer: Payer,
  opts: AskOptions,
): Promise<PaidAsk> {
  return escrowPaidAsk(
    {
      url: `${ENGINE_URL}/v1/ask/${minerId}`,
      resource: `/v1/ask/${minerId}`,
      body: JSON.stringify(requestBody),
      expectMiners: opts.minerIds ?? [minerId],
    },
    payer,
    opts,
  );
}

export interface AutoAskOptions extends AskOptions {
  /**
   * Bounded spend for the routed call, sent as max_budget_usdc. Defaults to
   * one flat call and may never exceed the Desk per-call cap.
   */
  maxBudgetUusdc?: bigint;
}

/**
 * Auto-routed canonical ask, paid from escrow: POST /engine/v1/ask with no
 * miner id, so the network's ranked routing picks the provider
 * (using/engine-ask.md). The app never picks or hardcodes a miner; the
 * receipt names whichever on-chain registration served it, and the caller
 * records that id as evidence. A max_budget_usdc line bounds the spend and
 * the same Desk per-call/daily/balance refusals apply before anything is signed.
 */
export async function escrowAskAuto(
  requestBody: Record<string, unknown>,
  payer: Payer,
  opts: AutoAskOptions,
): Promise<PaidAsk> {
  const budget = opts.maxBudgetUusdc ?? ONE_CALL_UUSDC;
  if (budget > DESK_MAX_CALL_UUSDC) {
    throw new EscrowRefusal(`max_budget_usdc ${budget} exceeds the Desk per-call cap ${DESK_MAX_CALL_UUSDC}`);
  }
  assertBudget(budget);
  return escrowPaidAsk(
    {
      url: `${ENGINE_URL}/v1/ask`,
      resource: "/v1/ask",
      body: JSON.stringify({ ...requestBody, max_budget_usdc: Number(budget) }),
    },
    payer,
    opts,
  );
}
