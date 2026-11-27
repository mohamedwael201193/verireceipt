// Round-7 logging pins: chain_class on the /v1/token-holders refusal line,
// and fixed upstream_http_class / has_holders_field labels on GeckoTerminal
// parse failures. Labels only, never input values or body text.
import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync,mkdtempSync} from 'node:fs';
process.env.SQLITE_PATH=mkdtempSync('/tmp/holder-logclass-')+'/r.sqlite';
import {handleTokenHolders,setTokenHoldersFetchForTests} from '../src/handlers/tokenHolders';
import {answerDiagnostics,sanitizeAnswerClass} from '../src/core/answerClass';
import {refusalParamClass} from '../src/core/refusalClass';
import {recordRequestCompletion} from '../src/core/requestMetrics';
const raw=readFileSync('tests/fixtures/holder-gecko/bsc-usdt.json','utf8'),data=JSON.parse(raw).data.attributes;
afterEach(()=>{setTokenHoldersFetchForTests(null);vi.unstubAllGlobals();vi.restoreAllMocks();});
it('refusalParamClass: token-holders carries token_class and chain_class, labels only',()=>{
 expect(refusalParamClass('/v1/token-holders','UNSUPPORTED_CHAIN',{token:'USDC',chain:'base'})).toEqual({token_class:'known_symbol',chain_class:'base'});
 expect(refusalParamClass('/v1/token-holders','UNSUPPORTED_CHAIN',{token:'USDC',chain:' Base '})).toEqual({token_class:'known_symbol',chain_class:'base'});
 expect(refusalParamClass('/v1/token-holders','X',{token:'USDC',chain:'narnia'})).toEqual({token_class:'known_symbol',chain_class:'other'});
 expect(refusalParamClass('/v1/token-holders','X',{token:'0x'+ 'a'.repeat(40)})).toEqual({token_class:'address',chain_class:'other'});
});
it('a 422 UNSUPPORTED_CHAIN logs both classes and no input text',()=>{
 const lines:string[]=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});
 recordRequestCompletion('/v1/token-holders',422,5,{query:{token:'Secret-Token-Zq31337',chain:'narnia'},errorCode:'UNSUPPORTED_CHAIN'});
 const r=lines.map(l=>JSON.parse(l)).filter(o=>o.event==='refusal_param_class');
 expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({intent:'TOKEN_HOLDER_COUNT_GENERAL',error_code:'UNSUPPORTED_CHAIN',token_class:'name_like',chain_class:'other'});
 const all=lines.join('\n');for(const bad of ['Secret','Zq31337','31337'])expect(all).not.toContain(bad);
});
const geckoBody=(attrs:Record<string,unknown>)=>JSON.stringify({data:{id:`bsc_${data.address}`,type:'token',attributes:{address:data.address,symbol:'USDT',...attrs}}});
it('a Gecko 200 with no holders field logs 200_bad_shape and has_holders_field false, never body text',async()=>{
 setTokenHoldersFetchForTests(async()=>geckoBody({}));
 const e=await handleTokenHolders({chain:'bsc',token:'USDT'}).catch(e=>e);
 expect(e.code).toBe('INDEXER_UNREACHABLE');
 expect(answerDiagnostics('TOKEN_HOLDER_COUNT_GENERAL',e).answerClass).toEqual({upstream_name:'geckoterminal',upstream_failure:'bad_payload',token_class:'symbol',upstream_http_class:'200_bad_shape',has_holders_field:false});
 expect(JSON.stringify(e)).not.toContain('holders');
});
it('a Gecko 200 whose holders field is stale logs 200_bad_shape and has_holders_field true',async()=>{
 setTokenHoldersFetchForTests(async()=>geckoBody({holders:{count:5,last_updated:'2020-01-01T00:00:00Z'}}));
 const e=await handleTokenHolders({chain:'bsc',token:'USDT'}).catch(e=>e);
 expect(e.code).toBe('INDEXER_UNREACHABLE');
 expect(answerDiagnostics('TOKEN_HOLDER_COUNT_GENERAL',e).answerClass).toEqual({upstream_name:'geckoterminal',upstream_failure:'bad_payload',token_class:'symbol',upstream_http_class:'200_bad_shape',has_holders_field:true});
});
it('a Gecko 5xx logs 5xx and keeps the numeric status',async()=>{
 setTokenHoldersFetchForTests(async()=>{throw Object.assign(new Error('HTTP 503'),{status:503});});
 const e=await handleTokenHolders({chain:'bsc',token:'USDT'}).catch(e=>e);
 expect(e.code).toBe('INDEXER_UNREACHABLE');
 expect(answerDiagnostics('TOKEN_HOLDER_COUNT_GENERAL',e).answerClass).toMatchObject({upstream_name:'geckoterminal',upstream_failure:'unreachable',upstream_http_status:503,upstream_http_class:'5xx'});
});
it('a Gecko timeout logs timeout',async()=>{
 setTokenHoldersFetchForTests(async()=>{throw Object.assign(new Error('budget'),{timeout:true});});
 const e=await handleTokenHolders({chain:'bsc',token:'USDT'}).catch(e=>e);
 expect(e.code).toBe('INDEXER_UNREACHABLE');
 expect(answerDiagnostics('TOKEN_HOLDER_COUNT_GENERAL',e).answerClass).toMatchObject({upstream_http_class:'timeout'});
 expect(answerDiagnostics('TOKEN_HOLDER_COUNT_GENERAL',e).answerClass).not.toHaveProperty('upstream_http_status');
});
it('sanitize: upstream_http_class is a closed enum and has_holders_field boolean-only',()=>{
 expect(sanitizeAnswerClass('TOKEN_HOLDER_COUNT_GENERAL',{token_class:'symbol',upstream_http_class:'4xx',has_holders_field:'yes'})).toEqual({token_class:'symbol'});
 expect(sanitizeAnswerClass('TOKEN_HOLDER_COUNT_GENERAL',{upstream_http_class:'200_bad_shape',has_holders_field:true})).toEqual({upstream_http_class:'200_bad_shape',has_holders_field:true});
});
