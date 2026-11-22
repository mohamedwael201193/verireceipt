import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{throw Error('reviewer simulated persistence failure')})}));
import {handleTokenHolders,setTokenHoldersFetchForTests} from '../src/handlers/tokenHolders';
afterEach(()=>setTokenHoldersFetchForTests(null));
it('must not serve verified answer after persistence fails',async()=>{setTokenHoldersFetchForTests(async()=>JSON.stringify({holders_count:'123',symbol:'USDC'}));await expect(handleTokenHolders({token:'USDC',chain:'ethereum'})).rejects.toBeDefined()});
