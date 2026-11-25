import {markFailure,failureKind,combineFailures,metricUpstream,type FailureClass} from '../core/upstreamFailureDiagnostics';
import {answerDiagnostics,withAnswerClass} from "../core/answerClass";
import { badRequest, upstreamUnavailable } from '../core/errors';
import { envelope, makeReceipt } from '../core/receipt';
import { saveReceipt } from '../core/storage';
import { CHAIN_RPCS } from '../config/chains';
import { normalizeChain } from './txLookup';
import { ADDRESS_RE } from './tokenContracts';
import {queryFallback} from '../core/queryFallback';
/** Exact native-unit text for presentation only; canonical numeric Gwei is unchanged. */
export function metricNativeText(wei: bigint): string {
    const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    return `${wei / 10n ** 18n}${fraction ? '.' + fraction : ''}`;
}
const IDS: Record<string, string> = { ethereum: '0x1', polygon: '0x89', arbitrum: '0xa4b1', base:'0x2105', optimism:'0xa', bsc:'0x38', avalanche:'0xa86a', gnosis:'0x64' };
const METRIC_RPCS:Record<string,string[]>={...CHAIN_RPCS,gnosis:['https://rpc.gnosischain.com','https://gnosis.drpc.org','https://gnosis-rpc.publicnode.com']};
const NATIVE:Record<string,string>={polygon:'POL',bsc:'BNB',avalanche:'AVAX',gnosis:'xDAI'};
class ArchiveUnavailable extends Error {constructor(readonly raw:string){super('archive state unavailable');}}
export function metricQueryFallback(q:Record<string,string|undefined>){
 const text=q.query??'';
 const addresses=[...text.matchAll(/(?:^|[^a-z0-9])(0x[0-9a-f]{40})(?![a-z0-9])/gi)].map(m=>m[1]);
 const explicitBlocks=[...text.matchAll(/\bblock\b\s*(\S*)/gi)].map(m=>m[1]);
 const malformedBlock=explicitBlocks.some(value=>!/^\d+[?;!,]?$/.test(value));
 const blocks=[...text.matchAll(/\bblock\s+(\d+)\b(?![.,]\d)/gi)].map(m=>m[1]);
 const bare=[...text.replace(/0x[0-9a-f]+/gi,'').replace(/\bblock\s+\d+\b/gi,'').matchAll(/(?:^|\s)(\d{6,})(?![.,]\d)(?=\s|[.,;?!]|$)/g)].map(m=>m[1]);
 const chains=[...text.matchAll(/\b(ethereum|mainnet|polygon|arbitrum|base|optimism|bsc|bnb|avalanche|gnosis)\b/gi)].map(m=>m[1].toLowerCase());
 const explicitChains=[...text.matchAll(/\b(?:in|on)\s+([a-z][a-z0-9-]*)\b/gi)].map(m=>m[1].toLowerCase());
 const unsupportedChain=explicitChains.some(c=>!['ethereum','mainnet','polygon','arbitrum','base','optimism','bsc','bnb','avalanche','gnosis'].includes(c));
 const metrics=[...text.matchAll(/\b(transaction[ _-]+count|tx_count|nonce|transactions|balance)\b/gi)].map(m=>m[1].toLowerCase()==='balance'?'balance':'tx_count');
 const remaining=text.replace(/\b(?:in|on)\s+[a-z][a-z0-9-]*\b/gi,'').replace(/0x[0-9a-f]+/gi,'').replace(/\bblock\s+[+-]?[\d.,]+/gi,'').replace(/\b\d{6,}\b/g,'').replace(/\b(transaction[ _-]+count|tx_count|nonce|transactions|balance|ethereum|mainnet|polygon|arbitrum|base|optimism|bsc|bnb|avalanche|gnosis)\b/gi,'').replace(/\b(the|a|an|of|on|at|for|address|account|wallet|what|is|was|verify|check|please|show|me|held|by|in|and)\b/gi,'').replace(/[\s?.,:;!]/g,'');
 q=queryFallback(q,'address',()=>addresses.length>1?'invalid_address':addresses[0]);
 q=queryFallback(q,'block',()=>malformedBlock||blocks.length+bare.length>1?'invalid_block':blocks[0]??bare[0]);
 q=queryFallback(q,'chain',()=>unsupportedChain||chains.length>1||!!remaining&&q.metric!==undefined?'unsupported_chain':chains[0]);
 q=queryFallback(q,'metric',()=>metrics.length>1||remaining?'unsupported_metric':metrics[0]);return q;
}

