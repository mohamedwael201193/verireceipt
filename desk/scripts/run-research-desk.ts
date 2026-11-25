// Local operator CLI. Testnet only. Review this adapter before any paid run.
import {privateDirectory,privateFile} from '../src/privateEvidence.js';
import {existsSync,lstatSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateKeyToAccount} from 'viem/accounts';
import {normalizePrivateKey,readSecret} from '../src/secrets.js';
import {spendLedgerFromFiles} from '../src/gate.js';
import {liveResearchAdapter,localResearchStore} from '../src/researchLiveAdapter.js';
import {runResearchDesk} from '../src/researchDeskRunner.js';
import {researchTemplate} from '../src/researchTemplates.js';
const [id,out,...extra]=process.argv.slice(2);
if(!['A','C','D','E','F','G','H'].includes(id)||!out||extra.length)throw new Error('Usage: run-research-desk.ts A|C|D|E|F|G|H NEW_PRIVATE_OUTPUT_DIRECTORY');
const secrets=process.env.DESK_SECRETS_FILE;if(!secrets)throw new Error('DESK_SECRETS_FILE is required');
const expected=process.env.DESK_PAYER_ADDRESS?.toLowerCase();if(!expected||!/^0x[0-9a-f]{40}$/.test(expected))throw new Error('explicit DESK_PAYER_ADDRESS required');
const ledgerDir=resolve(process.env.DESK_LEDGER_DIR??join(dirname(fileURLToPath(import.meta.url)),'../ledger'));
const dir=resolve(out);if(out!==dir)throw new Error('output path must be absolute canonical');if(existsSync(dir))throw new Error('output directory must be new');privateDirectory(dir);privateDirectory(ledgerDir);
for(const name of ['purchases.jsonl','gate-runs.jsonl','benchmark-runs.jsonl','reservations.jsonl'])privateFile(join(ledgerDir,name));
const run_ledger=join(ledgerDir,'research-desk-runs.jsonl');privateFile(run_ledger);
const spend=spendLedgerFromFiles({reservationsFile:join(ledgerDir,'reservations.jsonl'),lockFile:join(ledgerDir,'spend.lock'),purchasesFile:join(ledgerDir,'purchases.jsonl'),runLedgerFiles:[join(ledgerDir,'gate-runs.jsonl'),join(ledgerDir,'benchmark-runs.jsonl'),run_ledger]});
try{lstatSync(join(ledgerDir,'spend.lock'));throw new Error('existing spend lock requires operator inspection');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const account=privateKeyToAccount(normalizePrivateKey(readSecret(secrets,'private_key')));if(account.address.toLowerCase()!==expected)throw new Error('payer binding mismatch');
const payer={address:account.address,signMessage:(message:string)=>account.signMessage({message})};
// Template G pins a finalized block as a selector: resolve it from chain
// state immediately before the first purchase, exactly like frozen_at.
let pinned_block:string|undefined;
if(id==='G'){
 const {CHAIN_RPCS}=await import('../../src/config/chains.js');
 const r=await fetch(CHAIN_RPCS.ethereum[0],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['finalized',false]}),signal:AbortSignal.timeout(15000)});
 const j=await r.json() as {result?:{number?:string}};const n=j?.result?.number;
 if(typeof n!=='string'||!/^0x[0-9a-fA-F]+$/.test(n))throw new Error('finalized block unavailable for template G');
 pinned_block=BigInt(n).toString(10);
}
// Template H pins the current Bitcoin tip as a selector: resolve it from
// the keyless mempool.space tip endpoint immediately before the first
// purchase, the same freeze pattern as template G's finalized block. The
// handler serves the weekly-series basis at the tip and the disclosed
// single-block basis below it; the independent primary mirrors both.
if(id==='H'){
 const r=await fetch('https://mempool.space/api/blocks/tip/height',{signal:AbortSignal.timeout(15000)});
 const tipText=(await r.text()).trim();
 if(!/^\d+$/.test(tipText)||BigInt(tipText)<=0n||BigInt(tipText)>100000000n)throw new Error('Bitcoin tip unavailable for template H');
 pinned_block=BigInt(tipText).toString(10);
}
const {spec,claims}=researchTemplate(id as 'A'|'B'|'C'|'D'|'E'|'F'|'G'|'H',new Date().toISOString(),pinned_block);
const result=await runResearchDesk(spec,claims,liveResearchAdapter({payer,spend,evidence_dir:dir,run_ledger,secUserAgent:process.env.SEC_USER_AGENT}),localResearchStore(dir));
console.log(JSON.stringify({outcome:result.outcome,spec_hash:result.spec_hash,packet_hash:result.packet_hash,reasons:result.reasons,accounting:result.accounting,metrics:result.metrics,receipts:result.observations.map(o=>({fact_id:o.fact_id,receipt_hash:o.receipt_hash,signal_hash:o.signal_hash,supply:o.supply,integrity:o.integrity_level})),onchain_transactions:[]},null,2));
process.exitCode=result.outcome==='READY'?0:1;
