import {afterEach,it,expect,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {handleTokenHolders,setTokenHoldersFetchForTests} from '../src/handlers/tokenHolders';
import {TOKEN_CONTRACTS} from '../src/handlers/tokenContracts';
afterEach(()=>{setTokenHoldersFetchForTests(null);vi.restoreAllMocks();vi.useRealTimers();});
it('binds a complete display label to its explicit contract, no network',async()=>{let url='';setTokenHoldersFetchForTests(async u=>{url=u;return JSON.stringify({holders_count:'123',symbol:'USDC',address_hash:TOKEN_CONTRACTS.ethereum.USDC,type:'ERC-20'})});const r=await handleTokenHolders({token:`USDC (${TOKEN_CONTRACTS.ethereum.USDC})`,chain:'ethereum'});expect(r.holders_count).toBe(123);expect(url.toLowerCase()).toContain(TOKEN_CONTRACTS.ethereum.USDC.toLowerCase())});
it('rejects a contradictory known label before fetching',async()=>{let fetched=false;setTokenHoldersFetchForTests(async()=>{fetched=true;return '{}'});await expect(handleTokenHolders({token:`USDC (${TOKEN_CONTRACTS.ethereum.WETH})`,chain:'ethereum'})).rejects.toMatchObject({code:'TOKEN_CONTRACT_MISMATCH'});expect(fetched).toBe(false)});

it('refuses empty/whitespace/coercible counts and wrong identity/type',async()=>{for(const patch of [{holders_count:''},{holders_count:' '},{holders_count:'1e2'},{holders_count:'0x10'},{holders_count:null},{address_hash:TOKEN_CONTRACTS.ethereum.WETH},{type:'ERC-721'},{type:null}]){setTokenHoldersFetchForTests(async()=>JSON.stringify({holders_count:'0',symbol:'USDC',address_hash:TOKEN_CONTRACTS.ethereum.USDC,type:'ERC-20',...patch}));await expect(handleTokenHolders({token:'USDC',chain:'ethereum'})).rejects.toMatchObject({code:'INDEXER_UNREACHABLE'})}});
it('accepts an actual integer zero with correct ERC-20 identity',async()=>{setTokenHoldersFetchForTests(async()=>JSON.stringify({holders_count:'0',symbol:'USDC',address_hash:TOKEN_CONTRACTS.ethereum.USDC,type:'ERC-20'}));expect((await handleTokenHolders({token:'USDC',chain:'ethereum'})).holders_count).toBe(0)});

it.each([null,'','   '])('symbol request refuses a missing indexer symbol %j',async(symbol)=>{
 setTokenHoldersFetchForTests(async()=>JSON.stringify({holders_count:'123',symbol,address_hash:TOKEN_CONTRACTS.ethereum.USDC,type:'ERC-20'}));
 await expect(handleTokenHolders({token:'USDC',chain:'ethereum'})).rejects.toMatchObject({code:'TOKEN_SYMBOL_MISMATCH'});
});
it('explicit contract may return a count with unknown symbol without pretending to identify it',async()=>{
 setTokenHoldersFetchForTests(async()=>JSON.stringify({holders_count:'123',symbol:null,address_hash:TOKEN_CONTRACTS.ethereum.USDC,type:'ERC-20'}));
 const out=await handleTokenHolders({token:TOKEN_CONTRACTS.ethereum.USDC,chain:'ethereum'});expect(out.holders_count).toBe(123);expect(out.token_symbol).toBe('unknown');
});

it('real Blockscout capture preserves exact raw receipt and acquisition as_of',async()=>{
 const {readFileSync}=await import('node:fs');const {join}=await import('node:path');const {saveReceipt}=await import('../src/core/storage');const {sha256Hex}=await import('../src/core/receipt');
 const raw=readFileSync(join(__dirname,'fixtures/holder-blockscout/ethereum-usdc.json'),'utf8');setTokenHoldersFetchForTests(async()=>raw);
 const out=await handleTokenHolders({token:'USDC',chain:'ethereum'});expect(out.holders_count).toBe(Number(JSON.parse(raw).holders_count));
 const calls=vi.mocked(saveReceipt).mock.calls;const [receipt,body]=calls[calls.length-1];expect(body).toBe(raw);expect(receipt.raw_response_sha256).toBe(sha256Hex(raw));expect(out.as_of).toBe(receipt.fetched_at);
});

it('Blockscout as_of uses acquisition time even when composition occurs later',async()=>{
 vi.useFakeTimers();const acquired='2026-11-24T00:00:00.000Z',later='2026-11-24T00:00:02.000Z';vi.setSystemTime(new Date(acquired));
 const raw=JSON.stringify({holders_count:'123',symbol:'USDC',address_hash:TOKEN_CONTRACTS.ethereum.USDC,type:'ERC-20'});
 const parse=JSON.parse;vi.spyOn(JSON,'parse').mockImplementation((...args:Parameters<typeof JSON.parse>)=>{const out=parse(...args);if(args[0]===raw)vi.setSystemTime(new Date(later));return out;});
 setTokenHoldersFetchForTests(async()=>raw);const out=await handleTokenHolders({token:'USDC',chain:'ethereum'});
 expect(new Date().toISOString()).toBe(later);expect(out.as_of).toBe(acquired);expect(out.as_of).not.toBe(later);expect((out.receipt as any).fetched_at).toBe(acquired);
});
