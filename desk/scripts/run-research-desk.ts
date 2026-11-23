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
if(!['A','B'].includes(id)||!out||extra.length)throw new Error('Usage: run-research-desk.ts A|B NEW_PRIVATE_OUTPUT_DIRECTORY');
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
const {spec,claims}=researchTemplate(id as 'A'|'B',new Date().toISOString());
const result=await runResearchDesk(spec,claims,liveResearchAdapter({payer,spend,evidence_dir:dir,run_ledger,secUserAgent:process.env.SEC_USER_AGENT}),localResearchStore(dir));
console.log(JSON.stringify({outcome:result.outcome,spec_hash:result.spec_hash,packet_hash:result.packet_hash,reasons:result.reasons,accounting:result.accounting,metrics:result.metrics,receipts:result.observations.map(o=>({fact_id:o.fact_id,receipt_hash:o.receipt_hash,signal_hash:o.signal_hash,supply:o.supply,integrity:o.integrity_level})),onchain_transactions:[]},null,2));
process.exitCode=result.outcome==='READY'?0:1;
