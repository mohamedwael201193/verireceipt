import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveSlaHost,STATUSPAGES} from '../src/handlers/slaCompliance';
it.each([['GitHub','www.githubstatus.com'],['Git Hub','www.githubstatus.com'],['vercel.com','www.vercel-status.com'],['OpenAI API','status.openai.com'],['Cloudflare Inc','www.cloudflarestatus.com'],['Sentry.io','status.sentry.io'],['  VER CEL service  ','www.vercel-status.com']])('exact normalized binding %s', (name,host)=>{expect(resolveSlaHost(name)).toBe(host);});
it.each(['githubish','vercel.com.attacker','github-api','github/status','x github','status github','open ai labs','cloudflareish Inc','constructor','toString','__proto__','AWS','Google Cloud','Slack','Stripe','Heroku','zoom','datadog','pagerduty','linear','notion','supabase'])('near miss/unbound refuses %s',name=>{expect(resolveSlaHost(name)).toBeNull();});
it('every bound name and exact hostname maps to itself',()=>{for(const[name,host]of Object.entries(STATUSPAGES)){expect(resolveSlaHost(name)).toBe(host);expect(resolveSlaHost(host)).toBe(host);}expect(Object.keys(STATUSPAGES)).toHaveLength(19);});

it('twelve derived summary captures identify each newly bound host',()=>{for(const name of ['vercel','netlify','discord','dropbox','npm','figma','coinbase','shopify','sentry','mongodb','circleci','snowflake']){const host=STATUSPAGES[name];const d=JSON.parse(readFileSync(join(__dirname,'fixtures/sla-bindings',host+'.json'),'utf8'));expect(new URL(d.page.url).hostname).toBe(host);expect(Array.isArray(d.components)).toBe(true);}});
