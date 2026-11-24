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
// Unreadable chains remain explicit unknowns. consistent=false with
// complete=false means consistency was not established, not a proven mismatch.
import { ApiError, badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { receiptQuorum } from "../core/receiptQuorum";
import { CHAIN_RPCS } from "../config/chains";

const RPC_TIMEOUT_MS = 12000;
const UA = "VeriReceipt/2.0 cross-chain-state observer (+https://verireceipt.vercel.app)";

export const INTENT = "CROSS_CHAIN_STATE_VERIFY_GENERAL";

async function rpcCall(url: string, method: string, params: unknown[], timeoutMs=RPC_TIMEOUT_MS): Promise<{ body: string; result: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const parsed=JSON.parse(body);
    if(parsed.error || !Object.prototype.hasOwnProperty.call(parsed,'result'))throw new Error('invalid RPC response');
    return { body, result: parsed.result };
  } finally {
    clearTimeout(timer);
  }
}

export interface ChainState { chain: string; found: boolean | null; status: number | null; bodies: Record<string, string>; code?:string; code_present?:boolean; error?:string }

/** Terminal state of a tx hash on one chain via 2-of-N receipt quorum. */
export async function chainState(chain: string, rpcs: string[], txHash: string): Promise<ChainState> {
  const best=await receiptQuorum(rpcs,txHash,url=>rpcCall(url,"eth_getTransactionReceipt",[txHash],4000));
  if(best.result===null)return {chain,found:false,status:null,bodies:Object.fromEntries(Object.entries(best.bodies).map(([k,v])=>[chain+":"+k,v]))};
  // txLookup's effectiveStatus doctrine: a pre-Byzantium receipt carries
  // `root` instead of `status` and means success; neither field means
  // failure. Never default a missing status to success.
  const r = best.result as Record<string, unknown>;
  const status = typeof r.status === "string" ? (BigInt(r.status) === 0n ? 0 : 1) : typeof r.root === "string" ? 1 : 0;
  return { chain, found: true, status, bodies: Object.fromEntries(Object.entries(best.bodies).map(([k,v])=>[chain+":"+k,v])) };
}

/** Exact runtime-code comparison only; not balance, nonce, ownership or bridge state. */
export async function addressState(chain:string,rpcs:string[],address:string):Promise<ChainState> {
 const settled=await Promise.allSettled(rpcs.map(url=>rpcCall(url,'eth_getCode',[address,'latest'])));
 const groups=new Map<string,{n:number;bodies:Record<string,string>}>();
 settled.forEach((r,i)=>{if(r.status!=='fulfilled'||typeof r.value.result!=='string'||!/^0x(?:[0-9a-f]{2})*$/i.test(r.value.result))return;
  const code=r.value.result.toLowerCase();const g=groups.get(code)??{n:0,bodies:{}};g.n++;g.bodies[chain+'-leg'+i]=r.value.body;groups.set(code,g);
 });
 const best=[...groups.entries()].sort((a,b)=>b[1].n-a[1].n)[0];
 if(!best||best[1].n<2)throw upstreamUnavailable('RPC_CODE_QUORUM_UNREACHABLE',chain+' runtime code has no exact two-source agreement');
 return {chain,found:null,code_present:best[0]!=='0x',status:null,code:best[0],bodies:best[1].bodies};
}

