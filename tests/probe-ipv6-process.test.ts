import { describe,it,expect } from 'vitest';
import { spawnSync } from 'node:child_process';
describe('non-mocked isolated transport failure',()=>{
 it('survives a real unreachable IPv6 socket and reports failure',()=>{
  const source=`import {measureGet} from './src/handlers/ssrfGuard';
  (async()=>{try{await measureGet({url:'https://[2001:4860:ffff:ffff:ffff:ffff:ffff:ffff]/',hostname:'2001:4860:ffff:ffff:ffff:ffff:ffff:ffff',port:443,addresses:['2001:4860:ffff:ffff:ffff:ffff:ffff:ffff']},250,'VeriReceipt transport regression');console.log('CONNECTED');}catch(e){console.log('CONNECT_FAILURE');}await new Promise(r=>setTimeout(r,100));console.log('PROCESS_SURVIVED');})();`;
  const r=spawnSync(process.execPath,['--import','tsx','--eval',source],{encoding:'utf8',timeout:10000,cwd:process.cwd()});
  expect(r.status, r.stderr).toBe(0);expect(r.stdout).toContain('CONNECT_FAILURE');expect(r.stdout).toContain('PROCESS_SURVIVED');expect(r.stderr).not.toContain('Unhandled');
 });
});
