// Telegraph escrow rail, per using/escrow-inference.md (Steps 2-4).
// Pure functions only: no network, no key handling. The signer is injected.

import {
  DIAMOND,
  ESCROW_NETWORK,
  MAX_BUDGET_UUSDC,
  MAX_WINDOW_SECONDS,
  MIN_BUDGET_UUSDC,
  VALID_AFTER_SKEW_SECONDS,
  VALID_FOR_SECONDS,
} from "./constants.js";

export interface EscrowAccept {
  scheme: "escrow";
  network: string;
  payTo: string;
  price?: string;
  amount?: string;
  extra: { message: string; resource: string; signWith?: string; description?: string };
}

export interface EscrowChallenge {
  accept: EscrowAccept;
  /** μUSDC read from the template's "Amount:" line (the reliable place, per the docs). */
  amountUusdc: bigint;
  resource: string;
}

export class EscrowRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowRefusal";
  }
}

const PLACEHOLDERS = ["{from}", "{nonce}", "{validAfter}", "{validBefore}"] as const;

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Pick and check the escrow entry of a 402 body. Refuses (throws) unless the
 * entry pays the Sepolia Diamond, names Sepolia in the signed template, is for
 * the resource we called, and carries each placeholder exactly once.
 */
export function parseEscrowChallenge(body: unknown, expectedResource: string): EscrowChallenge {
  const accepts = (body as { accepts?: unknown })?.accepts;
  if (!Array.isArray(accepts)) throw new EscrowRefusal("402 body has no accepts array");
  const entry = accepts.find((a) => (a as { scheme?: unknown })?.scheme === "escrow") as EscrowAccept | undefined;
  if (!entry) throw new EscrowRefusal("this node does not accept escrow");
  if (entry.network !== ESCROW_NETWORK) {
    throw new EscrowRefusal(`escrow network ${String(entry.network)} is not ${ESCROW_NETWORK} (testnet only)`);
  }
  if (typeof entry.payTo !== "string" || entry.payTo.toLowerCase() !== DIAMOND) {
    throw new EscrowRefusal(`escrow payTo ${String(entry.payTo)} is not the Diamond ${DIAMOND}`);
  }
  const message = entry.extra?.message;
  const resource = entry.extra?.resource;
  if (typeof message !== "string" || typeof resource !== "string") {
    throw new EscrowRefusal("escrow entry has no extra.message / extra.resource");
  }
  if (resource !== expectedResource) {
    throw new EscrowRefusal(`escrow resource ${resource} is not ${expectedResource}`);
  }
  for (const p of PLACEHOLDERS) {
    if (count(message, p) !== 1) throw new EscrowRefusal(`template must contain ${p} exactly once`);
  }
  const lines = message.split("\n");
  const want = [
    `Pay To: ${DIAMOND}`,
    `Network: ${ESCROW_NETWORK}`,
    `Resource: ${expectedResource}`,
  ];
  for (const w of want) {
    if (!lines.some((l) => l.toLowerCase() === w.toLowerCase())) {
      throw new EscrowRefusal(`template is missing the line "${w}"`);
    }
  }
  const amountLines = lines.filter((l) => /^Amount:/.test(l));
  const m = amountLines.length === 1 ? /^Amount:\s*(\d+)\s*uUSDC$/.exec(amountLines[0]) : null;
  if (!m) throw new EscrowRefusal("template has no single 'Amount: N uUSDC' line");
  const amountUusdc = BigInt(m[1]);
  if (amountUusdc <= 0n) throw new EscrowRefusal("quoted amount must be positive");
  return { accept: entry, amountUusdc, resource };
}

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** Build the authorization the signature commits to. `from` is lowercased (docs: "Lowercase your address"). */
export function buildAuthorization(
  challenge: EscrowChallenge,
  from: string,
  nowSeconds: number,
  nonce: string,
): Authorization {
  if (!/^0x[0-9a-fA-F]{40}$/.test(from)) throw new EscrowRefusal("from is not an address");
  if (!nonce || /[\n\r]/.test(nonce)) throw new EscrowRefusal("nonce must be a non-empty single-line string");
  const validAfter = nowSeconds - VALID_AFTER_SKEW_SECONDS;
  const validBefore = nowSeconds + VALID_FOR_SECONDS;
  if (validBefore - validAfter > MAX_WINDOW_SECONDS) throw new EscrowRefusal("validity window exceeds 2 minutes");
  return {
    from: from.toLowerCase(),
    to: challenge.accept.payTo,
    value: challenge.amountUusdc.toString(),
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };
}

