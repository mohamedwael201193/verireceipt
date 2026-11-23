import {readPublicBody} from '../core/publicSource';
import {COINGECKO_APPROVAL} from './financeWired';
import {TOKEN_CONTRACTS} from './tokenContracts';
const ASSETS:Record<string,string>={USDC:'usd-coin',USDT:'tether',DAI:'dai'};
export function aggregateAssetId(symbol:string):string|undefined{return ASSETS[symbol.toUpperCase()];}
export async function assetSupply(symbol:string) {
 const id=aggregateAssetId(symbol);if(!id)throw new Error('unsupported aggregate identity');
 const url='https://api.coingecko.com/api/v3/coins/'+id+'?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false';
 const body=await readPublicBody(url,500000,2500);const j=JSON.parse(body.raw);
 const supply=j.market_data?.total_supply;
 const updated=Date.parse(j.last_updated);const now=Date.now();
 if(j.id!==id||typeof j.symbol!=='string'||j.symbol.toUpperCase()!==symbol.toUpperCase()||typeof j.platforms?.ethereum!=='string'||j.platforms.ethereum.toLowerCase()!==TOKEN_CONTRACTS.ethereum[symbol.toUpperCase()]?.toLowerCase())throw new Error('aggregate asset identity mismatch');
 if(typeof supply!=='number'||!Number.isFinite(supply)||supply<=0||!Number.isFinite(updated)||now-updated>300000||updated>now+30000)throw new Error('aggregate supply missing/stale');
 return {total_supply:supply,asset_id:id,source_url:url,source_updated_at:j.last_updated,fetched_at:body.fetchedAt,raw_body:body.raw,
  scope:'CoinGecko provider-reported asset total; not an independently summed or audited all-chain supply; do not add bridged/wrapped token supplies',
  attribution:'Powered by CoinGecko',terms:{url:COINGECKO_APPROVAL.termsUrl,checked_at:'2026-11-23',commercial_use_confirmed:false,redistribution_confirmed:false,owner_terms_risk_accepted:true,source_reference:COINGECKO_APPROVAL.ownerRiskAcceptance?.sourceReference,accepted_at:COINGECKO_APPROVAL.ownerRiskAcceptance?.acceptedAt}};
}
