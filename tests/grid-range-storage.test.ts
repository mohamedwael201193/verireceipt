import {afterAll,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
const scratch=mkdtempSync('/tmp/grid-range-');process.env.SQLITE_PATH=scratch+'/range.sqlite';delete process.env.DATABASE_URL;
import {getGridRange,saveGridPrice,closeStorage} from '../src/core/storage';
afterAll(async()=>{await closeStorage();rmSync(scratch,{recursive:true,force:true});});
it('per-zone range is empty before writes and does not mix another zone',async()=>{
 expect(await getGridRange('EE')).toEqual({oldest:null,newest:null});
 await saveGridPrice('EE','2026-11-01T12:00:00.000Z',1,'Elering EE','2026-11-02T00:00:00.000Z');
 await saveGridPrice('EE','2026-11-01T12:30:00.000Z',1,'Elering EE','2026-11-02T00:00:00.000Z');
 await saveGridPrice('FI','2026-10-01T12:30:00.000Z',1,'Elering FI','2026-11-02T00:00:00.000Z');
 expect(await getGridRange('EE')).toEqual({oldest:'2026-11-01T12:00:00.000Z',newest:'2026-11-01T12:30:00.000Z'});
 expect(await getGridRange("EE' OR 1=1 --")).toEqual({oldest:null,newest:null});
});
