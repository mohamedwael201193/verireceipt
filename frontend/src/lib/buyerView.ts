// Display-boundary checks, not independent source authentication. The server runs
// the actual source/receipt verifier. Browser state can only select one frozen product.
export type BuyerPlan = {
    version: 'sponsored-filing-plan-v1';
    id: string;
    plan_hash: string;
    policy_hash: string;
    task_hash: string;
    created_at: string;
    expires_at: string;
    input: {
        cik: string;
        year: number;
    };
    call_uusdc: string;
    daily_cap_uusdc: string;
    network: string;
    form: '10-Q';
    minimum_count: 3;
    params: {
        entity: string;
        period: string;
    };
    rule: {
        op: string;
        value: number;
        units: string;
        label: string;
    };
};
export type SavedBuyer = {
    plan: BuyerPlan;
    attempted: boolean;
};
export type BuyerJob = {
    id: string;
    state: 'planned' | 'reserved' | 'signing' | 'complete' | 'uncertain';
    expires_at: string;
    plan: BuyerPlan;
    result: any;
    followups: any[];
};
const RULE = { op: '>=', value: 3, units: 'filings', label: 'Verified exact 10-Q filing count at least three' };
// Generated from the frozen server policy in src/buyer/contracts.ts.
export const BUYER_POLICY_HASH = '975f28745fb3eec6591b92523f587c41d0f88cd925eafb840e3924bc04e12639';
export const BUYER_TASK_HASH = '597bdca828d08ef154ad8f04d7e9891c9f7cb2e8eb8ea02a2dd346e56dccabbe';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
function sameRule(r: any) { return r && Object.keys(RULE).every(k => r[k] === RULE[k as keyof typeof RULE]); }
function sameParams(params: any, p: BuyerPlan) { return params && Object.keys(params).sort().join(',') === 'entity,period' && params.entity === p.params.entity && params.period === p.params.period; }
export function validateBuyerPreview(p: any): asserts p is BuyerPlan {
    if (!p || p.version !== 'sponsored-filing-plan-v1' || !uuid.test(p.id) || !hash.test(p.plan_hash) || p.policy_hash !== BUYER_POLICY_HASH || p.task_hash !== BUYER_TASK_HASH || p.network !== 'eip155:11155111' || p.call_uusdc !== '10000' || p.daily_cap_uusdc !== '2000000' || p.form !== '10-Q' || p.minimum_count !== 3 || !sameRule(p.rule) || !p.input || typeof p.input.cik !== 'string' || !/^[1-9][0-9]{0,9}$/.test(p.input.cik) || !Number.isInteger(p.input.year) || p.input.year < 1994 || p.input.year >= new Date().getUTCFullYear() || !Number.isFinite(Date.parse(p.created_at)) || !Number.isFinite(Date.parse(p.expires_at)) || Date.parse(p.expires_at) - Date.parse(p.created_at) !== 600000 || !p.params || Object.keys(p.params).sort().join(',') !== 'entity,period' || p.params.entity !== `Form 10-Q filings (CIK ${p.input.cik})` || p.params.period !== `calendar ${p.input.year}`)
        throw new Error('Unrecognized frozen preview. Purchase or result blocked.');
}
export function validateSavedBuyer(s: any): asserts s is SavedBuyer { validateBuyerPreview(s?.plan); if (typeof s.attempted !== 'boolean')
    throw new Error('Invalid recovery record'); }
