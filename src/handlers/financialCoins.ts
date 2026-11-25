// Fixed market identities, never inferred from an unverified ticker string.
export const FINANCIAL_COINS=[
 ['eth-ethereum','ETH','Ethereum'],['sol-solana','SOL','Solana'],
 ['doge-dogecoin','DOGE','Dogecoin'],['ada-cardano','ADA','Cardano'],['xrp-xrp','XRP','XRP'],['bnb-binance-coin','BNB','BNB'],
 ['usdt-tether','USDT','Tether'],['usdc-usd-coin','USDC','USDC'],['trx-tron','TRX','TRON'],['xmr-monero','XMR','Monero'],
 ['zec-zcash','ZEC','Zcash'],['link-chainlink','LINK','Chainlink'],['ltc-litecoin','LTC','Litecoin'],['avax-avalanche','AVAX','Avalanche'],['dot-polkadot','DOT','Polkadot'],
] as const;
export const FINANCIAL_COIN_IDS=new Set<string>(FINANCIAL_COINS.map(c=>c[0]));
export function financialCoin(asset:string){const upper=asset.toUpperCase();const aliases:Record<string,string>={"BINANCE COIN":"BNB","USD COIN":"USDC"};const key=aliases[upper]??upper;const row=FINANCIAL_COINS.find(c=>c[1]===key||c[2].toUpperCase()===key);return row?{id:row[0],symbol:row[1],name:row[2]}:undefined;}
