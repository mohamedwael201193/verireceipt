import {answerDiagnostics} from "../src/core/answerClass";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleThreatIndicator,resetThreatIntelCacheForTests} from '../src/handlers/threatIntel';
const bodies:Record<string,string>={
 'spamhaus.org':'spamhaus-drop.txt','emergingthreats.net':'et-compromised.txt','blocklist.de':'blocklistde.txt','stamparm':'ipsum.txt',
 'Phishing.Database':'phishing-db.txt','hagezi':'hagezi-tif.txt','openphish':'openphish.txt',
};
beforeEach(()=>{resetThreatIntelCacheForTests({});vi.clearAllMocks();vi.stubGlobal('fetch',async(u:unknown)=>{
 const url=String(u),key=Object.keys(bodies).find(k=>url.includes(k));if(!key)throw new Error('uncaptured supplemental source');
 return new Response(readFileSync('tests/fixtures/threat-indicator/'+bodies[key],'utf8'));
});});
afterEach(()=>vi.unstubAllGlobals());
describe('applicable feed wording with unchanged actual excerpt replay',()=>{
 it.each([
  ['8.8.8.8',false,4,['Spamhaus DROP','stamparm ipsum'],['HaGeZi','OpenPhish']],
  ['185.220.101.4',true,4,['Spamhaus DROP','stamparm ipsum'],['HaGeZi','OpenPhish']],
  ['malware.wicar.org',true,2,['Phishing.Database','HaGeZi'],['Spamhaus','OpenPhish']],
  ['https://malware.wicar.org/path',true,3,['Phishing.Database','HaGeZi','OpenPhish'],['Spamhaus']],
  ['http://185.220.101.4/path',true,5,['Spamhaus','stamparm ipsum','OpenPhish'],['HaGeZi']],
 ] as const)('limits inventory for %s',async(indicator,malicious,count,include,exclude)=>{
  const out=await handleThreatIndicator({indicator});
  expect(answerDiagnostics("THREAT_INTELLIGENCE_INDICATOR",out).answerClass).toMatchObject({verdict:malicious?"malicious":"not_listed",feeds_available:count,feeds_applicable:count});
  const core=String(out.answer).split('Supplemental listed_by:')[0];
  expect(core).toContain(`${count} applicable feeds`);
  for(const term of include)expect(core).toContain(term);
  for(const term of exclude)expect(core).not.toContain(term);
  expect(out.malicious).toBe(malicious);expect(out.feeds_checked).toBe(7);
  if(!malicious)expect(core).toContain('NOT a clearance');
  const evidence=JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1] as string);
  expect(evidence.feeds).toHaveLength(7);expect(evidence.malicious).toBe(malicious);
  expect(evidence.matches).toEqual(out.matches);
  if(indicator==='185.220.101.4')expect(evidence.matches).toContainEqual({feed:'stamparm ipsum',matched_entry:'185.220.101.4'});
 });
});
