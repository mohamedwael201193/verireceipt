// CROSS_CHAIN_STATE_VERIFY_GENERAL — GET /v1/cross-chain-state?reference=<0x…>&chains=<a,b>
//
// Zero-LLM. Resolves a transaction hash INDEPENDENTLY on each listed
// chain through the 2-of-N RPC quorum (txLookup doctrine) and reports
// whether the terminal state agrees across all of them. SHA-256
// receipt over the exact upstream bodies.
//
// Intent contract (read 2026-11-23): request reference (string),
// chains (string); scored consistent (bool); off-chain address,
// status, chains, summary.
//
// NARROWING (maintainer ruling 2026-11-23, disclosed in every answer
// and receipt): "consistent" means ONLY that the reference resolves to
// the same terminal state (present with the same receipt status, or
// uniformly absent) on every listed chain, each checked independently
// through its own RPC quorum. It does NOT verify a bridge transfer:
// funds moving between chains is a different question and is not
// claimed here.
//
// Fail closed: any chain whose quorum cannot answer (outage or
// disagreement) is a typed 502 — a partial read never produces a
// consistency claim.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { CHAIN_RPCS } from "../config/chains";

const RPC_TIMEOUT_MS = 12000;
const UA = "VeriReceipt/2.0 cross-chain-state observer (+https://verireceipt.vercel.app)";

export const INTENT = "CROSS_CHAIN_STATE_VERIFY_GENERAL";

async function rpcCall(url: string, method: string, params: unknown[]): Promise<{ body: string; result: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    return { body, result: (JSON.parse(body) as { result?: unknown }).result ?? null };
  } finally {
    clearTimeout(timer);
  }
}

export interface ChainState { chain: string; found: boolean; status: number | null; bodies: Record<string, string> }

/** Terminal state of a tx hash on one chain via 2-of-N receipt quorum. */
export async function chainState(chain: string, rpcs: string[], txHash: string): Promise<ChainState> {
  const settled = await Promise.allSettled(rpcs.map((url) => rpcCall(url, "eth_getTransactionReceipt", [txHash])));
  const ok = settled.filter((s): s is PromiseFulfilledResult<{ body: string; result: unknown }> => s.status === "fulfilled").map((s) => s.value);
  if (ok.length < 2) {
    throw upstreamUnavailable("RPC_QUORUM_UNREACHABLE", `fewer than two ${chain} RPC legs answered (${ok.length}/${rpcs.length}); no consistency claim from a partial read`);
  }
  const groups = new Map<string, { result: unknown; bodies: Record<string, string>; n: number }>();
  ok.forEach((r, i) => {
    const key = JSON.stringify(r.result);
    const g = groups.get(key) ?? { result: r.result, bodies: {}, n: 0 };
    g.bodies[`${chain}-leg${i}`] = r.body;
    g.n += 1;
    groups.set(key, g);
  });
  const best = [...groups.values()].sort((a, b) => b.n - a.n)[0];
  if (best.n < 2) {
    throw upstreamUnavailable("RPC_QUORUM_DISAGREEMENT", `the ${chain} RPC legs disagree on the receipt; no consistency claim from a split read`);
  }
  if (best.result === null) return { chain, found: false, status: null, bodies: best.bodies };
  // txLookup's effectiveStatus doctrine: a pre-Byzantium receipt carries
  // `root` instead of `status` and means success; neither field means
  // failure. Never default a missing status to success.
  const r = best.result as Record<string, unknown>;
  const status = typeof r.status === "string" ? (r.status === "0x0" ? 0 : 1) : typeof r.root === "string" ? 1 : 0;
  return { chain, found: true, status, bodies: best.bodies };
}

export async function handleCrossChainState(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const reference = query.reference?.trim().toLowerCase();
  if (!reference) throw badRequest("MISSING_PARAM", "reference is required as a tx hash (0x + 64 hex)");
  if (!/^0x[0-9a-f]{64}$/.test(reference)) throw badRequest("INVALID_REFERENCE", "reference must be a tx hash: 0x followed by 64 hex characters");
  const chainsRaw = query.chains?.trim();
  if (!chainsRaw) throw badRequest("MISSING_PARAM", `chains is required as a comma-separated list of at least two of: ${Object.keys(CHAIN_RPCS).join(", ")}`);
  const chains = [...new Set(chainsRaw.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean))];
  if (chains.length < 2) throw badRequest("TOO_FEW_CHAINS", "at least two distinct chains are required for a cross-chain check");
  for (const c of chains) {
    if (!CHAIN_RPCS[c]) throw badRequest("UNSUPPORTED_CHAIN", `chain "${c}" is not configured; supported: ${Object.keys(CHAIN_RPCS).join(", ")}`);
  }
  const fetchedAt = new Date().toISOString();
  const states: ChainState[] = [];
  for (const c of chains) states.push(await chainState(c, CHAIN_RPCS[c], reference));
  const first = states[0];
  const consistent = states.every((s) => s.found === first.found && s.status === first.status);
  const asOf = new Date().toISOString();
  const statusDesc = (s: ChainState) => s.found ? `present, status ${s.status === 1 ? "success" : "reverted"}` : "absent";
  const evidence = JSON.stringify({ reference, chains, as_of: asOf,
    narrowing: "consistent means only that the reference resolves to the same terminal state on every listed chain, each checked independently via its own 2-of-N RPC quorum; bridge-transfer completion is NOT verified or claimed",
    per_chain: states.map((s) => ({ chain: s.chain, found: s.found, status: s.status })),
    consistent, raw_bodies: Object.assign({}, ...states.map((s) => s.bodies)), fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, "per-chain 2-of-N RPC quorums", evidence, "independent per-chain RPC quorums; narrowing disclosed");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const perChain = states.map((s) => `${s.chain}: ${statusDesc(s)}`).join("; ");
  const summary = consistent
    ? `CONSISTENT: ${reference.slice(0, 10)}… resolves to the same terminal state on ${chains.join(", ")} (${perChain}). ` +
      `This means only that every listed chain independently reports the same state; it does NOT verify any bridge transfer between them.`
    : `NOT consistent: ${reference.slice(0, 10)}… differs across chains (${perChain}). ` +
      `Each chain was checked independently via its own RPC quorum; this says nothing about why the states differ and does NOT verify or refute a bridge transfer.`;
  return envelope(INTENT, {
    consistent,
    address: reference,
    status: states.map((s) => `${s.chain}: ${statusDesc(s)}`).join("; "),
    chains,
    summary,
  }, receipt, { answer: summary, verdict: "verified", confidence: 0.9,
    source: `per-chain 2-of-N RPC quorums over ${chains.join(", ")}; fetched ${fetchedAt}` });
}
