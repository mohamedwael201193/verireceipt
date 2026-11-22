import {afterEach,it,expect,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {handleTokenHolders,setTokenHoldersFetchForTests} from '../src/handlers/tokenHolders';
import {TOKEN_CONTRACTS} from '../src/handlers/tokenContracts';
afterEach(()=>setTokenHoldersFetchForTests(null));
it('binds a complete display label to its explicit contract, no network',async()=>{let url='';setTokenHoldersFetchForTests(async u=>{url=u;return JSON.stringify({holders_count:'123',symbol:'USDC'})});const r=await handleTokenHolders({token:`USDC (${TOKEN_CONTRACTS.ethereum.USDC})`,chain:'ethereum'});expect(r.holders_count).toBe(123);expect(url.toLowerCase()).toContain(TOKEN_CONTRACTS.ethereum.USDC.toLowerCase())});
it('rejects a contradictory known label before fetching',async()=>{let fetched=false;setTokenHoldersFetchForTests(async()=>{fetched=true;return '{}'});await expect(handleTokenHolders({token:`USDC (${TOKEN_CONTRACTS.ethereum.WETH})`,chain:'ethereum'})).rejects.toMatchObject({code:'TOKEN_CONTRACT_MISMATCH'});expect(fetched).toBe(false)});
