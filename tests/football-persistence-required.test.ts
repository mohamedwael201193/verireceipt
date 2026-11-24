import {afterEach,it,expect,vi} from 'vitest';import {readFileSync} from 'node:fs';import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{throw new Error('storage unavailable')})}));
import {handleSportsScore} from '../src/handlers/sportsScore';afterEach(()=>vi.unstubAllGlobals());
it('football positive refuses to answer when receipt persistence fails',async()=>{
 vi.stubGlobal('fetch',async(u:unknown)=>{const s=String(u);return new Response(s.includes('raw.githubusercontent.com')?readFileSync(join(__dirname,'fixtures/sports-football',s.split('/').pop()!),'utf8'):s.includes('nhle')?'{"games":[]}':'{"dates":[]}')});
 await expect(handleSportsScore({game:'Arsenal vs Chelsea'})).rejects.toMatchObject({status:502,code:'RECEIPT_PERSIST_FAILED'});
});
