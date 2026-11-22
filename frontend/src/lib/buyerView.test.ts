import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { buyerFixtureJob, buyerFixturePlan, buyerFixtureResult } from '../test/buyerFixture';
import { validateBuyerPreview, verifyBuyerPreview, validateBuyerJob, validateSavedBuyer, verifiedFilingCount } from './buyerView';
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe('browser display boundary, synthetic data only', () => {
    it('accepts the frozen canonical plan hash and an evidence-bound result', async () => { const p = buyerFixturePlan(); await expect(verifyBuyerPreview(p)).resolves.toBeUndefined(); expect(() => validateBuyerJob(buyerFixtureJob(p), { plan: p, attempted: true })).not.toThrow(); expect(verifiedFilingCount(buyerFixtureResult(p))).toBe(true); });
    it('refuses a changed CIK/year even when its old digest is preserved', async () => { const p = buyerFixturePlan(); p.input.cik = '1318605'; p.params.entity = 'Form 10-Q filings (CIK 1318605)'; await expect(verifyBuyerPreview(p)).rejects.toThrow('hash mismatch'); });
    it.each(['policy_hash', 'task_hash', 'network', 'call_uusdc', 'daily_cap_uusdc', 'form', 'minimum_count', 'version'])('rejects altered frozen preview identity %s', (field) => { const p: any = buyerFixturePlan(); p[field] = 'unrelated'; expect(() => validateBuyerPreview(p)).toThrow(); });
    it.each(['op', 'value', 'units', 'label'])('rejects altered rule %s', (field) => { const p: any = buyerFixturePlan(); p.rule[field] = 'altered'; expect(() => validateBuyerPreview(p)).toThrow(); });
    it('does not treat truthy strings as an attempted-purchase recovery flag', () => { expect(() => validateSavedBuyer({ plan: buyerFixturePlan(), attempted: 'yes' })).toThrow(); });
    it.each(['plan_id', 'plan_hash', 'policy_hash', 'task_hash', 'payer'])('HOLDs a result with a mismatched %s', (field) => { const p = buyerFixturePlan(), j: any = buyerFixtureJob(p); j.result[field] = 'wrong'; expect(() => validateBuyerJob(j, { plan: p, attempted: true })).toThrow(); });
    it.each(['payer', 'amount_uusdc', 'receipt_hash', 'epoch_id', 'miner', 'intent'])('HOLDs a wrong receipt %s', (field) => { const p = buyerFixturePlan(), j: any = buyerFixtureJob(p); j.result.receipt[field] = 'wrong'; expect(() => validateBuyerJob(j, { plan: p, attempted: true })).toThrow(); });
    it.each(['node', 'miner', 'source', 'value', 'charge', 'append', 'state'])('HOLDs a false PASS with broken %s evidence', (field) => { const p = buyerFixturePlan(), j: any = buyerFixtureJob(p), g = j.result.record; if (field === 'node')
        g.node_checks[0].ok = false; if (field === 'miner')
        g.miner_checks = [{ name: 'failed', ok: false, detail: 'test' }]; if (field === 'source')
        g.source_verification.checks = []; if (field === 'value')
        g.value = 2; if (field === 'charge')
        j.result.charge.status = 'uncertain'; if (field === 'append')
        g.record_appended = false; if (field === 'state')
        j.state = 'uncertain'; expect(() => validateBuyerJob(j, { plan: p, attempted: true })).toThrow(); });
    it('accepts equivalent numeric receipt amount and mixed-case payer without weakening identity', () => { const p = buyerFixturePlan(), j: any = buyerFixtureJob(p); j.result.receipt.amount_uusdc = 10000; j.result.receipt.payer = j.result.payer.toUpperCase().replace('0X', '0x'); expect(() => validateBuyerJob(j, { plan: p, attempted: true })).not.toThrow(); });
    it('labels failed primary recount numbers as unverified rather than a factual filing count', () => { const p = buyerFixturePlan(), r = buyerFixtureResult(p); r.record.source_verification.status = 'failed'; expect(verifiedFilingCount(r)).toBe(false); });
    it('rejects malformed check arrays/followups rather than throwing during rendering', () => { const p = buyerFixturePlan(), j: any = buyerFixtureJob(p); j.result.record.node_checks = { ok: true }; expect(() => validateBuyerJob(j, { plan: p, attempted: true })).toThrow(); j.result = buyerFixtureResult(p); j.followups = [{ status: { bad: 'data' } }]; expect(() => validateBuyerJob(j, { plan: p, attempted: true })).toThrow(); });
});

it('fails closed with a clear error when WebCrypto is unavailable', async () => {vi.stubGlobal('crypto', {}); await expect(verifyBuyerPreview(buyerFixturePlan())).rejects.toThrow('Secure preview verification unavailable');});
it('rejects a complete job with no result', () => {const p=buyerFixturePlan();const j=buyerFixtureJob(p,null);j.state='complete';expect(()=>validateBuyerJob(j,{plan:p,attempted:true})).toThrow('Complete job has no result');});
