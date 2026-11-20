// VeriReceipt Desk — Telegraph client (telegraphClient.ts).
//
// Ranked POST /engine/v1/ask with X-PAYMENT Escrow (EIP-191 personal_sign)
// as the PRIMARY rail; x402 facilitator fallback behind pLimit(1).
// The facilitator has open timeouts (bounties #214/#215), so escrow is
// tried first on every call and x402 is only a fallback — never the
// first rail. Ranked path ONLY: /engine/v1/ask, never /ask/<minerId> for
// primary runs, so the router legitimately routes across top miners.
//
// Escrow flow (per https://anjoman.ai/docs/using/escrow-inference):
//   1. POST the ask with no payment -> 402 challenge listing `accepts`.
//   2. Take the entry with scheme "escrow"; fill its extra.message
//      template IN PLACE ({from} lowercase, {nonce} fresh, {validAfter},
//      {validBefore} — window <= 2 min) and sign it verbatim with
//      personal_sign. Do NOT rebuild the message.
//   3. Re-POST the same body with X-PAYMENT: base64 JSON
//      {x402Version: 2, scheme: "escrow", network: "eip155:11155111",
//       payload: {signature, authorization}}.
//   4. Read the receipt from the X-PAYMENT-RESPONSE header (base64 JSON).
//      A budgeted ask bills one row per paid call; fulfillment.payments
//      lists every row. There is no tx_hash on escrow — by design.
//   5. Verify at GET /engine/v1/signal/<signal_hash>:
//      verification.verified === true.
//
// Money facts (testnet ONLY — Ethereum Sepolia, Test USDC, zero real money):
//   Diamond (active): 0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b
//   Test USDC:        0xcc194e1a843B658526D0D5C431f670028582Ae17
//   max_budget_usdc:  260000 (the node's documented maximum; 300000 -> 400)

import { randomUUID } from "crypto";
import pLimit from "p-limit";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Account,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export type { Hex } from "viem";

export const TELEGRAPH_NODE_URL =
  process.env.TELEGRAPH_NODE_URL || "https://devnode.telegraphprotocol.com";
export const TELEGRAPH_DIAMOND =
  "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b" as const;
export const TELEGRAPH_TEST_USDC =
  "0xcc194e1a843B658526D0D5C431f670028582Ae17" as const;
export const TELEGRAPH_NETWORK = "eip155:11155111";
export const MAX_BUDGET_USDC = 260000;
export const ASK_DEADLINE_MS = 45000;

const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

// Sepolia public RPCs answer slowly from this VM (often >10 s); viem's
// default 10 s timeout would fail nearly every call. 60 s + 2 retries.
function sepoliaTransport() {
  return http(SEPOLIA_RPC_URL, { timeout: 60_000, retryCount: 2, retryDelay: 1_000 });
}

const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const DIAMOND_LEDGER_ABI = parseAbi([
  "function depositUSDC(uint256 amount)",
  "function depositUSDCFor(address beneficiary, uint256 amount)",
  "function ledgerAccount(address account) view returns (uint256 deposited, uint256 withdrawn, uint256 requested, uint256 requestedAt)",
]);

/** Accept a 64-hex-char key with or without the 0x prefix. */
export function normalizePrivateKey(key: string): Hex {
  const trimmed = key.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
}

export class TelegraphError extends Error {
  status?: number;
  reason?: string;
  constructor(message: string, status?: number, reason?: string) {
    super(message);
    this.name = "TelegraphError";
    this.status = status;
    this.reason = reason;
  }
}

export interface AskPaymentRow {
  miner: string;
  intent: string;
  amount_uusdc: number;
  receipt_hash: string;
}

export interface AskReceipt {
  receipt_hash: string;
  rail: string;
  payer?: string;
  miner?: string;
  intent?: string;
  amount_uusdc?: string | number;
  epoch_id?: number;
  settlement?: string;
  chain?: string;
  timestamp?: number;
}

export interface AskResult {
  intent: string;
  params: Record<string, unknown>;
  /** The node's answer body (result or result_data, whichever it sent). */
  result: Record<string, unknown>;
  /** The node's echoed validated input (params as it ran them). */
  input?: Record<string, unknown>;
  result_shape?: string;
  miner_id?: string;
  miner_name?: string;
  signal_hash?: string;
  cost_usd?: number;
  duration_ms?: number;
  fulfillment?: Record<string, unknown>;
  payments: AskPaymentRow[];
  receipt: AskReceipt | null;
  rail: "escrow" | "x402";
  fetched_at: string;
}

export interface TelegraphClientOptions {
  privateKey?: Hex;
  nodeUrl?: string;
  fetchImpl?: typeof fetch;
}

