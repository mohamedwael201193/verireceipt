// Implementation only. No source fetch, route, declaration or registration.
// Consumes a decoded AIS position event, never a cached GeoJSON vessel snapshot.
export interface VesselPositionObservation {
 vessel:string; speed_knots:number; latitude:number; longitude:number;
 course_deg:number; observed_at:string; source:'barentswatch';
 license:string; attribution:string; synthesized:boolean; scope:string;
}
function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function refuse():never{throw new Error('unsupported or invalid AIS position observation');}
function number(v:unknown,min:number,max:number):number{
 if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)refuse();return v;
}
/** Exact ship MMSI only. Strict five-minute event freshness, no future allowance. */
export function parseBarentswatchPosition(raw:string,vessel:string,nowMs:number):VesselPositionObservation{
 if(!/^[2-7][0-9]{8}$/.test(vessel)||!Number.isFinite(nowMs)||Buffer.byteLength(raw)>32768)refuse();
 const e:unknown=JSON.parse(raw);
 if(!object(e)||e.type!=='event'||e.msg_type!=='PositionReport'||e.source!=='barentswatch'||e.mmsi!==Number(vessel))refuse();
 if(typeof e.time!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(e.time))refuse();
 const time=Date.parse(e.time);
 if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,19)!==e.time.slice(0,19)||time>nowMs||nowMs-time>300000)refuse();
 const m=e.message;
 if(!object(m)||m.UserID!==Number(vessel)||m.Valid!==true||![1,2,3].includes(m.MessageID as number))refuse();
 const latitude=number(m.Latitude,-90,90),longitude=number(m.Longitude,-180,180);
 const speed=number(m.Sog,0,100),course=number(m.Cog,0,359.999999);
 if(latitude===0&&longitude===0)refuse();
 // Cached envelope coordinates are not the source of the answer. Disagreement refuses.
 if(e.lat!==latitude||e.lon!==longitude)refuse();
 if(typeof e.synthesized!=='boolean'||e.license!=='NLOD-2.0'||typeof e.attribution!=='string'||e.attribution.length>2048||!e.attribution.includes('Data delivered by BarentsWatch.')||!e.attribution.includes('Norwegian Coastal Administration.'))refuse();
 return {vessel,speed_knots:speed,latitude,longitude,course_deg:course,observed_at:e.time,source:'barentswatch',license:e.license,attribution:e.attribution,synthesized:e.synthesized,scope:'Decoded AIS report via Open Waters and BarentsWatch, not independently authenticated or for navigation. Exact ship MMSI only; no name or IMO resolution, no global coverage claim. Timestamp is source event time, not guaranteed GPS fix time.'};
}
