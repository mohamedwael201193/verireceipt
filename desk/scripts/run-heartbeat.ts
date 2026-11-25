// One personal-agent heartbeat tick (mission issue #197, Route 1).
// Local operator CLI. Testnet only. Review this adapter before any paid run.
// Usage: run-heartbeat.ts WATCHES_JSON OUT_DIR
//   WATCHES_JSON: a Watch[] file (see examples/heartbeat-watches.example.json)
//   OUT_DIR: existing or new directory receiving memos.jsonl (0600)
// Secrets: DESK_SECRETS_FILE with private_key, DESK_PAYER_ADDRESS binding the
// payer; the shared ledger dir (DESK_LEDGER_DIR or desk/ledger) joins the
// cross-agent daily cap. The tick buys at most one primary + one optional
// cross-check call per stale watch and never acts on the world.
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateKeyToAccount} from 'viem/accounts';
import {privateDirectory,privateFile} from '../src/privateEvidence.js';
import {normalizePrivateKey,readSecret} from '../src/secrets.js';
import {spendLedgerFromFiles} from '../src/gate.js';
import {runHeartbeat,watchDefect,type Watch} from '../src/personalAgent.js';
const [watchesArg,out,...extra]=process.argv.slice(2);
if(!watchesArg||!out||extra.length)throw new Error('Usage: run-heartbeat.ts WATCHES_JSON OUT_DIR');
const watches=JSON.parse(readFileSync(watchesArg,'utf8')) as Watch[];
if(!Array.isArray(watches)||!watches.length)throw new Error('watches file must hold a non-empty Watch[]');
for(const w of watches){
 if(!w.id||!w.intent||!w.params||!w.field||!w.rule||!w.max_age_seconds||!w.rationale)throw new Error(`watch ${w.id??'?'} is missing a required field`);
 if(!['gte','lte','eq'].includes(w.rule.op))throw new Error(`watch ${w.id}: rule.op must be gte|lte|eq`);
 const defect=watchDefect(w);if(defect)throw new Error(`watch ${w.id}: ${defect}`);
}
const secrets=process.env.DESK_SECRETS_FILE;if(!secrets)throw new Error('DESK_SECRETS_FILE is required');
const expected=process.env.DESK_PAYER_ADDRESS?.toLowerCase();if(!expected||!/^0x[0-9a-f]{40}$/.test(expected))throw new Error('explicit DESK_PAYER_ADDRESS required');
const ledgerDir=resolve(process.env.DESK_LEDGER_DIR??join(dirname(fileURLToPath(import.meta.url)),'../ledger'));
const dir=resolve(out);privateDirectory(dir);privateDirectory(ledgerDir);
for(const name of ['purchases.jsonl','gate-runs.jsonl','benchmark-runs.jsonl','reservations.jsonl'])privateFile(join(ledgerDir,name));
const spend=spendLedgerFromFiles({reservationsFile:join(ledgerDir,'reservations.jsonl'),lockFile:join(ledgerDir,'spend.lock'),purchasesFile:join(ledgerDir,'purchases.jsonl'),runLedgerFiles:[join(ledgerDir,'gate-runs.jsonl'),join(ledgerDir,'benchmark-runs.jsonl')]});
try{lstatSync(join(ledgerDir,'spend.lock'));throw new Error('existing spend lock requires operator inspection');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const account=privateKeyToAccount(normalizePrivateKey(readSecret(secrets,'private_key')));if(account.address.toLowerCase()!==expected)throw new Error('payer binding mismatch');
const payer={address:account.address,signMessage:(message:string)=>account.signMessage({message})};
const memosFile=join(dir,'memos.jsonl');privateFile(memosFile);
const memos=await runHeartbeat(payer,watches,{spend,memosFile,log:(l)=>console.log(l)});
for(const m of memos)console.log(`${m.watch_id}: ${m.status}${m.result?` ${m.result} (rule ${m.rule_outcome})`:''}${m.reason?` - ${m.reason}`:''} · day cost ${m.day_cost_uusdc} μUSDC`);
