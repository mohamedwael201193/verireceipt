import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {reviewedSection} from '../src/handlers/returnPolicy';
const dir='tests/fixtures/return-policy/';
it('all policy fixtures contain reviewed sections only, with original and section hashes retained',()=>{
 const provenance=JSON.parse(readFileSync(dir+'section-provenance.json','utf8'));
 expect(provenance.map((p:any)=>p.retailer).sort()).toEqual(['apple','costco','ikea','target','walmart']);
 for(const p of provenance){const raw=readFileSync(dir+p.retailer+'.html','utf8');expect(raw).toContain('EXTRACTED REVIEWED POLICY SECTION ONLY');expect(raw).not.toMatch(/<script|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i);expect(p.original_raw_sha256).toMatch(/^[a-f0-9]{64}$/);expect(p.fixture_kind).toContain('Not a full raw HTTP response');expect(createHash('sha256').update(reviewedSection(p.retailer,raw)).digest('hex')).toBe(p.reviewed_section_sha256);}
});
