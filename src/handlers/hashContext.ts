import{readPublicBody}from'../core/publicSource';
export function hashContext(body:string):Record<string,unknown>{
 const j=JSON.parse(body);const trust=j['hashlookup:trust'];
 const eicar=String(j.MD5??'').toLowerCase()==='44d88612fea8a8f36de82e1278abb02f';
 return{circl_trust_score:typeof trust==='number'&&trust>=0&&trust<=100?trust:null,file_name:typeof j.FileName==='string'?j.FileName:null,file_size:typeof j.FileSize==='string'?j.FileSize:null,package_context:j.ProductCode??null,source_database:j.db??null,is_known_test_sample:eicar,test_sample_context:eicar?'EICAR antivirus test sample, designed to trigger detection; not evidence of a real infection':null,circl_attribution:'CIRCL hashlookup (CC-BY): https://circl.lu/services/hashlookup/'};
}
export function parseMhr(raw:string,name:string):{detection_pct:number|null;last_seen:string|null}{
 const j=JSON.parse(raw);if(j.TC||![0,3].includes(j.Status)||j.Question?.[0]?.name?.replace(/\.$/,'').toLowerCase()!==name||j.Question?.[0]?.type!==16)throw new Error('invalid MHR DNS identity');
 if(j.Status===3)return{detection_pct:null,last_seen:null};
 const rows=(j.Answer??[]).filter((a:any)=>a.type===16&&a.name?.replace(/\.$/,'').toLowerCase()===name);
 if(rows.length!==1)throw new Error('missing or ambiguous MHR record');
 const m=String(rows[0].data).replace(/^"|"$/g,'').match(/^(\d{9,12}) (\d{1,3})$/);if(!m||+m[2]>100)throw new Error('invalid detection rate');
 return{detection_pct:+m[2],last_seen:new Date(+m[1]*1000).toISOString()};
}
export async function mhrContext(hash:string):Promise<Record<string,unknown>>{
 const h=hash.toLowerCase(),name=(h.length===64?h.slice(0,32)+'.'+h.slice(32):h)+'.hash.cymru.com';
 const url=`https://dns.google/resolve?name=${name}&type=TXT`;
 try{const r=await readPublicBody(url,50000,2000);return{...parseMhr(r.raw,name),source:'Team Cymru MHR via Google DNS TXT',url,raw_body:r.raw,fetched_at:r.fetchedAt,status:'answered'}}catch{return{detection_pct:null,last_seen:null,status:'unavailable',source:'Team Cymru MHR via Google DNS TXT'}}
}
