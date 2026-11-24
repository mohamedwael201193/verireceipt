// Templates contain selectors and declared analyst thresholds, never numeric
// observations. Freeze the resolved timestamp before the first purchase.
import type {ThesisSpec,Claim} from './researchDesk.js';
export function researchTemplate(id:'A'|'B'|'C',frozen_at:string):{spec:ThesisSpec;claims:Claim[]}{
 const base={version:'research-desk-v1' as const,network:'eip155:11155111' as const,frozen_at,budget_uusdc:'60000',max_call_uusdc:'10000' as const,max_escalations:1 as const};
 if(id==='A')return {
  spec:{...base,template:'onchain-valuation',question:'Is UNI Ethereum-contract implied valuation below the declared analyst ceiling, with protocol TVL context?',facts:[
   {id:'price',intent:'CRYPTO_PRICE_USD',params:{symbol:'UNI'},field:'price_usd',unit:'USD/token',max_age_seconds:900},
   {id:'supply',intent:'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL',params:{token:'UNI on ethereum'},field:'total_supply',unit:'token',max_age_seconds:1800},
   {id:'tvl',intent:'TVL_LOOKUP_GENERAL',params:{protocol:'uniswap'},field:'tvl_usd',unit:'USD',max_age_seconds:900},
  ],assumptions:[{id:'fdv_ceiling',value:'10000000000',unit:'USD',rationale:'Declared illustrative Ethereum-contract valuation ceiling, not aggregate economic FDV, a verified market forecast or investment recommendation.'}],calculations:[{id:'implied_fdv',op:'multiply',left:'price',right:'supply',unit:'USD'},{id:'fdv_to_tvl',op:'divide',left:'implied_fdv',right:'tvl',unit:'ratio'}]},
  claims:[{id:'fdv_below_ceiling',fact_refs:['price','supply'],assumption_refs:['fdv_ceiling'],calculation_ref:'implied_fdv',predicate:{left:'implied_fdv',op:'<',right:'fdv_ceiling'}},{id:'valuation_to_tvl_context',fact_refs:['price','supply','tvl'],assumption_refs:[],calculation_ref:'fdv_to_tvl'}],
 };
 if(id==='C')return {
  spec:{...base,template:'private-mark',question:'Does Ares Capital Corp (ARCC, CIK 1287750) meet the declared disclosure-cadence floor for calendar 2026, with share-price and latest-available US unemployment context?',facts:[
   {id:'stock',intent:'STOCK_PRICE_US_EQUITY',params:{ticker:'ARCC'},field:'price_usd',unit:'USD/share',max_age_seconds:4*86400},
   {id:'filings',intent:'REGULATORY_FILING_MONITOR_GENERAL',params:{entity:'Form 10-Q filings by Ares Capital Corp (CIK 1287750)',period:'2026'},field:'filing_count',unit:'filings',max_age_seconds:86400},
   // No fixed year: the miner answers with its latest available
   // annual figure, so the context never silently goes stale.
   {id:'unemployment',intent:'MACRO_ECONOMIC_INDICATOR_GENERAL',params:{indicator:'unemployment rate',country:'US'},field:'rate_pct',unit:'percent',max_age_seconds:86400},
  ],assumptions:[{id:'disclosure_floor',value:'3',unit:'filings',rationale:'Declared analyst disclosure-cadence floor for a calendar year of quarterly reporting; not a forecast, valuation or investment recommendation.'}],calculations:[]},
  claims:[{id:'disclosure_floor_met',fact_refs:['filings'],assumption_refs:['disclosure_floor'],predicate:{left:'filings',op:'>=',right:'disclosure_floor'}},{id:'share_price_context',fact_refs:['stock'],assumption_refs:[]},{id:'unemployment_context',fact_refs:['unemployment'],assumption_refs:[]}],
 };
 return {
  spec:{...base,template:'issuer-macro',question:'Did Tesla file at least the declared number of Form 10-Qs in calendar 2024, with share-price and US unemployment context?',facts:[
   {id:'stock',intent:'STOCK_PRICE_US_EQUITY',params:{ticker:'TSLA'},field:'price_usd',unit:'USD/share',max_age_seconds:4*86400},
   {id:'filings',intent:'REGULATORY_FILING_MONITOR_GENERAL',params:{entity:'Form 10-Q filings by Tesla Inc (CIK 1318605)',period:'2024'},field:'filing_count',unit:'filings',max_age_seconds:86400},
   {id:'unemployment',intent:'MACRO_ECONOMIC_INDICATOR_GENERAL',params:{indicator:'unemployment rate',country:'US',year:'2024'},field:'rate_pct',unit:'percent',max_age_seconds:86400},
  ],assumptions:[{id:'filing_floor',value:'3',unit:'filings',rationale:'Declared analyst count threshold for a calendar year; not a forecast or filing-content review.'}],calculations:[]},
  claims:[{id:'filing_threshold',fact_refs:['filings'],assumption_refs:['filing_floor'],predicate:{left:'filings',op:'>=',right:'filing_floor'}},{id:'share_price_context',fact_refs:['stock'],assumption_refs:[]},{id:'unemployment_context',fact_refs:['unemployment'],assumption_refs:[]}],
 };
}
