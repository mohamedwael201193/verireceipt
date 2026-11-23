// Public read-only evidence replay. No wallet/key/payment imports here.
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {replayResearchDeskPublic} from '../src/researchPublicReplay.js';
const [file,specHash,...extra]=process.argv.slice(2);if(!file||!specHash||extra.length)throw new Error('Usage: judge-desk-packet.ts research-packet.json EXPECTED_SPEC_SHA256');
const path=resolve(file),packet=JSON.parse(readFileSync(path,'utf8'));
console.log('Historical public-evidence and local-primary-byte replay. No wallet, purchase, signature or file write.');
const result=await replayResearchDeskPublic(packet,specHash,id=>{if(!/^[a-z][a-z0-9_]{0,63}$/.test(id))throw new Error('unsafe fact id');return JSON.parse(readFileSync(join(dirname(path),`${id}-paid-response.json`),'utf8'));});
console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
