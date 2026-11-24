import { it, expect } from 'vitest';
import { parseMetar, parseNoaaDaily } from '../src/handlers/weatherObservations';
const now = Date.parse('2026-11-22T12:00:00Z');
const m = { icaoId: 'KZZZ', metarType: 'METAR', obsTime: now / 1000 - 1800, temp: 0, lat: 0, lon: 0, name: 'Synthetic station', rawOb: 'METAR KZZZ fixture' };
const d = { STATION: 'USW00000000', DATE: '2026-11-10', NAME: 'Synthetic station', LATITUDE: '0', LONGITUDE: '0', TMAX: '28.3', TMIN: '16.7', PRCP: '0.0', TMAX_ATTRIBUTES: ',,1', TMIN_ATTRIBUTES: ',,1', PRCP_ATTRIBUTES: ',,1,2400' };
it('accepts a measured zero-degree station temperature without coercing null to zero', () => { expect(parseMetar(JSON.stringify([m]), 'KZZZ', now).temperatureC).toBe(0); expect(() => parseMetar(JSON.stringify([{ ...m, temp: null }]), 'KZZZ', now)).toThrow(); });
it('refuses stale, future, wrong station and forecast type', () => { for (const r of [{ ...m, obsTime: now / 1000 - 7200 }, { ...m, obsTime: now / 1000 + 1000 }, { ...m, icaoId: 'KYYY' }, { ...m, metarType: 'TAF' }])
    expect(() => parseMetar(JSON.stringify([r]), 'KZZZ', now)).toThrow(); });
it('preserves recorded metrics and station reporting-day caveat', () => { const r = parseNoaaDaily(JSON.stringify([d]), d.STATION, d.DATE); expect(r.tempMaxC).toBe(28.3); expect(r.tempMinC).toBe(16.7); expect(r.precipitationMm).toBe(0); expect(r.reportingPeriod).toContain('not necessarily local midnight'); });
it('refuses missing/failing/unknown quality flags and nonnumeric values', () => { for (const r of [{ ...d, TMAX: '-9999' }, { ...d, TMAX: null }, { ...d, TMAX_ATTRIBUTES: ',X,1' }, { ...d, PRCP_ATTRIBUTES: 'H,,S' }, { ...d, PRCP_ATTRIBUTES: 'I,,1' }, { ...d, PRCP_ATTRIBUTES: ',,' }, { ...d, TMIN: '40' }])
    expect(() => parseNoaaDaily(JSON.stringify([r]), d.STATION, d.DATE)).toThrow(); });
it('discloses trace precipitation while refusing inferred nonzero trace', () => { expect(parseNoaaDaily(JSON.stringify([{ ...d, PRCP_ATTRIBUTES: 'T,,1' }]), d.STATION, d.DATE).tracePrecipitation).toBe(true); expect(() => parseNoaaDaily(JSON.stringify([{ ...d, PRCP: '1', PRCP_ATTRIBUTES: 'T,,1' }]), d.STATION, d.DATE)).toThrow(); });
it('requires exactly one matching calendar-valid station day', () => { expect(() => parseNoaaDaily(JSON.stringify([d, d]), d.STATION, d.DATE)).toThrow(); expect(() => parseNoaaDaily(JSON.stringify([d]), d.STATION, '2026-02-30')).toThrow(); expect(() => parseNoaaDaily(JSON.stringify([d]), 'USW00000001', d.DATE)).toThrow(); });

it('refuses symmetric missing max/min sentinel instead of calling it a valid cold day',()=>{expect(()=>parseNoaaDaily(JSON.stringify([{...d,TMAX:'-9999',TMIN:'-9999'}]),d.STATION,d.DATE)).toThrow()});
