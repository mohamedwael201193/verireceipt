// Closed network aliases only. Unknown networks remain unknown, never default.
export function liquidityChain(raw:string):string {
 const key=raw.trim().toLowerCase();
 const aliases:Record<string,string>={eth:'ethereum',mainnet:'ethereum','ethereum-mainnet':'ethereum','ethereum mainnet':'ethereum',arb:'arbitrum','arbitrum-one':'arbitrum','arbitrum one':'arbitrum',op:'optimism','optimism-mainnet':'optimism',matic:'polygon','polygon-pos':'polygon','bnb':'bsc','bnb smart chain':'bsc',avax:'avalanche','avalanche-c':'avalanche','base-mainnet':'base'};
 return Object.hasOwn(aliases,key)?aliases[key]:key;
}
export function liquidityPair(raw:string):string|null {
 const m=/^([A-Za-z0-9]{2,12})\s*[-/]\s*([A-Za-z0-9]{2,12})$/.exec(raw.trim());
 if(!m)return null;
 return m.slice(1).map(s=>s.toUpperCase()==='ETH'?'WETH':s.toUpperCase()).sort().join('/');
}
