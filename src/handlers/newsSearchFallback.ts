import {fetchIndex,parseHn,parsedSource,rankHn,type NewsItem,type FetchResult} from './newsSources';
import {headlineKeywords,anyHeadlineKeyword} from './newsHeadlineFeeds';
export const REFERENCE_INDEX='Encyclopedia search';
export const DISPATCH_INDEX='Community news search';
export function referenceSearchUrl(query:string,news=false){return `https://${news?'en.wikinews.org':'en.wikipedia.org'}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srprop=timestamp&format=json`;}
export function parseReferenceSearch(raw:string,news=false):(NewsItem & {date_kind:string})[]{
 const j=JSON.parse(raw);if(!j?.query||!Array.isArray(j.query.search))throw Error('invalid reference search');
 return j.query.search.map((item:any)=>{if(typeof item.title!=='string'||!item.title.trim()||!Number.isSafeInteger(item.pageid)||item.pageid<1||typeof item.timestamp!=='string'||!Number.isFinite(Date.parse(item.timestamp)))throw Error('invalid reference hit');return{index:news?DISPATCH_INDEX:REFERENCE_INDEX,title:item.title,url:`https://${news?'en.wikinews.org':'en.wikipedia.org'}/?curid=${item.pageid}`,points:null,published:new Date(item.timestamp).toISOString(),date_kind:'page revision time, not article publication'};});
}
export async function relaxedSearchHn(query:string,strictUrl:string,deadline:number,now:number){
 const initial=await fetchIndex(strictUrl,deadline);const parsed=parsedSource(initial,parseHn);const words=headlineKeywords(query);const cutoff=new Date(now-365*86400000).toISOString();
 const eligible=(items:NewsItem[])=>items.filter(i=>anyHeadlineKeyword(words,i.title)&&i.published>=cutoff&&Date.parse(i.published)<=now&&/^https?:\/\//.test(i.url));
 const exact=(parsed??[]).filter(i=>words.length>0&&words.every(w=>anyHeadlineKeyword([w],i.title))&&i.published>=new Date(now-7*86400000).toISOString()&&Date.parse(i.published)<=now&&/^https?:\/\//.test(i.url));
 const captures:{url:string;result:FetchResult}[]=[{url:strictUrl,result:initial}];
 if(exact.length||!words.length||Date.now()>=deadline)return {initial,exact:rankHn(exact),closest:[] as NewsItem[],captures};
 const base='https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=20&numericFilters='+encodeURIComponent('created_at_i>'+String(Math.floor(now/1000)-365*86400));
 const urls=[base+'&query='+encodeURIComponent(words.join(' '))+'&optionalWords='+encodeURIComponent(JSON.stringify(words)),base+'&query='+encodeURIComponent(words.slice(0,2).join(' '))];
 const wider=await Promise.all(urls.map(async url=>({url,result:await fetchIndex(url,deadline)})));captures.push(...wider);
 const unique=new Map<string,NewsItem>();for(const item of rankHn(wider.flatMap(c=>eligible(parsedSource(c.result,parseHn)??[]))))if(!unique.has(item.url))unique.set(item.url,item);
 return{initial,exact:[],closest:[...unique.values()],captures};
}
