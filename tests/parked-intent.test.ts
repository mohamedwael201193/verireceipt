import {vi,afterAll} from 'vitest';
import {rmSync} from 'node:fs';
const scratch=vi.hoisted(()=>{const fs=require('node:fs');const path=fs.mkdtempSync('/tmp/parked-intent-');process.env.SQLITE_PATH=path+'/receipts.sqlite';delete process.env.DATABASE_URL;return path;});
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
import {it,expect} from 'vitest';import {readFileSync,existsSync} from 'node:fs';import {buildServer} from '../src/server';import {FIELD_FORMAT} from '../src/core/shapedFields';
it('parked contract work has no production declaration or route',async()=>{const name='CONTRACT_OBLIGATION_AUDIT_GENERAL';for(const path of ['miner.yaml','src/server.ts','src/core/requestMetrics.ts','src/core/shapedFields.ts'])expect(readFileSync(path,'utf8')).not.toContain(name);expect(existsSync('src/handlers/contractObligationAudit.ts')).toBe(false);expect(FIELD_FORMAT).not.toHaveProperty(name);const app=buildServer();expect(app.hasRoute({method:'GET',url:'/v1/contract-obligation-audit'})).toBe(false);await app.close();});

it('parked test SQLite path stays confined',()=>{expect(process.env.SQLITE_PATH).toBe(scratch+'/receipts.sqlite');expect(process.env.DATABASE_URL).toBeUndefined();});