interface Leg {
    url: string;
    hash: string;
    balance: string;
    nonce: string;
    raw: string[];
}
// A timed-out caller does not release ownership of an abort-ignoring source.
type ProviderFailure = 'not_finalized' | 'rate_limited' | 'timeout' | 'wrong_chain' | 'other';
class MetricProviderFailure extends Error {
    constructor(readonly failureClass: ProviderFailure, message: string) {super(message);}
}
class MetricDeadline extends MetricProviderFailure {
    constructor(message: string) {super('timeout',message);}
}
// Most frequent class; ties use this fixed order, independent of provider arrival.
const FAILURE_ORDER: ProviderFailure[] = ['not_finalized','rate_limited','timeout','wrong_chain','other'];
function providerDiagnostics(failures: ProviderFailure[], fullLegCount: number) {
    const dominant = [...FAILURE_ORDER].sort((a,b) => failures.filter(x=>x===b).length-failures.filter(x=>x===a).length)[0];
    return {full_leg_count:fullLegCount,...(failures.length ? {provider_failure:dominant} : {})};
}
const activeMetricCalls = new Set<string>();
export function resetMetricCallsForTests() { activeMetricCalls.clear(); }
async function call(url: string, method: string, params: unknown[], deadline: number): Promise<{
    result: any;
    raw: string;
}> {
    if (activeMetricCalls.has(url) || activeMetricCalls.size >= 16) throw Error('metric source capacity unavailable');
    if (Date.now() >= deadline) throw new MetricDeadline('metric deadline');
    activeMetricCalls.add(url);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let diagnosticStage:'unreachable'|'bad_payload'='unreachable';
    const io = (async () => {
    try {
        if (Date.now() >= deadline)
            throw new MetricDeadline('metric deadline');
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: abort.signal });
        if (!r.ok)
            throw new MetricProviderFailure(r.status === 429 ? 'rate_limited' : 'other', `RPC HTTP ${r.status}`);
        const reader = r.body?.getReader();
        if (!reader)
            throw new Error('missing body');
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const p = await reader.read();
                if (p.done)
                    break;
                size += p.value.length;
                if (size > 65536) {
                    diagnosticStage='bad_payload';
                    await reader.cancel();
                    throw new Error('RPC body limit');
                }
                parts.push(p.value);
            }
        }
        finally {
            reader.releaseLock();
        }
        diagnosticStage='bad_payload';
        const raw = Buffer.concat(parts).toString('utf8');
        const j = JSON.parse(raw);
        if(j.jsonrpc==='2.0'&&j.id===1&&j.error&&!Object.hasOwn(j,'result')&&['eth_getBalance','eth_getTransactionCount'].includes(method)&&Number.isInteger(j.error.code)&&typeof j.error.message==='string'&&j.error.message.length<=500&&/archive requests require|missing trie node|no state found for block|unknown state|historical state.*unavailable|state.*pruned/i.test(j.error.message))throw new ArchiveUnavailable(raw);
        if (j.jsonrpc !== '2.0' || j.id !== 1 || j.error || !Object.hasOwn(j, 'result'))
            throw new Error('invalid RPC envelope');
        return { result: j.result, raw };
    }
    catch(error){try{markFailure(error,error instanceof MetricProviderFailure&&error.failureClass==='rate_limited'?'rate_limited':diagnosticStage);}catch{}throw error;}
    finally { activeMetricCalls.delete(url); }
    })();
    try {
        return await Promise.race([io, new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                abort.abort();
                reject(new MetricDeadline('metric deadline'));
            }, Math.max(0, Math.min(1800, deadline - Date.now())));
        })]);
    } finally {
        clearTimeout(timer);
    }

}
const qty = (x: unknown): bigint => { if (typeof x !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(x))
    throw new Error('invalid hex quantity'); return BigInt(x); };
