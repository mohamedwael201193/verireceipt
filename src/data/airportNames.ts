// Bundled static airport-name list for TRAVEL_DISRUPTION_GENERAL.
// The FAA NAS feed is US airport-scoped, so this list covers major US
// commercial airports only. It is a fixed in-repo table, not a live
// directory: a name that matches NOTHING is refused, and a name that
// matches more than one listed airport (Washington, New York, Dallas,
// Houston, Chicago) refuses ambiguous naming the candidates — a silent
// first-hit pick is never made.

export interface AirportNameEntry {
  code: string;
  label: string;
  /** Lowercase match forms (normalized: non-alphanumerics collapsed). */
  forms: string[];
}

function entry(code: string, label: string, ...forms: string[]): AirportNameEntry {
  return { code, label, forms };
}

export const AIRPORT_NAMES: AirportNameEntry[] = [
  entry("ATL", "Hartsfield-Jackson Atlanta Intl", "atlanta", "hartsfield", "hartsfield jackson"),
  entry("LAX", "Los Angeles Intl", "los angeles", "los angeles international", "los angeles lax"),
  entry("ORD", "Chicago O'Hare Intl", "ohare", "o hare", "chicago ohare", "chicago o hare", "chicago"),
  entry("MDW", "Chicago Midway", "midway", "chicago midway", "chicago"),
  entry("DFW", "Dallas/Fort Worth Intl", "dallas fort worth", "fort worth", "dallas"),
  entry("DAL", "Dallas Love Field", "love field", "dallas love field", "dallas"),
  entry("DEN", "Denver Intl", "denver", "denver international"),
  entry("JFK", "New York JFK", "kennedy", "john f kennedy", "new york jfk", "new york"),
  entry("LGA", "New York LaGuardia", "laguardia", "new york laguardia", "new york"),
  entry("EWR", "Newark Liberty Intl", "newark"),
  entry("SFO", "San Francisco Intl", "san francisco"),
  entry("SEA", "Seattle-Tacoma Intl", "seattle", "seatac", "seattle tacoma"),
  entry("LAS", "Harry Reid Intl (Las Vegas)", "las vegas", "harry reid"),
  entry("MCO", "Orlando Intl", "orlando"),
  entry("MIA", "Miami Intl", "miami"),
  entry("CLT", "Charlotte Douglas Intl", "charlotte"),
  entry("PHX", "Phoenix Sky Harbor Intl", "phoenix", "sky harbor"),
  entry("IAH", "Houston George Bush Intercontinental", "george bush", "houston intercontinental", "bush intercontinental", "houston"),
  entry("HOU", "Houston William P. Hobby", "hobby", "houston hobby", "william p hobby", "houston"),
  entry("BOS", "Boston Logan Intl", "boston", "logan"),
  entry("MSP", "Minneapolis-Saint Paul Intl", "minneapolis", "saint paul", "minneapolis st paul", "minneapolis saint paul"),
  entry("FLL", "Fort Lauderdale-Hollywood Intl", "fort lauderdale"),
  entry("DTW", "Detroit Metro", "detroit"),
  entry("BWI", "Baltimore/Washington Intl", "baltimore"),
  entry("SLC", "Salt Lake City Intl", "salt lake city"),
  entry("SAN", "San Diego Intl", "san diego"),
  entry("IAD", "Washington Dulles Intl", "dulles", "washington dulles", "washington"),
  entry("DCA", "Ronald Reagan Washington National", "reagan", "washington reagan", "reagan national", "washington"),
  entry("TPA", "Tampa Intl", "tampa"),
  entry("PDX", "Portland Intl (Oregon)", "portland"),
  entry("HNL", "Daniel K. Inouye Intl (Honolulu)", "honolulu"),
  entry("AUS", "Austin-Bergstrom Intl", "austin"),
  entry("STL", "St. Louis Lambert Intl", "st louis", "saint louis", "lambert"),
  entry("BNA", "Nashville Intl", "nashville"),
  entry("SJC", "San Jose Mineta Intl (California)", "san jose"),
  entry("SMF", "Sacramento Intl", "sacramento"),
  entry("MCI", "Kansas City Intl", "kansas city"),
  entry("CVG", "Cincinnati/Northern Kentucky Intl", "cincinnati"),
  entry("CLE", "Cleveland Hopkins Intl", "cleveland"),
  entry("PIT", "Pittsburgh Intl", "pittsburgh"),
  entry("RDU", "Raleigh-Durham Intl", "raleigh", "durham", "raleigh durham"),
  entry("SNA", "John Wayne Airport (Orange County)", "orange county", "john wayne", "santa ana"),
  entry("OAK", "Oakland Intl", "oakland"),
  entry("MSY", "Louis Armstrong New Orleans Intl", "new orleans"),
  entry("PHL", "Philadelphia Intl", "philadelphia"),
  entry("SJU", "Luis Munoz Marin Intl (San Juan)", "san juan", "puerto rico"),
  entry("ANC", "Ted Stevens Anchorage Intl", "anchorage"),
  entry("BUR", "Hollywood Burbank", "burbank"),
  entry("IND", "Indianapolis Intl", "indianapolis"),
  entry("CMH", "John Glenn Columbus Intl", "columbus"),
  entry("MKE", "Milwaukee Mitchell Intl", "milwaukee"),
  entry("ABQ", "Albuquerque Intl Sunport", "albuquerque"),
  entry("MEM", "Memphis Intl", "memphis"),
  entry("OKC", "Will Rogers World (Oklahoma City)", "oklahoma city"),
  entry("TUS", "Tucson Intl", "tucson"),
  entry("OMA", "Eppley Airfield (Omaha)", "omaha"),
  entry("BOI", "Boise", "boise"),
  entry("CHS", "Charleston Intl (South Carolina)", "charleston"),
  entry("JAX", "Jacksonville Intl (Florida)", "jacksonville"),
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Resolve an airport name against the bundled list. Returns every
 * matching entry (more than one means the name is ambiguous); an empty
 * array means the name is not in the list. */
export function resolveAirportName(name: string): AirportNameEntry[] {
  const needle = normalize(name);
  if (!needle) return [];
  return AIRPORT_NAMES.filter((e) => e.forms.some((f) => normalize(f) === needle));
}
