import type { ObservationSource, SourceApproval } from '../core/observedSources';
import { parseMetar, parseNoaaDaily } from './weatherObservations';
import type { StationObservation, DailyArchiveResult } from './weatherObservations';
import { weatherIdentity, type CurrentWeatherQuery, type PastWeatherQuery } from './weatherSources';
export interface WeatherStationBinding {
    /** Exact accepted location spelling, not a fuzzy match or silent default. */
    location: string;
    icao: string;
    ghcn: string;
    /** Audited public metadata establishing station identity/coverage. */
    metadataUrl: string;
    scope: string;
}
async function body(url: string, signal: AbortSignal): Promise<string> {
    const r = await fetch(url, { signal, redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'VeriReceipt/2.0 measured-weather observer' } });
    if (!r.ok)
        throw new Error(`weather source HTTP ${r.status}`);
    const size = r.headers.get('content-length');
    if (size && Number(size) > 200000) {
        await r.body?.cancel();
        throw new Error('weather body limit');
    }
    const reader = r.body?.getReader();
    if (!reader)
        throw new Error('weather body missing');
    const parts: Uint8Array[] = [];
    let n = 0;
    try {
        while (true) {
            const x = await reader.read();
            if (x.done)
                break;
            n += x.value.length;
            if (n > 200000) {
                await reader.cancel();
                throw new Error('weather body limit');
            }
            parts.push(x.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(parts).toString('utf8');
}
function bindingFor(bindings: readonly WeatherStationBinding[], location: string): WeatherStationBinding {
    const matches = bindings.filter(b => b.location.trim().toLowerCase() === location.trim().toLowerCase());
    if (matches.length !== 1)
        throw new Error('no unambiguous reviewed station binding');
    const b = matches[0];
    if (!/^[A-Z][A-Z0-9]{3}$/.test(b.icao) || !/^[A-Z0-9]{11}$/.test(b.ghcn) || new URL(b.metadataUrl).protocol !== 'https:' || !b.scope.trim())
        throw new Error('invalid reviewed station binding');
    return b;
}
/** No mappings or source approvals are supplied by this module. A caller must
 * independently review exact source rights and station/date scope before use. */
export function noaaWeatherSources(bindings: readonly WeatherStationBinding[], approvals: {
    current: SourceApproval;
    past: SourceApproval;
}): {
    current: ObservationSource<CurrentWeatherQuery, StationObservation>;
    past: ObservationSource<PastWeatherQuery, DailyArchiveResult>;
} {
    return {
        current: { name: 'NOAA AviationWeather measured METAR', approval: approvals.current, read: async (q, signal) => { const b = bindingFor(bindings, q.location); const url = 'https://aviationweather.gov/api/data/metar?' + new URLSearchParams({ ids: b.icao, format: 'json' }); const raw = await body(url, signal); const value = parseMetar(raw, b.icao); const fetchedAt = new Date().toISOString(); return { identity: weatherIdentity(q), sourceUrl: url, rawBody: JSON.stringify({ source_raw_body: raw, station_binding: b }), observedAt: value.observedAt, fetchedAt, value }; } },
        past: { name: 'NOAA NCEI measured daily station archive', approval: approvals.past, read: async (q, signal) => { const b = bindingFor(bindings, q.location); const url = 'https://www.ncei.noaa.gov/access/services/data/v1?' + new URLSearchParams({ dataset: 'daily-summaries', stations: b.ghcn, startDate: q.date, endDate: q.date, dataTypes: 'TMAX,TMIN,PRCP', format: 'json', units: 'metric', includeAttributes: 'true', includeStationName: 'true', includeStationLocation: 'true' }); const raw = await body(url, signal); const parsed:unknown=JSON.parse(raw);
        // Only an actual successful empty array proves this narrow archive lookup empty.
        const value:DailyArchiveResult=Array.isArray(parsed)&&parsed.length===0?{noRecord:true,station:b.ghcn,date:q.date}:parseNoaaDaily(raw, b.ghcn, q.date); const fetchedAt = new Date().toISOString(); return { identity: weatherIdentity(q), sourceUrl: url, rawBody: JSON.stringify({ source_raw_body: raw, station_binding: b, archive_observed_at_semantics: 'retrieval time, not time of past weather', requested_day: q.date }), observedAt: fetchedAt, fetchedAt, value }; } }
    };
}
