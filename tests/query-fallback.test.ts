import {it,expect,vi,afterEach,beforeEach} from 'vitest';
import {readFileSync,mkdtempSync} from 'node:fs';
process.env.SQLITE_PATH=mkdtempSync('/tmp/query-fallback-')+'/evidence.sqlite';
vi.mock('../src/core/storage',async(importOriginal)=>({...await importOriginal<typeof import('../src/core/storage')>(),saveReceipt:vi.fn(async()=>{})}));
vi.mock('node:dns/promises',()=>({lookup:vi.fn(async()=>{throw Error('synthetic DNS outage');})}));
import {handleVulnTriage,resetCveTransportForTests} from '../src/handlers/cveLookup';
import {handleIpGeolocation} from '../src/handlers/ipGeolocation';
import {handleTokenSupply} from '../src/handlers/tokenSupply';
import {handleTokenHolders} from '../src/handlers/tokenHolders';
import {handleEmailSecurity} from '../src/handlers/emailSecurity';
import {handleSsl} from '../src/handlers/sslVerification';
import {handleStormAlert} from '../src/handlers/stormAlert';
import {resetStormForecastForTests} from '../src/handlers/stormForecast';
import {queryFallback,firstHostname,firstIp} from '../src/core/queryFallback';
const fixture=(p:string)=>readFileSync(`tests/fixtures/${p}`,'utf8');
const clean=(o:any)=>{const {receipt,checked_at,...rest}=o;return rest;};
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-25T00:00:00Z'));});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();resetCveTransportForTests();resetStormForecastForTests();});
it('triage extracts a lowercase embedded CVE uppercase, not the first word',async()=>{vi.stubEnv('CVE_NVD_ENABLED','true');const f=vi.fn(async(u:any)=>new Response(fixture(String(u).includes('nist.gov')?'cve/cve-log4j-nvd.json':'cve/cve-log4j-mitre.json')));vi.stubGlobal('fetch',f);const declared=await handleVulnTriage({cve_id:'CVE-2021-44228'});resetCveTransportForTests();const alias=await handleVulnTriage({query:'triage cve-2021-44228 please'});expect(clean(alias)).toEqual(clean(declared));expect(f.mock.calls.every(([u])=>!String(u).includes('cve-2021-44228'))).toBe(true);});
it('IP query chooses first actual IP token and equals declared bytes',async()=>{vi.stubGlobal('fetch',async(u:any)=>new Response(fixture(String(u).includes('ipwho.is')?'ip-geo/ipwhois-1.1.1.1.json':'ip-geo/ip-api-1.1.1.1.json')));expect(clean(await handleIpGeolocation({query:'locate 1.1.1.1 please 8.8.8.8'}))).toEqual(clean(await handleIpGeolocation({ip:'1.1.1.1'})));expect(firstIp('locate [2606:4700:4700::1111] please')).toBe('2606:4700:4700::1111');});
it('supply trimmed query preserves whole token plus chain and matches recorded declared result',async()=>{const capture=JSON.parse(fixture('token-chain-supply/usdc-finalized.json'));vi.stubGlobal('fetch',async(u:any,o:any)=>{if(String(u).includes('api.coingecko.com'))return new Response(fixture('token-aggregate/usdc.json'));const request=JSON.parse(o.body),leg=capture.legs.find((l:any)=>l.url===String(u))??capture.legs[0];return new Response(leg.responses.find((r:any)=>r.request.params[0].data===request.params[0].data).raw);});expect(clean(await handleTokenSupply({query:' USDC on ethereum '}))).toEqual(clean(await handleTokenSupply({token:'USDC on ethereum'})));});
it('holders query preserves packed chain and matches recorded declared result',async()=>{vi.stubGlobal('fetch',async()=>new Response(fixture('holder-blockscout/ethereum-usdc.json')));const a=await handleTokenHolders({query:' USDC on ethereum '});const b=await handleTokenHolders({token:'USDC on ethereum'});expect(clean(a)).toEqual(clean(b));});
it('email query derives first hostname and explicit MX word with exact declared result',async()=>{vi.stubGlobal('fetch',async(u:any)=>new Response(fixture(String(u).includes('dns.google')?'email-security/dns-google-nodata.json':'email-security/dns-cloudflare-nodata-exact-accept.json')));expect(clean(await handleEmailSecurity({query:'check MX www.iana.org please'}))).toEqual(clean(await handleEmailSecurity({domain:'www.iana.org',record_type:'MX'})));});
it('SSL query extracts URL hostname rather than prose or path',async()=>{await expect(handleSsl({query:'check https://example.com/path please'})).rejects.toMatchObject({code:'TLS_DNS_UNAVAILABLE'});const {lookup}=await import('node:dns/promises');expect(lookup).toHaveBeenCalledWith('example.com',expect.anything());expect(firstHostname('check other.example then example.com')).toBe('other.example');});
it('storm query preserves complete location and existing window default',async()=>{vi.useFakeTimers();const capture=JSON.parse(fixture('storm-forecast/cairo.json'));vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));vi.stubGlobal('fetch',async(u:any)=>{if(String(u).startsWith('https://api.open-meteo.com/'))return new Response(JSON.stringify(capture));return new Response('{}',{status:404});});expect(clean(await handleStormAlert({query:'30.0444,31.2357'}))).toEqual(clean(await handleStormAlert({location:'30.0444,31.2357'})));});
it.each([['CVE',handleVulnTriage],['IP',handleIpGeolocation],['token supply',handleTokenSupply],['holders',handleTokenHolders],['email',handleEmailSecurity],['SSL',handleSsl],['storm',handleStormAlert]] as const)('%s without extractable input keeps400',async(_,fn)=>{const query=['token supply','holders'].includes(_)?{query:'',chain:'ethereum'}:{query:_==='storm'?'':'please check'};await expect(fn(query)).rejects.toMatchObject({status:400,code:'MISSING_PARAM'});});
it.each([
 ['CVE',handleVulnTriage,{cve_id:'bad'},'triage CVE-2021-44228','INVALID_CVE'],
 ['IP',handleIpGeolocation,{ip:'bad'},'1.1.1.1','INVALID_IP'],
 ['supply',handleTokenSupply,{token:'USDC on wrong-chain'},'DAI on ethereum','UNSUPPORTED_CHAIN'],
 ['holders',handleTokenHolders,{token:'USDC',chain:'wrong-chain'},'DAI on ethereum','UNSUPPORTED_CHAIN'],
 ['email',handleEmailSecurity,{domain:'bad/path',record_type:'MX'},'MX www.iana.org','INVALID_DOMAIN'],
 ['SSL',handleSsl,{host:'bad/path'},'example.com','INVALID_HOST'],
 ['storm',handleStormAlert,{location:'91,0'},'30.0444,31.2357','BAD_LOCATION'],
] as const)('%s declared key wins over conflicting query',async(_,fn,declared,query,code)=>{await expect(fn({...declared,query})).rejects.toMatchObject({status:_==='holders'?422:400,code});});
it('email does not invent a record type and still rejects other unknown keys',async()=>{await expect(handleEmailSecurity({query:'www.iana.org'})).rejects.toMatchObject({code:'MISSING_PARAM'});await expect(handleEmailSecurity({query:'MX www.iana.org',other:'x'})).rejects.toMatchObject({code:'UNKNOWN_PARAM'});});
it.each(['10.0.0.1','192.0.2.1','203.0.113.2','::1','2001:db8::1','ff02::1','::ffff:192.168.0.1','0:0:0:0:0:0:0:1'])('private/reserved %s is200-shaped no_data with no coordinates or fetch',async(ip)=>{const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleIpGeolocation({ip});expect(out.verdict).toBe('no_data');expect(out.answer).toContain('PRIVATE_IP');for(const key of ['latitude','longitude','lat','lon'])expect(out).not.toHaveProperty(key);expect(f).not.toHaveBeenCalled();});
it('fallback never treats empty declared input as permission to replace it',()=>{expect(queryFallback({ip:'',query:'1.1.1.1'},'ip',firstIp).ip).toBe('');});
it.each([
 [handleVulnTriage,{cve_id:'bad'},'INVALID_CVE'],[handleIpGeolocation,{ip:'bad'},'INVALID_IP'],
 [handleTokenSupply,{token:'USDC on wrong-chain'},'UNSUPPORTED_CHAIN'],[handleTokenHolders,{token:'USDC',chain:'wrong-chain'},'UNSUPPORTED_CHAIN'],
 [handleSsl,{host:'bad/path'},'INVALID_HOST'],[handleStormAlert,{location:'91,0'},'BAD_LOCATION'],
] as const)('existing ignored unknown keys stay ignored %#',async(fn,q,code)=>{await expect(fn({...q,other:'unchanged'})).rejects.toMatchObject({code});});
it('email route admits only new query alias, keeps other unknown-key refusal and private-IP route returns200',async()=>{const {buildServer}=await import('../src/server');const app=buildServer();try{expect((await app.inject({url:'/v1/email-security?query=www.iana.org'})).json().code).toBe('MISSING_PARAM');expect((await app.inject({url:'/v1/email-security?query=MX%20www.iana.org&other=x'})).json().code).toBe('UNKNOWN_PARAM');const privateIp=await app.inject({url:'/v1/ip-geolocation?query=locate%20192.0.2.1'});expect(privateIp.statusCode).toBe(200);expect(privateIp.json().verdict).toBe('no_data');expect(privateIp.json()).not.toHaveProperty('latitude');}finally{await app.close();}});
it('garbage IPv6 stays400 and first-IP extraction ignores punctuation',async()=>{for(const ip of ['::::','2001:db8:::1','ff::gg'])await expect(handleIpGeolocation({ip})).rejects.toMatchObject({status:400,code:'INVALID_IP'});expect(firstIp('Find (8.8.8.8), please')).toBe('8.8.8.8');});
it.each([{ip:'2606:4700:4700::1111%eth0'},{query:'locate 2606:4700:4700::1111%eth0 please'}])('zone-scoped IPv6 direct and query are400 without network %#',async(q)=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handleIpGeolocation(q)).rejects.toMatchObject({status:400,code:'INVALID_IP'});expect(f).not.toHaveBeenCalled();});