function checks(value: any): value is {
    name: string;
    ok: boolean;
    detail: string;
}[] { return Array.isArray(value) && value.every(c => c && typeof c.name === 'string' && typeof c.detail === 'string' && typeof c.ok === 'boolean'); }
export function verifiedFilingCount(r: any): boolean { return r && Number.isSafeInteger(r.record?.value) && r.record.value >= 0 && r.record.source_verification?.status === 'verified' && checks(r.record.source_verification.checks) && r.record.source_verification.checks.length > 0 && r.record.source_verification.checks.every((c: any) => c.ok); }
export function validateBuyerJob(j: any, s: SavedBuyer): asserts j is BuyerJob {
    validateBuyerPreview(j?.plan);
    const p = s.plan;
    if (j.id !== p.id || j.plan.id !== p.id || j.plan.plan_hash !== p.plan_hash || j.plan.policy_hash !== p.policy_hash || j.plan.task_hash !== p.task_hash || j.plan.input.cik !== p.input.cik || j.plan.input.year !== p.input.year || !sameParams(j.plan.params, p) || !['planned', 'reserved', 'signing', 'complete', 'uncertain'].includes(j.state) || !Number.isFinite(Date.parse(j.expires_at)) || (!Array.isArray(j.followups) || !j.followups.every((f: any) => f && ['checking', 'included', 'pending', 'error'].includes(f.status))))
        throw new Error('Result identity mismatch. HOLD.');
    const r = j.result;
    if (r === null) {
        if (j.state === 'complete')
            throw new Error('Complete job has no result. HOLD.');
        return;
    }
    const g = r?.record, c = r?.charge;
    if (!r || r.version !== 'hosted-ranked-filing-result-v1' || r.plan_id !== p.id || r.plan_hash !== p.plan_hash || r.policy_hash !== p.policy_hash || r.task_hash !== p.task_hash || !/^0x[0-9a-f]{40}$/.test(r.payer) || g?.payer !== r.payer || g?.policy_hash !== p.policy_hash || g?.task_hash !== p.task_hash || g?.gate_id !== 'hosted-exact-10q-minimum-three' || g?.intent !== 'REGULATORY_FILING_MONITOR_GENERAL' || !sameRule(g.rule) || !sameParams(g.params, p) || !['PASS', 'HOLD'].includes(g.outcome) || !checks(g.node_checks) || !checks(g.miner_checks) || !Array.isArray(g.reasons) || !g.reasons.every((x: any) => typeof x === 'string') || !c || c.maximum_uusdc !== '10000' || !['not_signed', 'receipt', 'uncertain'].includes(c.status))
        throw new Error('Unrecognized result binding. HOLD.');
    if (g.source_verification && !checks(g.source_verification.checks))
        throw new Error('Unrecognized source checks. HOLD.');
    if (c.status === 'receipt') {
        const receipt = r.receipt, purchase = g.purchase;
        if (c.amount_uusdc !== '10000' || !receipt || String(receipt.payer).toLowerCase() !== r.payer || String(receipt.amount_uusdc) !== '10000' || receipt.intent !== g.intent || !/^0x[0-9a-f]{64}$/.test(receipt.receipt_hash) || receipt.receipt_hash !== purchase?.receipt_hash || receipt.epoch_id !== purchase?.epoch_id || String(receipt.miner) !== purchase?.serving_miner || purchase?.paid_uusdc !== '10000')
            throw new Error('Unrecognized charge binding. HOLD.');
    }
    else if (c.amount_uusdc !== null || r.receipt !== null || g.outcome !== 'HOLD')
        throw new Error('Unknown charge cannot PASS. HOLD.');
    if (g.outcome === 'PASS' && (j.state !== 'complete' || c.status !== 'receipt' || !verifiedFilingCount(r) || g.value < 3 || g.record_appended !== true || !g.node_checks.length || g.node_checks.some((x: any) => !x.ok) || g.miner_checks.some((x: any) => !x.ok) || !['passed', 'not_applicable'].includes(g.miner_chain)))
        throw new Error('PASS lacks server checks. HOLD.');
}
function canonical(value: any): string { if (Array.isArray(value))
    return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'; return JSON.stringify(value); }
export async function verifyBuyerPreview(p: BuyerPlan): Promise<void> {
    validateBuyerPreview(p);
    if (!globalThis.crypto?.subtle?.digest)
        throw new Error('Secure preview verification unavailable. Purchase blocked.');
    const { plan_hash, ...body } = p;
    const bytes = new TextEncoder().encode(canonical(body).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e'));
    const digest = await crypto.subtle.digest('SHA-256', bytes), hex = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
    if (hex !== plan_hash)
        throw new Error('Preview content hash mismatch. Purchase or result blocked.');
}
