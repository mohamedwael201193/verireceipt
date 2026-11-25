import {afterEach,expect,it,vi} from 'vitest';import {readFileSync} from 'node:fs';import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));vi.mock('../src/handlers/hashContext',()=>({hashContext:vi.fn(()=>({})),mhrContext:vi.fn(async()=>({status:'unavailable'}))}));
import {parseHashlookupBody,handleMalwareHash} from '../src/handlers/malwareHash';import {saveReceipt} from '../src/core/storage';import {mhrContext} from '../src/handlers/hashContext';
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
const file=(name:string)=>readFileSync(join(__dirname,'fixtures/malware-hash',name),'utf8');const eicar=file('eicar-sha256.json'),empty=file('empty-sha256.json'),md5=file('eicar-md5.json');
const key=JSON.parse(eicar)['SHA-256'].toLowerCase();
it('binds real recorded MD5, SHA1 and SHA256 identities case-insensitively',()=>{expect(parseHashlookupBody(eicar,'sha256',key.toUpperCase())).toBe('flagged');expect(parseHashlookupBody(eicar,'sha1',JSON.parse(eicar)['SHA-1'].toLowerCase())).toBe('flagged');expect(parseHashlookupBody(md5,'md5',JSON.parse(md5).MD5.toLowerCase())).toBe('flagged');expect(parseHashlookupBody(empty,'sha256',JSON.parse(empty)['SHA-256'])).toBe('known');});
it.each(['MD5','SHA-1','SHA-256'])('binds specifically the queried %s identity',field=>{
 const kind=({'MD5':'md5','SHA-1':'sha1','SHA-256':'sha256'} as const)[field as 'MD5'|'SHA-1'|'SHA-256'];const b=JSON.parse(eicar),wanted=b[field];b[field]='0'.repeat(wanted.length);expect(()=>parseHashlookupBody(JSON.stringify(b),kind,wanted)).toThrow();delete b[field];expect(()=>parseHashlookupBody(JSON.stringify(b),kind,wanted)).toThrow();
});
it.each(['null','[]','{}','true','1','"text"','not json'])('refuses200 body with no bound file identity %s',body=>{expect(()=>parseHashlookupBody(body,'sha256',key)).toThrow();});
it.each([false,true,0,1,null,{},[],['source']])('rejects malformed malicious flag %j, never truthy coercion',flag=>{const b=JSON.parse(eicar);b.KnownMalicious=flag;expect(()=>parseHashlookupBody(JSON.stringify(b),'sha256',key)).toThrow();});
it('missing/empty flag means known without flagged source, not legitimacy',async()=>{
 const b=JSON.parse(empty);b.KnownMalicious='   ';expect(parseHashlookupBody(JSON.stringify(b),'sha256',b['SHA-256'])).toBe('known');delete b.KnownMalicious;expect(parseHashlookupBody(JSON.stringify(b),'sha256',b['SHA-256'])).toBe('known');vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(b)));const r=await handleMalwareHash({indicator:b['SHA-256']});expect(r.malicious).toBe(false);expect(r.answer).toContain('presence does not establish');expect(r.answer).not.toContain('a known legitimate file');
});
it('mismatched200refuses before enrichment or persistence',async()=>{vi.stubGlobal('fetch',async()=>new Response(empty));await expect(handleMalwareHash({indicator:key})).rejects.toMatchObject({status:502,code:'HASHLOOKUP_MALFORMED'});expect(saveReceipt).not.toHaveBeenCalled();expect(mhrContext).not.toHaveBeenCalled();});
it('identity fields cannot be whitespace-padded or nonstring',()=>{const b=JSON.parse(eicar);for(const v of [' '+key,key+' ',123,null]){b['SHA-256']=v;expect(()=>parseHashlookupBody(JSON.stringify(b),'sha256',key)).toThrow();}});
