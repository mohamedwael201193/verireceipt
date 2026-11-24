import {answerDiagnostics,withAnswerClass} from './answerClass';
import {publicSourceFailure} from './publicSource';
import { upstreamUnavailable } from './errors';
import { envelope, makeReceipt } from './receipt';
import { saveReceipt } from './storage';
export interface SourceApproval {
    /** Maintainer-reviewed terms, not an assertion received from a request. */
    termsUrl: string;
    checkedAt: string;
    commercialUse: boolean;
    redistribution: boolean;
    /** Owner accepts recorded terms risk for this testnet project. Not a licence. */
    ownerRiskAcceptance?: { sourceReference: string; scope: 'testnet-hackathon'; acceptedAt: string };
}
export interface SourceObservation<T> {
    value: T;
    sourceUrl: string;
    rawBody: string;
    observedAt: string;
    fetchedAt: string;
    /** Identity must be echoed by the parsed source, never copied from request. */
    identity: string;
}
export interface ObservationSource<Q, T> {
    name: string;
    approval: SourceApproval;
    read(query: Q, signal: AbortSignal): Promise<SourceObservation<T>>;
}
export interface ObservationPolicy<Q, T> {
    intent: string;
    identity(query: Q): string;
    validate(value: T): void;
    fields(value: T): Record<string, unknown>;
    answer(value: T): string;
    maxAgeMs: number;
    sourceTimeoutMs: number;
    /** Optional shared network budget across primary and fallback legs. */
    totalTimeoutMs?: number;
    /** Preserve fail-fast timeout behavior instead of starting another slow leg. */
    stopAfterTimeout?: boolean;
    /** Label source granularity honestly. This is not an agreement quorum. */
    scope: string;
}
function timestamp(x: string): number { const n = Date.parse(x); if (!Number.isFinite(n))
    throw new Error('invalid source timestamp'); return n; }
function approved(a: SourceApproval): boolean {
    try {
        // ownerRiskAcceptance is checked for presence only; its authenticity is established out-of-band on the trusted channel. A passing approved() is never citable as proof of approval.
        return ((a.commercialUse === true && a.redistribution === true) || (a.ownerRiskAcceptance?.scope === 'testnet-hackathon' && !!a.ownerRiskAcceptance.sourceReference && Number.isFinite(Date.parse(a.ownerRiskAcceptance.acceptedAt)))) && new URL(a.termsUrl).protocol === 'https:' && Number.isFinite(Date.parse(a.checkedAt));
    }
    catch {
        return false;
    }
}
/** Receipted primary/fallback runner. An empty approved list fails closed. */
export async function observeFromSources<Q, T>(query: Q, sources: readonly ObservationSource<Q, T>[], policy: ObservationPolicy<Q, T>): Promise<Record<string, unknown>> {
    const identity = policy.identity(query);
    const failed: string[] = [];
    const deadline = policy.totalTimeoutMs === undefined ? Infinity : Date.now() + policy.totalTimeoutMs;
    let liquidityClass:Record<string,unknown>|undefined;
    for (const source of sources) {
        if (!approved(source.approval)) {
            failed.push(source.name + ':unapproved');
            continue;
        }
        const remainingMs = Math.min(policy.sourceTimeoutMs, deadline - Date.now());
        if (remainingMs <= 0) break;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); const deadlineError=new Error('source deadline');if(policy.intent==='LIQUIDITY_DEPTH_VERIFY_GENERAL'&&source.name==='DEX Screener named pool reserve liquidity')withAnswerClass(deadlineError,policy.intent,{dexscreener_failure:'timeout'});reject(deadlineError); }, remainingMs); });
            const observation = await Promise.race([source.read(query, controller.signal), timeout]);
            if (controller.signal.aborted)
                throw new Error('source deadline');
            if (observation.identity !== identity)
                throw new Error('source identity mismatch');
            if (new URL(observation.sourceUrl).protocol !== 'https:')
                throw new Error('non-HTTPS evidence URL');
            if (typeof observation.rawBody !== 'string' || Buffer.byteLength(observation.rawBody) > 1000000)
                throw new Error('source evidence missing or oversized');
            const now = Date.now(), observed = timestamp(observation.observedAt), fetched = timestamp(observation.fetchedAt);
            if (observed > now + 30000 || now - observed > policy.maxAgeMs || fetched > now + 30000 || now - fetched > policy.maxAgeMs || observed > fetched + 30000)
                throw new Error('source freshness invalid');
            policy.validate(observation.value);
            // Stop the network deadline before local receipt persistence. A source that
            // ignores AbortSignal may finish late, but cannot save a late receipt here.
            clearTimeout(timer);
            timer = undefined;
            const evidence = JSON.stringify({ identity, provider: source.name, source_url: observation.sourceUrl, observed_at: observation.observedAt, fetched_at: observation.fetchedAt, raw_body: observation.rawBody, value: observation.value, source_scope: policy.scope, prior_sources: failed, terms: { url: source.approval.termsUrl, checked_at: source.approval.checkedAt, commercial_use_confirmed:source.approval.commercialUse, redistribution_confirmed:source.approval.redistribution, owner_terms_risk_accepted:!!source.approval.ownerRiskAcceptance } });
            const receipt = makeReceipt(policy.intent, observation.sourceUrl, evidence, '1/1 named observation; primary/fallback, not cross-source consensus');
            receipt.fetched_at = observation.fetchedAt;
            // Once persistence starts, errors propagate. Do not retry another source
            // after an uncertain/failed save, which could create a second receipt.
            await saveReceipt(receipt, evidence);
            return envelope(policy.intent, policy.fields(observation.value), receipt, { answer: policy.answer(observation.value) + ` Source observed ${observation.observedAt}. ${policy.scope}`, verdict: 'verified', confidence: failed.length ? .85 : .95, source: `${source.name}: ${observation.sourceUrl}; observed ${observation.observedAt}; fetched ${observation.fetchedAt}; ${failed.length ? 'fallback' : 'primary'}; no averaging.` });
        }
        catch (error) {
            if (timer === undefined)
                throw error;
            if(policy.intent==='LIQUIDITY_DEPTH_VERIFY_GENERAL')liquidityClass=answerDiagnostics(policy.intent,error).answerClass??liquidityClass;
            failed.push(source.name + ':unavailable');
            if (policy.stopAfterTimeout && (controller.signal.aborted || publicSourceFailure(error) === 'timeout')) break;
        }
        finally {
            if (timer)
                clearTimeout(timer);
            controller.abort();
        }
    }
    const error=upstreamUnavailable('APPROVED_SOURCES_UNAVAILABLE', 'no current identity-matching observation from a source with reviewed terms or scoped owner risk acceptance');
    if(liquidityClass)withAnswerClass(error,policy.intent,liquidityClass);
    throw error;
}
