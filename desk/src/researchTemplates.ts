// Templates contain selectors and declared analyst thresholds, never numeric
// observations. Freeze the resolved timestamp before the first purchase.
import type {ThesisSpec,Claim} from './researchDesk.js';
export function researchTemplate(id:'A'|'B'|'C'|'D'|'E'|'F'|'G',frozen_at:string,pinned_block?:string):{spec:ThesisSpec;claims:Claim[]}{
 const base={version:'research-desk-v1' as const,network:'eip155:11155111' as const,frozen_at,budget_uusdc:'60000',max_call_uusdc:'10000' as const,max_escalations:1 as const};
 if(id==='G'){
  // The block is a selector resolved by the operator CLI from the current
  // finalized chain state immediately before the first purchase, never a
  // numeric observation: the paid response and the independent primary
  // both read the balance at exactly this pinned block.
  if(!pinned_block||!/^(0|[1-9]\d*)$/.test(pinned_block)||BigInt(pinned_block)<=0n)throw new Error('token-preflight requires an explicit pinned finalized block');
  return {
  spec:{...base,template:'token-preflight',question:'Does UNI (Uniswap governance token on Ethereum) pass the declared pre-purchase token-risk preflight for a simulated trade: holder count and UNI/WETH pool liquidity at or above the declared floors, and the pool contract native-coin balance equal to the declared expectation at the pinned block, with total supply context?',facts:[
   {id:'holders',intent:'TOKEN_HOLDER_COUNT_GENERAL',params:{token:'UNI',chain:'ethereum'},field:'holders_count',unit:'addresses',max_age_seconds:86400},
   // UNI/WETH 0.3% Uniswap v3 pool on Ethereum; pool identity is pinned
   // by address and the primary re-read checks the exact pool id.
   {id:'liquidity',intent:'LIQUIDITY_DEPTH_VERIFY_GENERAL',params:{pool:'0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801',chain:'ethereum'},field:'liquidity_usd',unit:'USD',max_age_seconds:1800},
   {id:'supply',intent:'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL',params:{token:'UNI on ethereum'},field:'total_supply',unit:'token',max_age_seconds:86400},
   // Native-coin balance of the pool contract itself at the pinned
   // block. A WETH-pool contract should hold no native coin; a nonzero
   // balance means trapped or deliberately sent coin and triggers review.
   {id:'contract_balance',intent:'ONCHAIN_METRIC_VERIFY_GENERAL',params:{address:'0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801',block:pinned_block,chain:'ethereum',metric:'balance'},field:'balance_gwei',unit:'gwei',max_age_seconds:1800},
  ],assumptions:[{id:'holders_floor',value:'100000',unit:'addresses',rationale:'Declared analyst pre-purchase floor for holder-distribution breadth; a screen threshold, not a market forecast or investment recommendation.'},{id:'liquidity_floor',value:'5000000',unit:'USD',rationale:'Declared analyst minimum DEX pool reserve depth for the pre-purchase liquidity screen; a screen threshold, not a market forecast or investment recommendation.'},{id:'expected_balance_gwei',value:'0',unit:'gwei',rationale:'Declared expectation that the WETH-pool contract holds no native coin at the pinned block; a nonzero balance is a review trigger, not proof of malice.'}],calculations:[]},
  claims:[{id:'holders_above_floor',fact_refs:['holders'],assumption_refs:['holders_floor'],predicate:{left:'holders',op:'>=',right:'holders_floor'}},{id:'liquidity_above_floor',fact_refs:['liquidity'],assumption_refs:['liquidity_floor'],predicate:{left:'liquidity',op:'>=',right:'liquidity_floor'}},{id:'balance_matches_declared',fact_refs:['contract_balance'],assumption_refs:['expected_balance_gwei'],predicate:{left:'contract_balance',op:'==',right:'expected_balance_gwei'}},{id:'supply_context',fact_refs:['supply'],assumption_refs:[]}],
  };
 }
 if(id==='A')return {
  spec:{...base,template:'onchain-valuation',question:'Is UNI Ethereum-contract implied valuation below the declared analyst ceiling, with protocol TVL context?',facts:[
   {id:'price',intent:'CRYPTO_PRICE_USD',params:{symbol:'UNI'},field:'price_usd',unit:'USD/token',max_age_seconds:900},
   {id:'supply',intent:'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL',params:{token:'UNI on ethereum'},field:'total_supply',unit:'token',max_age_seconds:1800},
   {id:'tvl',intent:'TVL_LOOKUP_GENERAL',params:{protocol:'uniswap'},field:'tvl_usd',unit:'USD',max_age_seconds:900},
  ],assumptions:[{id:'fdv_ceiling',value:'10000000000',unit:'USD',rationale:'Declared illustrative Ethereum-contract valuation ceiling, not aggregate economic FDV, a verified market forecast or investment recommendation.'}],calculations:[{id:'implied_fdv',op:'multiply',left:'price',right:'supply',unit:'USD'},{id:'fdv_to_tvl',op:'divide',left:'implied_fdv',right:'tvl',unit:'ratio'}]},
  claims:[{id:'fdv_below_ceiling',fact_refs:['price','supply'],assumption_refs:['fdv_ceiling'],calculation_ref:'implied_fdv',predicate:{left:'implied_fdv',op:'<',right:'fdv_ceiling'}},{id:'valuation_to_tvl_context',fact_refs:['price','supply','tvl'],assumption_refs:[],calculation_ref:'fdv_to_tvl'}],
 };
 if(id==='C')return {
  spec:{...base,template:'private-mark',question:'Does Ares Capital Corp (ARCC, CIK 1287750) meet the declared disclosure-cadence floor for calendar 2026, with share-price and 2025 US unemployment context?',facts:[
   {id:'stock',intent:'STOCK_PRICE_US_EQUITY',params:{ticker:'ARCC'},field:'price_usd',unit:'USD/share',max_age_seconds:4*86400},
   {id:'filings',intent:'REGULATORY_FILING_MONITOR_GENERAL',params:{entity:'Form 10-Q filings by Ares Capital Corp (CIK 1287750)',period:'2026'},field:'filing_count',unit:'filings',max_age_seconds:86400},
   // 2025 is the latest World Bank publication year (verified live
   // 2026-11-24, year_resolution latest_published_nonempty). An explicit
   // year is required: the desk's primary verification re-reads the
   // World Bank API for an exact year and refuses without one.
   {id:'unemployment',intent:'MACRO_ECONOMIC_INDICATOR_GENERAL',params:{indicator:'unemployment rate',country:'US',year:'2025'},field:'rate_pct',unit:'percent',max_age_seconds:86400},
  ],assumptions:[{id:'disclosure_floor',value:'3',unit:'filings',rationale:'Declared analyst disclosure-cadence floor for a calendar year of quarterly reporting; not a forecast, valuation or investment recommendation.'}],calculations:[]},
  claims:[{id:'disclosure_floor_met',fact_refs:['filings'],assumption_refs:['disclosure_floor'],predicate:{left:'filings',op:'>=',right:'disclosure_floor'}},{id:'share_price_context',fact_refs:['stock'],assumption_refs:[]},{id:'unemployment_context',fact_refs:['unemployment'],assumption_refs:[]}],
 };
 if(id==='D')return {
  spec:{...base,template:'diligence-pack',question:'Does Ares Capital Corporation pass the declared overnight counterparty-diligence rule: sanctions best-score below the declared screening threshold and at least the declared number of Form 10-Qs in calendar 2026?',facts:[
   {id:'sanctions',intent:'SANCTIONS_SCREENING_MATCH_GENERAL',params:{name:'Ares Capital Corporation'},field:'match_score',unit:'score',max_age_seconds:86400},
   {id:'filings',intent:'REGULATORY_FILING_MONITOR_GENERAL',params:{entity:'Form 10-Q filings by Ares Capital Corp (CIK 1287750)',period:'2026'},field:'filing_count',unit:'filings',max_age_seconds:86400},
  ],assumptions:[{id:'sanctions_threshold',value:'0.85',unit:'score',rationale:'Declared screening threshold equal to the miner\'s own published match threshold; a fuzzy name match is not identity confirmation and a non-match is not legal clearance.'},{id:'filing_floor',value:'1',unit:'filings',rationale:'Declared analyst minimum of one current-year quarterly filing for an overnight diligence pass; not a legal or compliance opinion.'}],calculations:[]},
  claims:[{id:'sanctions_below_threshold',fact_refs:['sanctions'],assumption_refs:['sanctions_threshold'],predicate:{left:'sanctions',op:'<',right:'sanctions_threshold'}},{id:'filings_present',fact_refs:['filings'],assumption_refs:['filing_floor'],predicate:{left:'filings',op:'>=',right:'filing_floor'}}],
 };
 if(id==='E')return {
  spec:{...base,template:'listing-risk',question:'Does UNI (Uniswap governance token on Ethereum) pass the declared listing-risk screen: holder count at or above the declared floor and UNI/WETH 0.3% pool liquidity at or above the declared floor, with total supply context?',facts:[
   {id:'holders',intent:'TOKEN_HOLDER_COUNT_GENERAL',params:{token:'UNI',chain:'ethereum'},field:'holders_count',unit:'addresses',max_age_seconds:86400},
   // UNI/WETH 0.3% Uniswap v3 pool on Ethereum; pool identity is pinned
   // by address and the primary re-read checks the exact pool id.
   {id:'liquidity',intent:'LIQUIDITY_DEPTH_VERIFY_GENERAL',params:{pool:'0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801',chain:'ethereum'},field:'liquidity_usd',unit:'USD',max_age_seconds:1800},
   {id:'supply',intent:'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL',params:{token:'UNI on ethereum'},field:'total_supply',unit:'token',max_age_seconds:86400},
  ],assumptions:[{id:'holders_floor',value:'100000',unit:'addresses',rationale:'Declared analyst listing-risk floor for holder-distribution breadth; a screen threshold, not a market forecast or investment recommendation.'},{id:'liquidity_floor',value:'5000000',unit:'USD',rationale:'Declared analyst minimum DEX pool reserve depth for the listing-liquidity screen; a screen threshold, not a market forecast or investment recommendation.'}],calculations:[]},
  claims:[{id:'holders_above_floor',fact_refs:['holders'],assumption_refs:['holders_floor'],predicate:{left:'holders',op:'>=',right:'holders_floor'}},{id:'liquidity_above_floor',fact_refs:['liquidity'],assumption_refs:['liquidity_floor'],predicate:{left:'liquidity',op:'>=',right:'liquidity_floor'}},{id:'supply_context',fact_refs:['supply'],assumption_refs:[]}],
 };
 if(id==='F')return {
  spec:{...base,template:'settlement-screen',question:'Does the declared payee pass the declared pre-settlement compliance screen for a simulated testnet treasury transfer: sanctions best-score below the declared screening threshold and TUSD attested reserves at or above the declared floor?',facts:[
   {id:'sanctions',intent:'SANCTIONS_SCREENING_MATCH_GENERAL',params:{name:'Ares Capital Corporation'},field:'match_score',unit:'score',max_age_seconds:86400},
   // TUSD Chainlink Proof-of-Reserve feed on ethereum, pinned by proxy
   // address in the miner's probed-live registry. The independent primary
   // re-read recomputes micro-units from the same feed at a pinned
   // finalized block over two chain-bound RPCs; a new attestation round
   // between the paid and independent reads fails closed.
   {id:'reserve',intent:'ASSET_RESERVE_ATTESTATION_GENERAL',params:{asset:'TUSD'},field:'attested_reserve',unit:'micro-units of the underlying asset',max_age_seconds:86400},
  ],assumptions:[{id:'sanctions_threshold',value:'0.85',unit:'score',rationale:'Declared screening threshold equal to the miner\'s own published match threshold; a fuzzy name match is not identity confirmation and a non-match is not legal clearance.'},{id:'reserve_floor',value:'100000000000000',unit:'micro-units of the underlying asset',rationale:'Declared treasury minimum attested reserve (100,000,000 whole units) for authorizing a simulated settlement; a screen threshold, not a solvency opinion or investment recommendation.'}],calculations:[]},
  claims:[{id:'sanctions_below_threshold',fact_refs:['sanctions'],assumption_refs:['sanctions_threshold'],predicate:{left:'sanctions',op:'<',right:'sanctions_threshold'}},{id:'reserve_above_floor',fact_refs:['reserve'],assumption_refs:['reserve_floor'],predicate:{left:'reserve',op:'>=',right:'reserve_floor'}}],
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
