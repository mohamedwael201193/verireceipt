import {searchGleifVendor} from './gleifRegistry';
import {handleSanctionsScreen} from './sanctionsScreening';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {upstreamUnavailable} from '../core/errors';
export async function vendorNameChecks(vendor:string,vatInput?:'missing_country_prefix'|'malformed'):Promise<Record<string,unknown>> {
 const [registry,screen]=await Promise.allSettled([searchGleifVendor(vendor),handleSanctionsScreen({name:vendor})]);
 // A failed subordinate receipt is never laundered into an apparently checked result.
 if(screen.status==='rejected'&&screen.reason?.code==='RECEIPT_PERSIST_FAILED')throw screen.reason;
 const gleif=registry.status==='fulfilled'?registry.value:{status:'unavailable',scope:'GLEIF name search failed; no registry facts asserted'};
 const sanctions=screen.status==='fulfilled'?{status:'completed',matched:screen.value.matched,matches:screen.value.matches,lists:screen.value.lists,match_score:screen.value.match_score,receipt:screen.value.receipt,scope:'Name similarity only; not identity confirmation or legal clearance. OFAC SDN and UN lists only.'}:{status:'unavailable',matched:null,scope:'Sanctions sources unavailable; no clearance asserted'};
 const vatNotice=vatInput==='missing_country_prefix'?'vat_number had no country prefix, so no VIES lookup was made':vatInput==='malformed'?'vat_number was malformed, so no VIES lookup was made':'No VAT number was supplied, so VAT validity is unknown (valid:null)';
 const evidence=JSON.stringify({...(vatInput?{vat_input_status:vatInput,vat_notice:vatNotice,vies_lookup_made:false}:{}),vendor,vat_number:null,valid:null,gleif,sanctions,scope:'Name-only research; does not validate registration, VAT, identity, solvency or honesty'});
 const receipt=makeReceipt('VENDOR_VERIFY_GENERAL','https://api.gleif.org/api/v1/lei-records',evidence,'name-only research; exact GLEIF body when available plus sanctions evidence receipt; not VAT verification');
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','vendor research evidence could not be stored');}
 return envelope('VENDOR_VERIFY_GENERAL',{vendor,vat_number:null,valid:null,gleif,sanctions,checks_completed:[registry.status==='fulfilled'?'gleif':null,screen.status==='fulfilled'?'sanctions':null].filter(Boolean)},receipt,{answer:`Name-only vendor research for ${vendor}. GLEIF search ${registry.status==='fulfilled'?'completed; candidates are not confirmed identities':'unavailable'}. Sanctions screening ${screen.status==='fulfilled'?'completed; name similarity is not identity confirmation or legal clearance':'unavailable; no clearance asserted'}. ${vatNotice}${vatInput?'. VAT validity is unknown (valid:null)':''}. No registration validity, solvency or honesty is asserted.`,verdict:'no_data',confidence:0,source:'GLEIF legal-name search and OFAC/UN screening attempted; per-check completion and evidence disclosed'});
}