interface EscrowAccept {
  scheme: string;
  network: string;
  payTo: string;
  price?: string;
  extra?: { message?: string };
}

function decodePaymentResponse(header: string | null): AskReceipt | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as AskReceipt;
  } catch {
    return null;
  }
}

function readPayments(body: Record<string, unknown>): AskPaymentRow[] {
  const fulfillment = body.fulfillment as
    | { payments?: Array<Record<string, unknown>> }
    | undefined;
  const rows = fulfillment?.payments ?? [];
  return rows.map((p) => ({
    miner: String(p.miner ?? ""),
    intent: String(p.intent ?? ""),
    amount_uusdc: Number(p.amount_uusdc ?? 0),
    receipt_hash: String(p.receipt_hash ?? ""),
  }));
}

function readResult(body: Record<string, unknown>): Record<string, unknown> {
  const result = body.result ?? body.result_data;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return {};
}

/** Serialize the X-PAYMENT escrow envelope exactly as the docs specify. */
export function buildEscrowPayment(
  signature: Hex,
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  },
  network: string = TELEGRAPH_NETWORK,
): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: "escrow",
      network,
      payload: { signature, authorization },
    }),
    "utf8",
  ).toString("base64");
}

/**
 * Fill the node's escrow message template in place. The template is
 * signed verbatim — never rebuilt. {from} is substituted lowercase.
 */
export function fillEscrowTemplate(
  template: string,
  authorization: { from: string; nonce: string; validAfter: string; validBefore: string },
): string {
  return template
    .replace("{from}", authorization.from)
    .replace("{nonce}", authorization.nonce)
    .replace("{validAfter}", authorization.validAfter)
    .replace("{validBefore}", authorization.validBefore);
}

export class TelegraphClient {
  private readonly nodeUrl: string;
  private readonly account: Account | null;
  private readonly fetchImpl: typeof fetch;
  /** pLimit(1): serialises the x402 fallback so bare-402 nonces never collide. */
  private readonly x402Limit = pLimit(1);

  constructor(opts: TelegraphClientOptions = {}) {
    this.nodeUrl = (opts.nodeUrl ?? TELEGRAPH_NODE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.account = opts.privateKey ? privateKeyToAccount(normalizePrivateKey(opts.privateKey)) : null;
  }

  get address(): string | null {
    return this.account ? this.account.address : null;
  }

  private async postAsk(
    body: Record<string, unknown>,
    paymentHeader?: string,
  ): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (paymentHeader) headers["X-PAYMENT"] = paymentHeader;
    const res = await this.fetchImpl(`${this.nodeUrl}/engine/v1/ask`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json, headers: res.headers };
  }

  /**
   * Ranked ask via escrow (primary). Throws TelegraphError on any refusal;
   * a fresh nonce is minted per attempt and never reused.
   */
  async askRanked(
    intent: string,
    params: Record<string, unknown>,
    opts: { maxBudgetUsdc?: number; deadlineMs?: number } = {},
  ): Promise<AskResult> {
    if (!this.account) {
      throw new TelegraphError(
        "TelegraphClient has no payer key configured (DESK_PAYER_PRIVATE_KEY); cannot sign an escrow authorization",
      );
    }
    const account = this.account;
    const body: Record<string, unknown> = {
      intent,
      params,
      max_budget_usdc: opts.maxBudgetUsdc ?? MAX_BUDGET_USDC,
      deadline_ms: opts.deadlineMs ?? ASK_DEADLINE_MS,
    };

    // 1. Challenge: POST with no payment header.
    const challenge = await this.postAsk(body);
    if (challenge.status !== 402) {
      if (challenge.status >= 200 && challenge.status < 300) {
        // Unpaid 200 (should not happen on a priced route): accept it
        // only if it carries a result; it cost nothing.
        return this.toAskResult(intent, params, challenge.json, null, "escrow");
      }
      throw new TelegraphError(
        `ask challenge failed: HTTP ${challenge.status}: ${JSON.stringify(challenge.json).slice(0, 500)}`,
        challenge.status,
      );
    }
    const accepts = (challenge.json.accepts ?? []) as EscrowAccept[];
    const escrow = accepts.find((a) => a.scheme === "escrow");
    if (!escrow) {
      // No escrow offered — fall back to x402 (serialised, once).
      return this.askViaX402(intent, params, body);
    }
    const template = escrow.extra?.message;
    if (!template) {
      throw new TelegraphError("escrow challenge carries no extra.message template to sign");
    }
    const amountMatch = /Amount:\s*(\d+)\s*uUSDC/.exec(template);
    if (!amountMatch) {
      throw new TelegraphError("escrow challenge template carries no Amount: <n> uUSDC line");
    }
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: account.address.toLowerCase(),
      to: escrow.payTo,
      value: amountMatch[1],
      validAfter: String(now - 5),
      validBefore: String(now + 100), // window must stay under 2 minutes
      nonce: randomUUID(),
    };
    const message = fillEscrowTemplate(template, authorization);
    const signMessage = account.signMessage;
    if (!signMessage) {
      throw new TelegraphError("payer account cannot personal_sign (no signMessage)");
    }
    const signature = await signMessage({ message });

