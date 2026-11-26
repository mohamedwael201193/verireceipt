import {catalog} from '../data/wdiCatalog';
// Fixed public WDI catalog only. Diagnostics never retain raw input or names.
const noise=new Set(['the','a','an','and','or','of','in','for','to','by','with','is','what','please','show','me','latest','current','annual','yearly','indicator','indicators','data','value','statistic','rate','percent','percentage']);
function tokens(input:string){return [...new Set(input.toLowerCase().replace(/[^a-z0-9]+/g,' ').split(/\s+/).filter(w=>w.length>1&&!noise.has(w)))];}
const indexed=catalog.map(row=>({...row,words:tokens(row.name)}));
/** Ranked lexical leads only, not a claim of semantic equivalence or eligibility. */
export function macroCandidateIds(input:string):string[]{
 if(input.length>1024)return [];
 const wanted=tokens(input);if(!wanted.length)return [];
 return indexed.map(row=>{const overlap=wanted.filter(w=>row.words.includes(w)).length;return{id:row.id,overlap,ratio:overlap/Math.max(wanted.length,row.words.length)};}).filter(row=>row.overlap>0).sort((a,b)=>b.overlap-a.overlap||b.ratio-a.ratio||a.id.localeCompare(b.id)).slice(0,3).map(row=>row.id);
}