export async function handleCrossChainState(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const reference = query.reference?.trim().toLowerCase();
  if (!reference) throw badRequest("MISSING_PARAM", "reference is required as a tx hash (0x + 64 hex)");
  if (!/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(reference)) throw badRequest('INVALID_REFERENCE','reference must be a 0x-prefixed EVM address or transaction hash');
  const mode=reference.length===42?'address-runtime-code':'transaction-receipt-status';
  const chainsRaw = query.chains?.trim();
  if (!chainsRaw) throw badRequest("MISSING_PARAM", `chains is required as a comma-separated list of at least two of: ${Object.keys(CHAIN_RPCS).join(", ")}`);
  const chains = [...new Set(chainsRaw.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean))];
  if (chains.length < 2) throw badRequest("TOO_FEW_CHAINS", "at least two distinct chains are required for a cross-chain check");
  for (const c of chains) {
    if (!CHAIN_RPCS[c]) throw badRequest("UNSUPPORTED_CHAIN", `chain "${c}" is not configured; supported: ${Object.keys(CHAIN_RPCS).join(", ")}`);
  }
  const fetchedAt = new Date().toISOString();
  const states: ChainState[] = [];
  const reads=await Promise.all(chains.map(async c=>{
    try{return mode==='address-runtime-code'?await addressState(c,CHAIN_RPCS[c],reference):await chainState(c,CHAIN_RPCS[c],reference);}
    catch(error){
      const raw=error instanceof ApiError&&'receiptEvidence' in error?(error as ApiError&{receiptEvidence:unknown}).receiptEvidence:null;
      const bodies=raw&&typeof raw==='object'?Object.fromEntries(Object.entries(raw).filter((entry):entry is [string,string]=>typeof entry[1]==='string').map(([k,v])=>[c+':'+k,v])):{};
      return {chain:c,found:null,status:null,bodies,error:error instanceof ApiError?error.code:'RPC_UNREADABLE'} as ChainState;
    }
  }));
  states.push(...reads);
  const first = states[0];
  const complete=states.every(s=>!s.error);
  const consistent = complete && states.every((s) => s.found === first.found && s.status === first.status && s.code===first.code);
  const asOf = new Date().toISOString();
  const statusDesc = (s: ChainState) => s.error?'unreadable ('+s.error+')':mode==='address-runtime-code'?(s.code==='0x'?'empty runtime code (not proof of account absence)':'nonempty runtime code, '+((s.code!.length-2)/2)+' bytes'):s.found ? `present, status ${s.status === 1 ? "success" : "reverted"}` : "absent";
  const evidence = JSON.stringify({ reference, chains, mode, complete, as_of: asOf,
    narrowing: "consistent means only that the reference resolves to the same terminal state on every listed chain, each checked independently via its own 2-of-N RPC quorum; bridge-transfer completion is NOT verified or claimed",
    address_scope:'Address mode compares exact runtime code at independent latest snapshots only, not ownership, balances, nonce, token identity or bridge state; no synchronized-height guarantee. Empty code is not account absence.',
    per_chain: states.map(({bodies,...state}) => state),
    receipt_quorum_policy:"null/found split retried once after1100ms; at least two matching present providers, scored-content conflict refused; all attempts retained",consistent, raw_bodies: Object.assign({}, ...states.map((s) => s.bodies)), fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, "per-chain 2-of-N RPC quorums", evidence, "independent per-chain RPC quorums; narrowing disclosed");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const perChain = states.map((s) => `${s.chain}: ${statusDesc(s)}`).join("; ");
  const baseSummary = consistent
    ? `CONSISTENT: ${reference.slice(0, 10)}… resolves to the same terminal state on ${chains.join(", ")} (${perChain}). ` +
      `This means only that every listed chain independently reports the same state; it does NOT verify any bridge transfer between them.`
    : `NOT consistent: ${reference.slice(0, 10)}… differs across chains (${perChain}). ` +
      `Each chain was checked independently via its own RPC quorum; this says nothing about why the states differ and does NOT verify or refute a bridge transfer.`;
  const summary=!complete?`Consistency NOT established: unreadable chain(s) (${perChain}). consistent=false means incomplete evidence, not a proven state mismatch. No bridge transfer is verified or refuted.`:mode==='address-runtime-code'?`${consistent?'CONSISTENT':'NOT consistent'} runtime-code snapshots: ${perChain}. Exact runtime code only, independent latest heights; not balance, nonce, ownership or bridge verification. Empty code does not mean account absence.`:baseSummary;
  return envelope(INTENT, {
    consistent,
    complete,
    reference_type:mode,
    per_chain:states.map(({bodies,...state})=>state),
    address: reference,
    status: states.map((s) => `${s.chain}: ${statusDesc(s)}`).join("; "),
    chains,
    summary,
  }, receipt, { answer: summary, verdict: complete?"verified":"unverified", confidence: complete?0.9:0,
    source: `per-chain 2-of-N RPC quorums over ${chains.join(", ")}; fetched ${fetchedAt}` });
}
