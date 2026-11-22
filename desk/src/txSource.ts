// Independently fetched chain-bound mined-TX evidence. No benchmark inputs,
// provider allowlist, inferred mainnet or absent-transaction answer.
import { formatEther, parseEther } from 'viem';
import { mainnet, base, arbitrum, optimism, polygon, sepolia, baseSepolia } from 'viem/chains';
import { CHAIN_RPCS } from '../../src/config/chains.js';
import { finishSource, object, readPrimaryJson, sourceCheck, sourceResult, type SourceOptions, type SourceVerification } from './sourceTypes.js';
const chains:Record<string,{id:number}>={ethereum:mainnet,base,arbitrum,optimism,polygon,sepolia,'base-sepolia':baseSepolia};
const aliases:Record<string,string>={eth:'ethereum',mainnet:'ethereum','ethereum mainnet':'ethereum','eth mainnet':'ethereum','1':'ethereum','eip155:1':'ethereum','arbitrum one':'arbitrum','arbitrum-one':'arbitrum',arb:'arbitrum','op mainnet':'optimism','op-mainnet':'optimism','polygon pos':'polygon','polygon-pos':'polygon',matic:'polygon'};
function chainName(value:string):string{let c=value.trim().toLowerCase().replace(/\s+/g,' ').replace(/^on /,'');return aliases[c]??c;}
const HASH=/^0x[0-9a-fA-F]{64}$/;
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
export interface TxContract{chain:string;chainId:number;hash:string;urls:string[]}
export function txContract(params:Record<string,string>):TxContract{
 let hash=(params.tx_hash??'').trim(),chain=params.chain?chainName(params.chain):'';
 const suffix=/^(0x[0-9a-fA-F]{64})\s+on\s+(.+)$/i.exec(hash);
 if(suffix){if(chain&&chain!==chainName(suffix[2]))throw new Error('conflicting explicit transaction chains');chain=chainName(suffix[2]);hash=suffix[1];}
 if(!HASH.test(hash))throw new Error('a strict transaction hash is required');
 if(!Object.hasOwn(chains,chain)||!Object.hasOwn(CHAIN_RPCS,chain))throw new Error('an explicit supported chain is required; no default');
 const urls=[...new Set(CHAIN_RPCS[chain])].slice(0,2);
 if(urls.length!==2||new Set(urls.map(url=>new URL(url).hostname)).size!==2||urls.some(url=>new URL(url).protocol!=='https:'))throw new Error('two distinct configured HTTPS RPC endpoints are required');
 return {chain,chainId:chains[chain].id,hash:hash.toLowerCase(),urls};
}
function quantity(value:unknown):bigint{
 if(typeof value!=='string'||!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value))throw new Error('noncanonical or invalid RPC hex quantity');return BigInt(value);
}
function block(value:unknown):number{
 const n=quantity(value);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('RPC block exceeds safe integer');return Number(n);
}
function sameHash(value:unknown,expected:string):boolean{return typeof value==='string'&&HASH.test(value)&&value.toLowerCase()===expected;}
function address(value:unknown):string|null{if(value===null)return null;if(typeof value!=='string'||!ADDRESS.test(value))throw new Error('invalid RPC address');return value.toLowerCase();}
interface Observation{block:number;blockHash:string;status:'confirmed'|'reverted';from:string;to:string|null;wei:string;l1Fee:string|null}
function minedObservation(rawTx:unknown,rawReceipt:unknown,c:TxContract):Observation{
 const tx=object(rawTx),receipt=object(rawReceipt);
 if(!sameHash(tx.hash,c.hash)||!sameHash(receipt.transactionHash,c.hash))throw new Error('RPC transaction hash mismatch');
 if(tx.chainId!==undefined&&quantity(tx.chainId)!==BigInt(c.chainId))throw new Error('transaction chainId mismatch');
 const height=block(receipt.blockNumber);
 if(block(tx.blockNumber)!==height)throw new Error('transaction and receipt block mismatch');
 if(typeof tx.blockHash!=='string'||!HASH.test(tx.blockHash)||!sameHash(receipt.blockHash,tx.blockHash.toLowerCase()))throw new Error('transaction and receipt block hash mismatch');
 const from=address(tx.from),to=address(tx.to);
 if(from===null||address(receipt.from)!==from||address(receipt.to)!==to)throw new Error('transaction and receipt address mismatch');
 let status:'confirmed'|'reverted';
 if(receipt.status!==undefined){const value=quantity(receipt.status);if(value!==0n&&value!==1n)throw new Error('invalid receipt status');status=value===1n?'confirmed':'reverted';}
 else if(c.chain==='ethereum'&&height<4370000&&typeof receipt.root==='string'&&HASH.test(receipt.root))status='confirmed';
 else throw new Error('missing supported mined receipt status');
 return {block:height,blockHash:tx.blockHash.toLowerCase(),status,from,to,wei:quantity(tx.value).toString(),l1Fee:receipt.l1Fee===undefined?null:quantity(receipt.l1Fee).toString()};
}
async function rpc(url:string,method:string,params:unknown[],id:number,r:SourceVerification,options:SourceOptions):Promise<unknown>{
 const requests=r.details.rpc_requests as unknown[];requests.push({url,method,params,id,source_index:r.sources.length});
 const response=await readPrimaryJson(url,r,options,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
 if(response.jsonrpc!=='2.0'||response.id!==id||response.error!==undefined||!Object.hasOwn(response,'result'))throw new Error('invalid or errored JSON-RPC envelope');
 return response.result;
}
function amountMatches(value:unknown,wei:string|null):boolean{
 if(wei===null)return false;
 if(typeof value==='number')return Number.isFinite(value)&&value>=0&&value===Number(formatEther(BigInt(wei)));
 return typeof value==='string'&&/^\d+(?:\.\d{1,18})?$/.test(value)&&parseEther(value)===BigInt(wei);
}
export async function verifyTxSource(input:{params:Record<string,string>;result:Record<string,unknown>},options:SourceOptions={}):Promise<SourceVerification>{
 const r=sourceResult();
 try{
  const c=txContract(input.params);r.details={contract_version:'tx-source-contract-v1',chain:c.chain,chain_id:c.chainId,tx_hash:c.hash,rpc_requests:[]};
  const observations:Observation[]=[];
  for(const url of c.urls){
   if(quantity(await rpc(url,'eth_chainId',[],1,r,options))!==BigInt(c.chainId))throw new Error('RPC chainId does not match explicitly requested chain');
   const tx=await rpc(url,'eth_getTransactionByHash',[c.hash],2,r,options);
   const receipt=await rpc(url,'eth_getTransactionReceipt',[c.hash],3,r,options);
   observations.push(minedObservation(tx,receipt,c));
  }
  if(JSON.stringify(observations[0])!==JSON.stringify(observations[1]))throw new Error('RPC observations disagree');
  const o=observations[0],p=input.result;
  sourceCheck(r,'TX identity',sameHash(p.tx_hash,c.hash)&&(p.chain===undefined||(typeof p.chain==='string'&&chainName(p.chain)===c.chain)),'returned hash and any chain claim must bind to the explicit chain contract');
  sourceCheck(r,'TX mined status',p.status===o.status,'paid status must match the mined receipt; pending/missing evidence cannot establish a block');
  sourceCheck(r,'TX block number',typeof p.block_number==='number'&&Number.isSafeInteger(p.block_number)&&p.block_number>=0&&p.block_number===o.block,'paid block must equal safe nonnegative receipt and transaction block numbers from both chain-bound RPC observations');
  sourceCheck(r,'TX optional claims',(p.from===undefined||address(p.from)===o.from)&&(p.to===undefined||address(p.to)===o.to)&&(p.value_eth===undefined||amountMatches(p.value_eth,o.wei))&&(p.l1_fee_eth===undefined||amountMatches(p.l1_fee_eth,o.l1Fee)),'returned address/value/L1-fee claims must also agree when present');
  r.details.primary_value=o.block;r.details.status=o.status;r.details.block_hash=o.blockHash;
 }catch(error){sourceCheck(r,'TX evidence available',false,error instanceof Error?error.message:'TX verification failed');}
 return finishSource(r);
}
