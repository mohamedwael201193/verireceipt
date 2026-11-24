/** Observational weather parsers only. No forecast/reanalysis substitution. */
export interface StationObservation {
    station: string;
    name: string;
    latitude: number;
    longitude: number;
    temperatureC: number;
    observedAt: string;
    rawObservation: string;
}
function finite(x: unknown, min: number, max: number): number {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max)
        throw new Error('invalid observation quantity');
    return x;
}
export function parseMetar(raw: string, station: string, now = Date.now(), maxAgeMs = 90 * 60000): StationObservation {
    if (!/^[A-Z][A-Z0-9]{3}$/.test(station))
        throw new Error('explicit four-character ICAO station required');
    const j = JSON.parse(raw);
    if (!Array.isArray(j) || j.length > 400)
        throw new Error('invalid METAR response');
    const candidates = j.filter((r: any) => r && r.icaoId === station && r.metarType === 'METAR' && typeof r.obsTime === 'number' && Number.isFinite(r.obsTime) && typeof r.temp === 'number').sort((a: any, b: any) => b.obsTime - a.obsTime);
    if (!candidates.length)
        throw new Error('no matching measured station temperature');
    const r = candidates[0];
    const t = r.obsTime * 1000;
    if (t > now + 60000 || now - t > maxAgeMs)
        throw new Error('station observation is stale or from the future');
    if (typeof r.name !== 'string' || !r.name.trim() || typeof r.rawOb !== 'string' || !r.rawOb.startsWith('METAR ' + station + ' '))
        throw new Error('station record identity missing');
    return { station, name: r.name, latitude: finite(r.lat, -90, 90), longitude: finite(r.lon, -180, 180), temperatureC: finite(r.temp, -90, 60), observedAt: new Date(t).toISOString(), rawObservation: r.rawOb };
}
export interface DailyObservation {
    station: string;
    name: string;
    date: string;
    latitude: number;
    longitude: number;
    tempMaxC: number;
    tempMinC: number;
    precipitationMm: number;
    tracePrecipitation: boolean;
    attributes: Record<string, string>;
    reportingPeriod: 'station-labelled climate day, not necessarily local midnight';
}
function realDate(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }
/** Input must be requested with units=metric, includeAttributes=true. */
export function parseNoaaDaily(raw: string, station: string, date: string): DailyObservation {
    if (!/^[A-Z0-9]{11}$/.test(station) || !realDate(date))
        throw new Error('invalid station or date');
    const j = JSON.parse(raw);
    if (!Array.isArray(j))
        throw new Error('invalid daily response');
    const rows = j.filter((r: any) => r?.STATION === station && r?.DATE === date);
    if (rows.length !== 1)
        throw new Error('missing or duplicate station day');
    const r = rows[0];
    const attributes: Record<string, string> = {};
    let trace = false;
    const values = ['TMAX', 'TMIN', 'PRCP'].map(k => {
        if (typeof r[k] !== 'string' || !/^[-+]?\d+(?:\.\d+)?$/.test(r[k]))
            throw new Error('missing daily observation');
        const n = Number(r[k]);
        finite(n, k === 'PRCP' ? 0 : -90, k === 'PRCP' ? 2000 : 60);
        const a = r[k + '_ATTRIBUTES'];
        if (typeof a !== 'string')
            throw new Error('missing quality attributes');
        const parts = a.split(',');
        if (parts.length < 3 || parts[1] !== '' || !parts[2])
            throw new Error('quality-failed or unknown-source observation');
        // Do not pass hourly extrema, lagged values, presumed-zero precipitation,
        // no-precip-report flags or partial subdaily accumulations as daily truth.
        if (parts[0] !== '' && !(k === 'PRCP' && parts[0] === 'T' && n === 0))
            throw new Error('derived or incomplete daily measurement');
        if (parts[2] === 'S')
            throw new Error('synoptic-derived summary differs from true daily data');
        if (k === 'PRCP' && parts[0] === 'T')
            trace = true;
        attributes[k] = a;
        return n;
    });
    if (values[1] > values[0])
        throw new Error('minimum exceeds maximum');
    if (typeof r.NAME !== 'string' || !r.NAME.trim())
        throw new Error('station name missing');
    function coordinate(k: string, min: number, max: number): number { if (typeof r[k] !== 'string' || !/^[-+]?\d+(?:\.\d+)?$/.test(r[k]))
        throw new Error('station coordinate missing'); return finite(Number(r[k]), min, max); }
    return { station, name: r.NAME, date, latitude: coordinate('LATITUDE', -90, 90), longitude: coordinate('LONGITUDE', -180, 180), tempMaxC: values[0], tempMinC: values[1], precipitationMm: values[2], tracePrecipitation: trace, attributes, reportingPeriod: 'station-labelled climate day, not necessarily local midnight' };
}
