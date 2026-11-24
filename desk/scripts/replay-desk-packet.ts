// Offline reproducibility only. No network, signer, wallet or key access.
import {readFileSync} from 'node:fs';
import {replayPacket,type ResearchPacket} from '../src/researchDesk.js';
const [file,expectedSpecHash,...extra]=process.argv.slice(2);
if(!file||!expectedSpecHash||extra.length)throw new Error('Usage: replay-desk-packet.ts research-packet.json EXPECTED_FROZEN_SPEC_SHA256');
const packet=JSON.parse(readFileSync(file,'utf8')) as ResearchPacket;
const result=replayPacket(packet,expectedSpecHash);
console.log('Offline packet replay. Checks stored source-byte digests and calculations at historical completion time.');
console.log('Not a live receipt check, source-origin authentication, or settlement proof.');
console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
