import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {annualFinancialMetrics} from '../src/handlers/annualFinancialMetrics';
import {resetSecFinancialCacheForTests} from '../src/handlers/secFinancialCache';
const raw=(tag:string)=>readFileSync(join(__dirname,'fixtures/financial-period/nvda-'+tag+'.json'),'utf8');
afterEach(()=>{resetSecFinancialCacheForTests();vi.useRealTimers();});
function load(change?:(tag:string,body:any)=>void){return async(url:string)=>{const tag=url.split('/').pop()!.replace('.json','');let body;try{body=JSON.parse(raw(tag));}catch{throw Error('actual concept404');}change?.(tag,body);return JSON.stringify(body);};}
it('real NVDA picks latest Revenues period rather than stale contract revenue; all concept evidence retained',async()=>{
 const m:any=await annualFinancialMetrics('0001045810','tests',load());expect(m.annual_revenue.fact).toMatchObject({concept:'Revenues',period_end:'2026-01-25',value_usd:215938000000});expect(m.annual_net_income.fact.period_end).toBe('2026-01-25');expect(m.annual_total_assets.fact.period_end).toBe('2026-01-25');expect(m.annual_revenue.period_alignment).toContain('align');expect(m.annual_revenue.candidate_observations).toHaveLength(4);expect(m.annual_revenue.candidate_observations[0].fact.period_end).toBe('2022-01-30');expect(m.annual_revenue.raw_body).toBe(raw('Revenues'));
});
it('unavailable new revenue does not silently present old revenue as same fiscal period',async()=>{
 const base=load();const m:any=await annualFinancialMetrics('0001045810','tests',async u=>{if(u.endsWith('/Revenues.json'))throw Error('outage');return base(u);});expect(m.annual_revenue.fact.period_end).toBe('2022-01-30');expect(m.annual_revenue.period_alignment).toContain('mixed annual period');expect(m.annual_net_income.period_alignment).toContain('mixed annual period');
});
it('newer filing cannot outrank a later reporting period',async()=>{
 const m:any=await annualFinancialMetrics('0001045810','tests',load((tag,d)=>{if(tag==='RevenueFromContractWithCustomerExcludingAssessedTax')for(const r of d.units.USD)r.filed='2026-11-01';}));expect(m.annual_revenue.fact.concept).toBe('Revenues');expect(m.annual_revenue.fact.period_end).toBe('2026-01-25');
});
it('wrong identity for newer revenue is not served; original period is disclosed mixed',async()=>{
 const m:any=await annualFinancialMetrics('0001045810','tests',load((tag,d)=>{if(tag==='Revenues')d.cik=1;}));expect(m.annual_revenue.fact.concept).not.toBe('Revenues');expect(m.annual_revenue.period_alignment).toContain('mixed');
});
