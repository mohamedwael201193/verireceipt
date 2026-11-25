import {fetchIndex,parsedSource,parseBbcRss,type FetchResult} from './newsSources';
const cache=new Map<string,{result:FetchResult;acquiredAt:string;expires:number}>();
const pending=new Map<string,Promise<{result:FetchResult;acquiredAt:string}>>();
export const BBC_CATEGORIES=['science_and_environment','technology','world','business','health'] as const;
export function resetHeadlineFeedsForTests(){cache.clear();pending.clear();}
export async function headlineFeed(category:string,deadline:number){
 const hit=cache.get(category);if(hit&&Date.now()<hit.expires)return hit;
 if(pending.has(category))return pending.get(category)!;
 const p=(async()=>{const result=await fetchIndex(`https://feeds.bbci.co.uk/news/${category}/rss.xml`,deadline);const acquiredAt=new Date().toISOString();if(parsedSource(result,parseBbcRss)!==null){if(cache.size>=5&&!cache.has(category))cache.delete(cache.keys().next().value!);cache.set(category,{result,acquiredAt,expires:Date.now()+60000});}return{result,acquiredAt};})();
 pending.set(category,p);try{return await p;}finally{pending.delete(category);}
}
export function headlineKeywords(topic:string){const stop=new Set(['the','a','an','and','or','of','on','in','at','to','for','with','from','is','are','news','latest','about']);return [...new Set(topic.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w&&!stop.has(w)))];}
export function anyHeadlineKeyword(words:string[],title:string){const hay=' '+title.toLowerCase().replace(/[^a-z0-9]+/g,' ')+' ';return words.some(w=>hay.includes(' '+w+' '));}