/** Fill the template in place; never rebuild it ("Sign the template as given"). */
export function fillTemplate(template: string, auth: Authorization): string {
  return template
    .replace("{from}", auth.from)
    .replace("{nonce}", auth.nonce)
    .replace("{validAfter}", auth.validAfter)
    .replace("{validBefore}", auth.validBefore);
}

export interface PaymentEnvelope {
  x402Version: 2;
  scheme: "escrow";
  network: string;
  payload: { signature: string; authorization: Authorization };
}

/** Base64 JSON for the X-PAYMENT header (not PAYMENT-SIGNATURE, which is the exact rail's). */
export function encodePayment(network: string, signature: string, authorization: Authorization): string {
  const env: PaymentEnvelope = { x402Version: 2, scheme: "escrow", network, payload: { signature, authorization } };
  return Buffer.from(JSON.stringify(env), "utf8").toString("base64");
}

export interface TelegraphReceipt {
  receipt_hash: string;
  rail: string;
  payer: string;
  miner: string;
  intent: string;
  amount_uusdc: string;
  epoch_id: number;
  settlement: string;
  chain: string;
  timestamp: number;
}

/**
 * Decode X-PAYMENT-RESPONSE and check it describes this payment: escrow rail,
 * our payer, the miner we called (any of its ids), the exact amount we signed, epoch settlement.
 */
export function decodeReceipt(
  header: string | null,
  expect: { payer: string; miners: readonly string[]; amountUusdc: string },
): TelegraphReceipt {
  if (!header) throw new EscrowRefusal("served response carries no X-PAYMENT-RESPONSE header");
  let r: TelegraphReceipt;
  try {
    r = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as TelegraphReceipt;
  } catch {
    throw new EscrowRefusal("X-PAYMENT-RESPONSE is not base64 JSON");
  }
  const problems: string[] = [];
  if (!/^0x[0-9a-f]{64}$/.test(String(r.receipt_hash))) problems.push("receipt_hash");
  if (r.rail !== "escrow") problems.push(`rail=${r.rail}`);
  if (String(r.payer).toLowerCase() !== expect.payer.toLowerCase()) problems.push(`payer=${r.payer}`);
  // The live node names the miner by its on-chain registration id (6152)
  // in the receipt, while the engine route takes the catalogue id (774921);
  // the caller passes every id that denotes the miner it paid.
  if (!expect.miners.includes(String(r.miner))) problems.push(`miner=${r.miner}`);
  if (String(r.amount_uusdc) !== expect.amountUusdc) problems.push(`amount_uusdc=${r.amount_uusdc}`);
  if (!Number.isInteger(r.epoch_id)) problems.push("epoch_id");
  if (r.settlement !== "epoch") problems.push(`settlement=${r.settlement}`);
  if (r.chain !== "telegraph") problems.push(`chain=${r.chain}`);
  if (problems.length) throw new EscrowRefusal(`receipt does not match the payment: ${problems.join(", ")}`);
  return r;
}

/** max_budget_usdc must be one call (10000) to 260000 μUSDC on the testnet node. */
export function assertBudget(budget: bigint): void {
  if (budget < MIN_BUDGET_UUSDC || budget > MAX_BUDGET_UUSDC) {
    throw new EscrowRefusal(`max_budget_usdc ${budget} is outside ${MIN_BUDGET_UUSDC}..${MAX_BUDGET_UUSDC}`);
  }
}
