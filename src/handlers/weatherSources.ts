import { badRequest } from '../core/errors';
import { observeFromSources, type ObservationSource } from '../core/observedSources';
import type { StationObservation, DailyArchiveResult } from './weatherObservations';
export interface CurrentWeatherQuery {
    location: string;
}
export interface PastWeatherQuery {
    location: string;
    date: string;
}
export interface WeatherSourceLists {
    current: readonly ObservationSource<CurrentWeatherQuery, StationObservation>[];
    past: readonly ObservationSource<PastWeatherQuery, DailyArchiveResult>[];
}
function location(s: string | undefined): string { const v = s?.trim(); if (!v || v.length > 256 || /[\x00-\x1f]/.test(v))
    throw badRequest('INVALID_LOCATION', 'location is required, at most 256 printable characters'); return v; }
/** Identity helper for reviewed source adapters. No fuzzy city/station match. */
export function weatherIdentity(q: CurrentWeatherQuery | PastWeatherQuery): string { return JSON.stringify('date' in q ? [q.location.trim().toLowerCase(), q.date] : [q.location.trim().toLowerCase()]); }
function number(n: number, min: number, max: number): void { if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
    throw new Error('invalid weather observation'); }
export function createWeatherObservationHandlers(lists: WeatherSourceLists) {
    return {
        current: async (q: Record<string, string | undefined>) => {
            const query = { location: location(q.location) };
            return observeFromSources(query, lists.current, { intent: 'WEATHER_CHECK_TEMPERATURE', identity: weatherIdentity, validate: v => { number(v.temperatureC, -90, 60); number(v.latitude, -90, 90); number(v.longitude, -180, 180); if (!v.station || !v.name || !v.rawObservation || !Number.isFinite(Date.parse(v.observedAt)) || Date.now() - Date.parse(v.observedAt) > 90 * 60_000 || Date.parse(v.observedAt) > Date.now() + 60_000)
                    throw new Error('station metadata missing'); }, fields: v => ({ location: query.location, temperature_c: v.temperatureC, temp_c: v.temperatureC, station: v.station, station_name: v.name, station_latitude: v.latitude, station_longitude: v.longitude, observed_at: v.observedAt }), answer: v => `${query.location}: measured air temperature ${v.temperatureC} C at ${v.name} (${v.station}), observed ${v.observedAt}.`, maxAgeMs: 90 * 60000, sourceTimeoutMs: 900, scope: 'Named station observation, not a forecast, reanalysis or temperature at every point in the city. Station-to-request binding must be explicit in source evidence.' });
        },
        past: async (q: Record<string, string | undefined>) => {
            const query = { location: location(q.location), date: q.date?.trim() ?? '' };
            const t = Date.parse(query.date + 'T00:00:00Z');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== query.date || query.date >= new Date().toISOString().slice(0, 10))
                throw badRequest('INVALID_DATE', 'date must be a real past YYYY-MM-DD date');
            return observeFromSources(query, lists.past, { intent: 'WEATHER_FORECAST_VERIFY_GENERAL', identity: weatherIdentity, noData: v => 'noRecord' in v, validate: v => { if ('noRecord' in v) { if(v.noRecord!==true||v.date!==query.date||!/^[A-Z0-9]{11}$/.test(v.station))throw new Error('invalid no-record binding'); return; } if (v.date !== query.date || !v.station || !v.name)
                    throw new Error('station/day mismatch'); number(v.tempMaxC, -90, 60); number(v.tempMinC, -90, 60); number(v.precipitationMm, 0, 2000); number(v.latitude, -90, 90); number(v.longitude, -180, 180); if (typeof v.tracePrecipitation !== 'boolean' || v.reportingPeriod !== 'station-labelled climate day, not necessarily local midnight') throw new Error('daily coverage disclosure missing'); if (v.tempMinC > v.tempMaxC)
                    throw new Error('min exceeds max'); }, fields: v => 'noRecord' in v ? {location:query.location,date:v.date,station:v.station,temp_max_c:null,temp_min_c:null,precipitation_mm:null,condition:null,data_status:'no_record',coverage_scope:'The bound NOAA station/date query returned an empty array; not evidence that weather was absent or that no other source has data.'} : ({ location: query.location, date: v.date, temp_max_c: v.tempMaxC, temp_min_c: v.tempMinC, precipitation_mm: v.precipitationMm, trace_precipitation: v.tracePrecipitation, station: v.station, station_name: v.name, reporting_period: v.reportingPeriod, condition: 'not reported by this daily extrema/precipitation source' }), answer: v => 'noRecord' in v ? `${query.location}, ${v.date}: the NOAA archive returned no record for bound station ${v.station}. No temperature, precipitation or condition is asserted; no model estimate was substituted.` : `${query.location}, ${v.date}: ${v.name} (${v.station}) recorded maximum ${v.tempMaxC} C, minimum ${v.tempMinC} C and ${v.precipitationMm} mm precipitation${v.tracePrecipitation ? ' (trace, below measurable amount)' : ''}.`, maxAgeMs: 24 * 60 * 60000, sourceTimeoutMs: 3000, scope: 'Recorded station-labelled climate day, not necessarily local midnight. No weather condition is inferred from extrema or precipitation alone. Source timestamp means archive publication/retrieval freshness, not that the past-day weather happened now.' });
        }
    };
}
export const unconfiguredWeatherHandlers = createWeatherObservationHandlers({ current: [], past: [] });
