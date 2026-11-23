import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';import {join} from 'node:path';
const dir=mkdtempSync('/tmp/email-alias-');process.env.SQLITE_PATH=join(dir,'receipts.sqlite');
import {handleEmailSecurity,resolveEmailDnsQuery} from '../src/handlers/emailSecurity';
import {buildServer} from '../src/server';import {getReceiptEvidence} from '../src/core/storage';import {sha256Hex} from '../src/core/receipt';
afterAll(()=>rmSync(dir,{recursive:true,force:true}));afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
function body(label:string,provider:string){return readFileSync(join(__dirname,'fixtures/email-alias',`${label.toLowerCase()}-${provider}.json`),'utf8');}
function stub(label:string){vi.stubGlobal('fetch',vi.fn(async(u:unknown)=>new Response(body(label,String(u).includes('dns.google')?'google':'cloudflare'))));}
describe('email DNS mechanism aliases backed by actual resolver bodies',()=>{
 it.each(['SPF','DMARC','DKIM','MTA-STS','TLS-RPT','MX'])('%s derives a bound query and discloses mapping',async(label)=>{
  stub(label);const r=await handleEmailSecurity({domain:'google.com',record_type:label.toLowerCase()});expect(r.lookup_ok).toBe(true);
  const query=resolveEmailDnsQuery('google.com',label);expect(String(r.answer)).toContain(query.mapping);
  for(const call of (fetch as any).mock.calls){const u=new URL(String(call[0]));expect(u.searchParams.get('name')).toBe(query.name);expect(u.searchParams.get('type')).toBe(label==='MX'?'15':'16');}
  const receipt=r.receipt as any;const ev=(await getReceiptEvidence(receipt.receipt_id)).evidence!;expect(sha256Hex(ev)).toBe(receipt.raw_response_sha256);
  const j=JSON.parse(ev.toString());expect(j.queried_name).toBe(query.name);expect(j.observations[0].raw_body).toBe(body(label,'google'));
  if(label==='DKIM')expect(String(r.answer)).toContain('no selector supplied or guessed');
 });
 it('BIMI NXDOMAIN means false, not missing transport evidence',async()=>{stub('BIMI');const r=await handleEmailSecurity({domain:'verireceipt-probe.invalid',record_type:'bImI'});expect(r.lookup_ok).toBe(false);expect(String(r.answer)).toContain('default._bimi.verireceipt-probe.invalid');});
 it.each(['16','junk label','BOGUS_TYPE'])('%s resolves at bare domain with actual TXT fixture',async(label)=>{stub('SPF');const r=await handleEmailSecurity({domain:'google.com',record_type:label});expect(r.lookup_ok).toBe(true);if(label!=='16')expect(String(r.answer)).toContain('defaulted to TXT');});
 it('still refuses mismatched derived DNS question',async()=>{stub('SPF');await expect(handleEmailSecurity({domain:'google.com',record_type:'DMARC'})).rejects.toMatchObject({code:'EMAIL_DNS_SOURCES_DOWN'});});
 it('invalid domain and unknown params remain400 with no fetch',async()=>{vi.stubGlobal('fetch',vi.fn());await expect(handleEmailSecurity({domain:'https://google.com',record_type:'DMARC'})).rejects.toMatchObject({status:400});const app=buildServer();try{expect((await app.inject({method:'GET',url:'/v1/email-security?domain=google.com&record_type=DMARC&extra=1'})).statusCode).toBe(400);}finally{await app.close();}expect(fetch).not.toHaveBeenCalled();});
 it('logs the requested value bounded and JSON escaped',async()=>{stub('SPF');const spy=vi.spyOn(console,'info').mockImplementation(()=>{});const value='junk\n'+ 'x'.repeat(200);await handleEmailSecurity({domain:'google.com',record_type:value});const entry=JSON.parse(String(spy.mock.calls.find(c=>String(c[0]).includes('email_record_type'))![0]));expect(entry.value).toBe(value.slice(0,80));expect(entry.truncated).toBe(true);expect(String(spy.mock.calls[0][0]).split('\n')).toHaveLength(1);});
});