    // 2. Same body, now carrying the authorization in X-PAYMENT.
    const payment = buildEscrowPayment(signature, authorization, escrow.network);
    const paid = await this.postAsk(body, payment);
    if (paid.status === 402) {
      const reason =
        typeof paid.json.reason === "string"
          ? paid.json.reason
          : JSON.stringify(paid.json).slice(0, 500);
      throw new TelegraphError(`escrow payment refused (402): ${reason}`, 402, reason);
    }
    if (paid.status < 200 || paid.status >= 300) {
      throw new TelegraphError(
        `ask failed: HTTP ${paid.status}: ${JSON.stringify(paid.json).slice(0, 500)}`,
        paid.status,
      );
    }
    const receipt = decodePaymentResponse(paid.headers.get("X-PAYMENT-RESPONSE"));
    return this.toAskResult(intent, params, paid.json, receipt, "escrow");
  }

  /**
   * x402 fallback (serialised via pLimit(1)). Only ever called when the
   * node offers no escrow scheme. Uses @x402/fetch + @x402/evm when
   * installed; otherwise throws an honest "fallback unavailable" error
   * rather than faking a payment.
   */
  async askViaX402(
    intent: string,
    params: Record<string, unknown>,
    body: Record<string, unknown>,
  ): Promise<AskResult> {
    if (!this.account) {
      throw new TelegraphError("x402 fallback needs a payer key (DESK_PAYER_PRIVATE_KEY)");
    }
    return this.x402Limit(async () => {
      let wrapFetchWithPaymentFromConfig: (
        fetchImpl: typeof fetch,
        config: Record<string, unknown>,
      ) => typeof fetch;
      let ExactEvmScheme: new (account: Account) => unknown;
      try {
        const x402Fetch = (await import("@x402/fetch")) as Record<string, unknown>;
        const x402Evm = (await import("@x402/evm")) as Record<string, unknown>;
        wrapFetchWithPaymentFromConfig = x402Fetch.wrapFetchWithPaymentFromConfig as typeof wrapFetchWithPaymentFromConfig;
        ExactEvmScheme = x402Evm.ExactEvmScheme as typeof ExactEvmScheme;
      } catch {
        throw new TelegraphError(
          "x402 fallback unavailable: @x402/fetch + @x402/evm are not installed, and the node offered no escrow scheme for this ask",
        );
      }
      const paidFetch = wrapFetchWithPaymentFromConfig(this.fetchImpl, {
        schemes: [
          { network: TELEGRAPH_NETWORK, client: new ExactEvmScheme(this.account as Account) },
        ],
        spendControls: {
          allowedAssets: [
            {
              network: TELEGRAPH_NETWORK,
              asset: TELEGRAPH_TEST_USDC,
              maxAmountPerPayment: String(MAX_BUDGET_USDC),
            },
          ],
        },
      });
      const res = await paidFetch(`${this.nodeUrl}/engine/v1/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (res.status < 200 || res.status >= 300) {
        throw new TelegraphError(
          `x402 ask failed: HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`,
          res.status,
        );
      }
      const receipt = decodePaymentResponse(res.headers.get("X-TELEGRAPH-RECEIPT"));
      return this.toAskResult(intent, params, json, receipt, "x402");
    });
  }

  private toAskResult(
    intent: string,
    params: Record<string, unknown>,
    body: Record<string, unknown>,
    receipt: AskReceipt | null,
    rail: "escrow" | "x402",
  ): AskResult {
    const payments = readPayments(body);
    return {
      intent,
      params,
      result: readResult(body),
      input:
        body.input && typeof body.input === "object" && !Array.isArray(body.input)
          ? (body.input as Record<string, unknown>)
          : undefined,
      result_shape: typeof body.result_shape === "string" ? body.result_shape : undefined,
      miner_id: body.miner_id !== undefined ? String(body.miner_id) : undefined,
      miner_name: typeof body.miner_name === "string" ? body.miner_name : undefined,
      signal_hash: typeof body.signal_hash === "string" ? body.signal_hash : undefined,
      cost_usd: typeof body.cost_usd === "number" ? body.cost_usd : undefined,
      duration_ms: typeof body.duration_ms === "number" ? body.duration_ms : undefined,
      fulfillment:
        body.fulfillment && typeof body.fulfillment === "object"
          ? (body.fulfillment as Record<string, unknown>)
          : undefined,
      payments,
      receipt,
      rail,
      fetched_at: new Date().toISOString(),
    };
  }

  /** Verify a signal_hash against the node. verified === true is the pass. */
  async verifySignal(signalHash: string): Promise<{
    verified: boolean;
    body: Record<string, unknown>;
  }> {
    const res = await this.fetchImpl(
      `${this.nodeUrl}/engine/v1/signal/${encodeURIComponent(signalHash)}`,
    );
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (res.status < 200 || res.status >= 300) {
      return { verified: false, body: { ...body, http_status: res.status } };
    }
    const verification = body.verification as { verified?: unknown } | undefined;
    return { verified: verification?.verified === true, body };
  }

  /** Node-side ledger view for an address (deposited/charged/balance/available). */
  async getLedgerAccount(address: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(
      `${this.nodeUrl}/v1/ledger/account/${encodeURIComponent(address)}`,
    );
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return { error: `ledger lookup failed: HTTP ${res.status}` };
    }
  }
}

// ---------------------------------------------------------------------------
// On-chain helpers (Sepolia testnet only). The payer key never leaves the
// process: these functions take it as an argument and never log it.
// ---------------------------------------------------------------------------

export function payerAccountFromKey(privateKey: Hex): Account {
  return privateKeyToAccount(normalizePrivateKey(privateKey));
}

export function sepoliaPublicClient() {
  return createPublicClient({ chain: sepolia, transport: sepoliaTransport() });
}

export interface PayerBalances {
  address: string;
  eth_wei: bigint;
  eth: string;
  test_usdc_uusdc: bigint;
  test_usdc: string;
  escrow_deposited_uusdc: bigint;
  escrow_withdrawn_uusdc: bigint;
  escrow_requested_uusdc: bigint;
  escrow_requested_at: bigint;
}

export async function getPayerBalances(address: string): Promise<PayerBalances> {
  const client = sepoliaPublicClient();
  const [ethWei, usdc, ledger] = await Promise.all([
    client.getBalance({ address: address as Hex }),
    client.readContract({
      address: TELEGRAPH_TEST_USDC,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [address as Hex],
    }),
    client.readContract({
      address: TELEGRAPH_DIAMOND,
      abi: DIAMOND_LEDGER_ABI,
      functionName: "ledgerAccount",
      args: [address as Hex],
    }),
  ]);
  return {
    address,
    eth_wei: ethWei,
    eth: (Number(ethWei) / 1e18).toFixed(6),
    test_usdc_uusdc: usdc,
    test_usdc: (Number(usdc) / 1e6).toFixed(2),
    escrow_deposited_uusdc: ledger[0],
    escrow_withdrawn_uusdc: ledger[1],
    escrow_requested_uusdc: ledger[2],
    escrow_requested_at: ledger[3],
  };
}

/** Mint Test USDC to the payer (the test token is mintable by anyone). */
export async function mintTestUsdc(
  privateKey: Hex,
  to: string,
  amountUusdc: bigint,
): Promise<Hex> {
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const wallet = createWalletClient({
    account,
    chain: sepolia,
    transport: sepoliaTransport(),
  });
  return wallet.writeContract({
    address: TELEGRAPH_TEST_USDC,
    abi: USDC_ABI,
    functionName: "mint",
    args: [to as Hex, amountUusdc],
  });
}

/**
 * Approve the Diamond and deposit Test USDC into escrow.
 * Returns the two transaction hashes. Never logs the key.
 */
export async function depositEscrow(
  privateKey: Hex,
  amountUusdc: bigint,
): Promise<{ approveTx: Hex; depositTx: Hex }> {
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const wallet = createWalletClient({
    account,
    chain: sepolia,
    transport: sepoliaTransport(),
  });
  const publicClient = sepoliaPublicClient();
  const allowance = (await publicClient.readContract({
    address: TELEGRAPH_TEST_USDC,
    abi: USDC_ABI,
    functionName: "allowance",
    args: [account.address, TELEGRAPH_DIAMOND],
  })) as bigint;
  let approveTx: Hex | null = null;
  if (allowance < amountUusdc) {
    approveTx = await wallet.writeContract({
      address: TELEGRAPH_TEST_USDC,
      abi: USDC_ABI,
      functionName: "approve",
      args: [TELEGRAPH_DIAMOND, amountUusdc],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }
  const depositTx = await wallet.writeContract({
    address: TELEGRAPH_DIAMOND,
    abi: DIAMOND_LEDGER_ABI,
    functionName: "depositUSDC",
    args: [amountUusdc],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  // approveTx is null only when a sufficient allowance already existed.
  return { approveTx: approveTx ?? ("0x" + "0".repeat(64) as Hex), depositTx };
}