// Diagnostics only: track questions without joining, blocking or changing their work.
interface OverlapGroup { active: number; sawOverlap: boolean }
const metricOverlaps = new Map<string,OverlapGroup>();
export async function handleOnchainMetric(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    query=metricQueryFallback(query);
    const address = query.address?.trim();
    if (!address || !ADDRESS_RE.test(address))
        throw badRequest('INVALID_ADDRESS', 'an explicit EVM address is required');
    const b = query.block?.trim();
    if (!b || !/^\d{1,13}$/.test(b) || BigInt(b) > 1000000000000n)
        throw badRequest('INVALID_BLOCK', 'block must be an integer from 0 to 1000000000000');
    const block = BigInt(b);
    const tag = '0x' + block.toString(16);
    const chain = normalizeChain(query.chain?.trim().toLowerCase()==='bnb'?'bsc':query.chain ?? 'ethereum');
    if (!chain || !IDS[chain])
        throw badRequest('UNSUPPORTED_CHAIN', 'supported chains: ethereum, polygon, arbitrum, base, optimism, bsc, avalanche, gnosis');
    const metric = query.metric ?? 'balance';
    if (!['balance', 'tx_count'].includes(metric))
        throw badRequest('INVALID_METRIC', 'metric must be balance or tx_count');
    const key=JSON.stringify([address.toLowerCase(),block.toString(),chain,metric]);
    const group=metricOverlaps.get(key)??{active:0,sawOverlap:false};
    if(group.active>0)group.sawOverlap=true;
    group.active++;
    metricOverlaps.set(key,group);
    try {
        const result=await runMetricWorkflow(address,block,tag,chain,metric);
        return withAnswerClass(result,'ONCHAIN_METRIC_VERIFY_GENERAL',{
            ...answerDiagnostics('ONCHAIN_METRIC_VERIFY_GENERAL',result).answerClass,
            concurrent_identical_in_flight:group.sawOverlap?'some':'none',
        });
    } catch(err) {
        if(err && typeof err==='object')withAnswerClass(err,'ONCHAIN_METRIC_VERIFY_GENERAL',{
            ...answerDiagnostics('ONCHAIN_METRIC_VERIFY_GENERAL',err).answerClass,
            concurrent_identical_in_flight:group.sawOverlap?'some':'none',
        });
        throw err;
    } finally {
        group.active--;
        if(group.active===0 && metricOverlaps.get(key)===group)metricOverlaps.delete(key);
    }
}
async function runMetricWorkflow(address:string,block:bigint,tag:string,chain:string,metric:string):Promise<Record<string,unknown>> {
    const deadline = Date.now() + 9000;
    const legs: Leg[] = [];
    const errors: string[] = [];
    const archiveEvidence:{url:string;raw:string}[]=[];
    let deadlineHit = false;
    const providerFailures: ProviderFailure[] = [];
    const diagnosticFailures:Array<{upstream_name:string;upstream_failure:FailureClass}>=[];
    for (const url of METRIC_RPCS[chain]) {
        try {
            const raw: string[] = [];
            const request = async (m: string, p: unknown[]) => { const x = await call(url, m, p, deadline); raw.push(x.raw); return x.result; };
            if (qty(await request('eth_chainId', [])) !== qty(IDS[chain]))
                throw new MetricProviderFailure('wrong_chain','wrong chain');
            const finalized = await request('eth_getBlockByNumber', ['finalized', false]);
            if (!finalized || qty(finalized.number) < block)
                throw new MetricProviderFailure('not_finalized','block is not finalized');
            const before = await request('eth_getBlockByNumber', [tag, false]);
            if (!before || qty(before.number) !== block || !/^0x[0-9a-fA-F]{64}$/.test(before.hash))
                throw new Error('wrong block identity');
            const balance = qty(await request('eth_getBalance', [address, tag]));
            const nonce = qty(await request('eth_getTransactionCount', [address, tag]));
            const after = await request('eth_getBlockByNumber', [tag, false]);
            if (!after || after.hash?.toLowerCase() !== before.hash.toLowerCase() || qty(after.number) !== block)
                throw new Error('block identity changed');
            if (balance > 10n ** 29n || nonce > 1000000000000n)
                throw new Error('value outside canonical range');
            legs.push({ url, hash: before.hash.toLowerCase(), balance: balance.toString(), nonce: nonce.toString(), raw });
        }
        catch (err) {
            if(err instanceof ArchiveUnavailable)archiveEvidence.push({url,raw:err.raw});
            if (err instanceof MetricDeadline) deadlineHit = true;
            try{diagnosticFailures.push({upstream_name:metricUpstream(url),upstream_failure:err instanceof MetricProviderFailure?err.failureClass==='rate_limited'?'rate_limited':err.failureClass==='timeout'?'unreachable':'other':failureKind(err)});}catch{}
            providerFailures.push(err instanceof MetricProviderFailure ? err.failureClass : 'other');
            errors.push(url);
        }
        const groups = new Map<string, Leg[]>();
        for (const leg of legs) {
            const k = [leg.hash, leg.balance, leg.nonce].join(':');
            groups.set(k, [...(groups.get(k) ?? []), leg]);
        }
        const wins = [...groups.values()].find(v => v.length >= 2);
        if (!wins)
            continue;
        const w = wins[0];
        const wei = BigInt(w.balance);
        const balanceGwei = Number(wei / 1000000000n) + Number(wei % 1000000000n) / 1e9;
        const count = Number(w.nonce);
        const nativeSymbol = NATIVE[chain]??'ETH';
        const balanceSentence = `${address} held exactly ${metricNativeText(wei)} ${nativeSymbol} (${balanceGwei} Gwei) on ${chain} at finalized block ${block}.`;
        const evidence = JSON.stringify({ chain, address: address.toLowerCase(), block: block.toString(), block_hash: w.hash, balance_wei: w.balance, tx_count: w.nonce, sources: legs, unavailable_sources: errors });
        const receipt = makeReceipt('ONCHAIN_METRIC_VERIFY_GENERAL', w.url, evidence, `${wins.length}/${METRIC_RPCS[chain].length} same finalized block hash, balance and nonce`);
        await saveReceipt(receipt, evidence);
        return withAnswerClass(envelope('ONCHAIN_METRIC_VERIFY_GENERAL', { address, chain, block: block.toString(), block_hash: w.hash, balance_gwei: balanceGwei, balance_wei: w.balance, tx_count: count, metric }, receipt, { answer: metric === 'balance' ? balanceSentence : `${address} had sent ${count} transactions (nonce) on ${chain} at finalized block ${block}. ${balanceSentence}`, verdict: 'verified', confidence: wins.length === METRIC_RPCS[chain].length ? 1 : 0.95, source: `Block-pinned RPC agreement; ${w.url}; balance is Gwei (10^-9 native units); nonce is not received transfers.` }),'ONCHAIN_METRIC_VERIFY_GENERAL',{metric_kind:metric,leg:'quorum',result:'value',...providerDiagnostics(providerFailures,legs.length)});
    }
    if(archiveEvidence.length>=2&&archiveEvidence.length===errors.length&&legs.length<2){
        const notice='Archive-block disclosure: the public RPC sources did not provide enough historical state for this exact block. No balance or transaction count is verified; unavailable is not zero.';
        const evidence=JSON.stringify({chain,address:address.toLowerCase(),block:block.toString(),metric,reason_code:'archive_state_unavailable',archive_errors:archiveEvidence,partial_sources:legs});
        const receipt=makeReceipt('ONCHAIN_METRIC_VERIFY_GENERAL',archiveEvidence[0].url,evidence,'archive state unavailable; no value quorum');await saveReceipt(receipt,evidence);
        return withAnswerClass(envelope('ONCHAIN_METRIC_VERIFY_GENERAL',{address,chain,block:block.toString(),block_hash:null,balance_gwei:null,balance_wei:null,tx_count:null,metric,status:'no_data',reason_code:'archive_state_unavailable'},receipt,{answer:notice,verdict:'unverified',confidence:0,source:'Public block-pinned RPC archive availability only; no verified metric value'}),'ONCHAIN_METRIC_VERIFY_GENERAL',{metric_kind:metric,leg:'none',result:'null',full_leg_count:legs.length});
    }
    let refusalReason = deadlineHit ? 'deadline' : 'insufficient_providers';
    if (!deadlineHit && legs.length >= 2) {
        refusalReason = new Set(legs.map(l => l.hash)).size > 1 ? 'hash_mismatch'
            : new Set(legs.map(l => l.balance)).size > 1 ? 'balance_mismatch' : 'nonce_mismatch';
    }
    throw withAnswerClass(upstreamUnavailable('METRIC_QUORUM_UNAVAILABLE', 'two sources did not agree on the exact finalized block identity, balance and nonce'),
        'ONCHAIN_METRIC_VERIFY_GENERAL', {...combineFailures(diagnosticFailures),metric_kind:metric,leg:'none',result:'refused',refusal_reason:refusalReason,...providerDiagnostics(providerFailures,legs.length)});
}
