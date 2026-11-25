import {AIRPORT_NAMES,resolveAirportName} from './airportNames';
// Explicit static metro groups, not an inference about a flight itinerary.
export const TRAVEL_METROS:Record<string,string[]>={
 'nyc':['JFK','LGA','EWR'],'new york':['JFK','LGA','EWR'],'new york city':['JFK','LGA','EWR'],
 'chicago':['ORD','MDW'],'washington':['DCA','IAD','BWI'],'washington dc':['DCA','IAD','BWI'],'dc':['DCA','IAD','BWI'],
 'la':['LAX','BUR','SNA'],'los angeles metro':['LAX','BUR','SNA'],
 'sf bay':['SFO','OAK','SJC'],'sf bay area':['SFO','OAK','SJC'],'san francisco bay area':['SFO','OAK','SJC'],'bay area':['SFO','OAK','SJC'],
 'dallas':['DFW','DAL'],'houston':['IAH','HOU'],
};
export function travelMetro(name:string):string[]|undefined{return TRAVEL_METROS[name.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()];}
export function travelEndpoint(name:string):{airport:string;resolvedFrom:{name:string;label:string}|null}[]{
 const metro=travelMetro(name);if(metro)return metro.map(airport=>({airport,resolvedFrom:{name,label:'bundled metro group, all listed airports checked'}}));
 if(/^[a-z]{3}$/i.test(name)&&AIRPORT_NAMES.some(a=>a.code===name.toUpperCase()))return [{airport:name.toUpperCase(),resolvedFrom:null}];
 const matches=resolveAirportName(name);return matches.length===1?[{airport:matches[0].code,resolvedFrom:{name,label:matches[0].label}}]:[];
}
