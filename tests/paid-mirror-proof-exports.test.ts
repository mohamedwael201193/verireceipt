import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const dir=join(process.cwd(),'docs/proofs/2026-11-25-mirrors');
it('exports all eight public exact paid mirror evidence bodies without relabeling acquisition or settlement',()=>{
 const m=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
 expect(m.total_calls).toBe(8);expect(m.total_amount_uusdc).toBe('80000');expect(m.network).toBe('eip155:11155111');
 expect(new Set(m.proofs.map((p:any)=>p.receipt_id)).size).toBe(8);
 for(const p of m.proofs){const body=readFileSync(join(dir,p.file));expect(createHash('sha256').update(body).digest('hex')).toBe(p.raw_response_sha256);expect(body.length).toBe(p.raw_bytes);expect(p.evidence_available_at_acquisition).toBe(true);expect(p.verification).toBe('VERIFIED');expect(p.serving_registration).toBe('6188');expect(p.amount_uusdc).toBe('10000');expect(p.payment_rail).toBe('escrow');expect(p.payment_chain).toBe('telegraph');expect(p.payment_settlement).toBe('epoch');expect(new Date(p.payment_timestamp*1000).toISOString()).toBe(p.bought_at);expect(p.payment_header_sha256).toMatch(/^[0-9a-f]{64}$/);expect(p.payer).toBeUndefined();expect(p.payment_response_header).toBeUndefined();if(p.intent==='GRID_POWER_PRICE_GENERAL')expect(p.grid_status).toContain('not final settlement');}
 expect(m.proofs.filter((p:any)=>p.task_id==='m12-nyiso-zone-j')).toHaveLength(2);expect(m.proofs.filter((p:any)=>p.task_id==='m13-tvl-aave-v3')).toHaveLength(2);
});

it('excludes the private transaction evidence body and payer identity from the public export',()=>{const m=readFileSync(join(dir,'manifest.json'),'utf8');expect(m).not.toContain('rcpt_WDBEVD6X14F6IB73S83EUMS729');});
