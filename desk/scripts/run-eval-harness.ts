// Cost-per-verified-verdict evaluation run (mission issue #198, Route 1).
// Local operator CLI. Testnet only. Review this adapter before any paid run.
// Usage: run-eval-harness.ts CASES_JSON OUT_DIR PROVIDER_ID [PROVIDER_ID...]
// Secrets: DESK_SECRETS_FILE with private_key, DESK_PAYER_ADDRESS binding the
// payer; the shared ledger dir (DESK_LEDGER_DIR or desk/ledger) joins the
// cross-agent daily cap. Buys at most cases x providers flat-rate calls and
// refuses before any spend when that exceeds the remaining shared cap.
import {existsSync,lstatSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateKeyToAccount} from 'viem/accounts';
import {privateDirectory,privateFile} from '../src/privateEvidence.js';
import {normalizePrivateKey,readSecret} from '../src/secrets.js';
import {committedExposureUusdc,spendLedgerFromFiles} from '../src/gate.js';
import {DESK_DAILY_CAP_UUSDC,ENGINE_URL,ONE_CALL_UUSDC} from '../src/constants.js';
import {EVAL_DAILY_CAP_UUSDC,EVAL_INTENT,loadEvalSet,resolveRegistry,runEvalHarness} from '../src/evalHarness.js';
const [casesFile,out,...providers]=process.argv.slice(2);
if(!casesFile||!out||!providers.length)throw new Error('Usage: run-eval-harness.ts CASES_JSON OUT_DIR PROVIDER_ID [PROVIDER_ID...]');
for(const p of providers)if(!/^\d+$/.test(p))throw new Error(`provider id ${p} must be numeric`);
if(new Set(providers).size!==providers.length)throw new Error(`duplicate provider ids: ${providers.join(', ')}`);
const set=loadEvalSet(casesFile);
const ledgerDir=resolve(process.env.DESK_LEDGER_DIR??join(dirname(fileURLToPath(import.meta.url)),'../ledger'));
const dir=resolve(out);if(out!==dir)throw new Error('output path must be absolute canonical');if(existsSync(dir))throw new Error('output directory must be new');privateDirectory(ledgerDir);
const runLedger=join(ledgerDir,'research-desk-runs.jsonl');
for(const name of ['purchases.jsonl','gate-runs.jsonl','benchmark-runs.jsonl','research-desk-runs.jsonl','reservations.jsonl'])privateFile(join(ledgerDir,name));
const spend=spendLedgerFromFiles({reservationsFile:join(ledgerDir,'reservations.jsonl'),lockFile:join(ledgerDir,'spend.lock'),purchasesFile:join(ledgerDir,'purchases.jsonl'),runLedgerFiles:[join(ledgerDir,'gate-runs.jsonl'),join(ledgerDir,'benchmark-runs.jsonl'),runLedger]});
try{lstatSync(join(ledgerDir,'spend.lock'));throw new Error('existing spend lock requires operator inspection');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
// Pre-flight budget check: refuse before reading secrets or signing anything
// when the full run cannot fit in the remaining shared daily cap.
const override=process.env.DESK_EVAL_CAP_UUSDC;if(override!==undefined&&!/^\d+$/.test(override))throw new Error('DESK_EVAL_CAP_UUSDC must be digits (micro-USDC)');
const requested=override===undefined?EVAL_DAILY_CAP_UUSDC:BigInt(override);
const cap=requested<DESK_DAILY_CAP_UUSDC?requested:DESK_DAILY_CAP_UUSDC;
const remaining=cap-committedExposureUusdc(spend,new Date());
const needed=BigInt(providers.length)*BigInt(set.cases.length)*ONE_CALL_UUSDC;
if(needed>remaining)throw new Error(`eval run needs ${needed} μUSDC (${providers.length} providers x ${set.cases.length} cases x ${ONE_CALL_UUSDC} μUSDC per call) but the remaining shared daily cap is ${remaining} μUSDC; refusing before any spend`);
privateDirectory(dir);
const secrets=process.env.DESK_SECRETS_FILE;if(!secrets)throw new Error('DESK_SECRETS_FILE is required');
const expected=process.env.DESK_PAYER_ADDRESS?.toLowerCase();if(!expected||!/^0x[0-9a-f]{40}$/.test(expected))throw new Error('explicit DESK_PAYER_ADDRESS required');
const account=privateKeyToAccount(normalizePrivateKey(readSecret(secrets,'private_key')));if(account.address.toLowerCase()!==expected)throw new Error('payer binding mismatch');
const payer={address:account.address,signMessage:(message:string)=>account.signMessage({message})};
// Resolve each provider's slug and evidence base URL from the live intent
// registry (read-only): the on-chain signal names the slug, not the
// catalogue id, and the evidence bytes live on the serving miner's host.
const intentRes=await fetch(`${ENGINE_URL}/v1/intents/${EVAL_INTENT}`,{redirect:'error',signal:AbortSignal.timeout(20000)});
if(!intentRes.ok)throw new Error(`intent registry HTTP ${intentRes.status}`);
const registry=resolveRegistry(await intentRes.json(),providers);

const report=await runEvalHarness(payer,set,providers,{spend,outDir:dir,dailyCapUusdc:cap,registry,log:(l)=>console.log(l)});
for(const p of report.providers)console.log(`${p.provider}: ${p.correct}/${p.cases_run} correct, ${p.unusable} unusable, ${p.skipped_budget} not run (budget), spend ${p.spend_uusdc} μUSDC (reserved ${p.reserved_uusdc}), cost per verified correct verdict ${p.cost_per_correct_uusdc??'n/a (no correct verdicts)'}`);
console.log(`total spend ${report.totals.spend_uusdc} μUSDC, reserved ${report.totals.reserved_uusdc} μUSDC (testnet)`);
