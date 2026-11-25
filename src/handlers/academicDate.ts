/** Preserve source precision. Unknown or conflicting dates never become invented dates. */
export function academicDate(parts:unknown,year:number|null):{publication_date:string|null;date_precision:'day'|'month'|'year'|'unknown'}{
 const unknown={publication_date:null,date_precision:'unknown' as const};
 if(!Array.isArray(parts)||parts.length<1||parts.length>3||!parts.every(Number.isInteger)||parts[0]!==year||!year)return unknown;
 const y=String(year).padStart(4,'0');
 if(parts.length===1)return{publication_date:y,date_precision:'year'};
 const m=parts[1];if(m<1||m>12)return unknown;
 const month=y+'-'+String(m).padStart(2,'0');if(parts.length===2)return{publication_date:month,date_precision:'month'};
 const date=month+'-'+String(parts[2]).padStart(2,'0');
 return Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date?{publication_date:date,date_precision:'day'}:unknown;
}
export function academicSortKey(p:{publication_date?:string|null;publication_year:number|null}):string{
 return p.publication_date??'';
}
export const academicDatePolicy='Publication dates retain source precision; partial dates sort by known year/month precision, without inventing a day. Invalid or conflicting dates are unknown and sort last.';
