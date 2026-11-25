import{afterEach,expect,it,vi}from'vitest';import{readFileSync}from'node:fs';import{load}from'js-yaml';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import{buildServer}from'../src/server';import{FIELD_FORMAT,OUTPUT_MAPPING,readPath,valueMatchesFormat,reconcileShaped}from'../src/core/shapedFields';
const intent='GAME_RESULT_GENERAL',yaml=load(readFileSync('miner.yaml','utf8'))as any;
const raw=readFileSync('tests/fixtures/mlb-final/schedule-2026-10-24.json','utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('keeps unverified runtime available without registering its intent',()=>{expect(yaml.semantics.supported_intents).not.toContain(intent);expect(yaml.intent_mapping[intent]).toBeUndefined();expect(yaml.endpoints.some((e:any)=>e.path==='/v1/game-result')).toBe(false);});
it('real official final fixture replays all mapped fields through native route, never backfills scores from raw',async()=>{
 vi.stubGlobal('fetch',async(url:any)=>{if(String(url).startsWith('https://statsapi.mlb.com/'))return new Response(raw);throw Error('source outage');});
 const app=buildServer();try{const res=await app.inject({method:'GET',url:'/v1/game-result?game=Milwaukee%20Brewers%20vs%20Tampa%20Bay%20Rays%202026-10-24'});expect(res.statusCode).toBe(200);const out=res.json();expect(out.home_team).toBe('Milwaukee Brewers');expect(out.away_team).toBe('Tampa Bay Rays');expect(out.home_score).toBe(5);expect(out.away_score).toBe(4);expect(out.date).toBe('2026-10-24');for(const[field,mapping]of Object.entries(OUTPUT_MAPPING[intent]))expect(valueMatchesFormat(readPath(out,mapping.path),FIELD_FORMAT[intent][field],field),field).toBe(true);
 const shaped=reconcileShaped({intent,result:{},field_status:{home_score:'unavailable',away_score:'unavailable',home_team:'unavailable'}},out,{rawVerified:true});expect(shaped.home_score.value).toBeNull();expect(shaped.away_score.value).toBeNull();expect(shaped.home_team.value).toBe(out.home_team);
 }finally{await app.close();}
});
