import { afterAll, afterEach, it, expect, vi } from 'vitest';
import { rmSync } from 'node:fs';
const fixture = vi.hoisted(() => { process.env.SQLITE_PATH = '/tmp/vr-weather-wired-' + process.pid + '.sqlite'; delete process.env.DATABASE_URL; return { path: process.env.SQLITE_PATH }; });
vi.mock('../src/core/storage', async original => ({ ...await original<typeof import('../src/core/storage')>(), saveReceipt: vi.fn(async () => { }) }));
import { saveReceipt, closeStorage } from '../src/core/storage';
import { WEATHER_STATION_BINDINGS, NOAA_METAR_APPROVAL, NOAA_NCEI_APPROVAL, createWiredWeatherHandlers } from '../src/handlers/weatherWired';
import { buildServer } from '../src/server';

afterEach(() => vi.clearAllMocks());
afterAll(async () => { await closeStorage(); for (const s of ['', '-wal', '-shm']) rmSync(fixture.path + s, { force: true }); });

it('station bindings pin the exact reviewed ICAO and GHCN ids per location', () => {
    expect(WEATHER_STATION_BINDINGS.map(b => b.location)).toEqual(['Cairo', 'London', 'New York JFK', 'Dubai', 'Frankfurt']);
    const byLocation = Object.fromEntries(WEATHER_STATION_BINDINGS.map(b => [b.location, b]));
    expect(byLocation['Cairo'].icao).toBe('HECA');
    expect(byLocation['Cairo'].ghcn).toBe('EGE00147727');
    expect(byLocation['London'].icao).toBe('EGLL');
    expect(byLocation['London'].ghcn).toBe('UKM00003772');
    expect(byLocation['New York JFK'].icao).toBe('KJFK');
    expect(byLocation['New York JFK'].ghcn).toBe('USW00094789');
    expect(byLocation['Dubai'].icao).toBe('OMDB');
    expect(byLocation['Dubai'].ghcn).toBe('AEM00041194');
    expect(byLocation['Frankfurt'].icao).toBe('EDDF');
    expect(byLocation['Frankfurt'].ghcn).toBe('GMW00035032');
    for (const b of WEATHER_STATION_BINDINGS) {
        expect(/^[A-Z][A-Z0-9]{3}$/.test(b.icao)).toBe(true);
        expect(/^[A-Z0-9]{11}$/.test(b.ghcn)).toBe(true);
        expect(new URL(b.metadataUrl).protocol).toBe('https:');
        expect(b.scope.trim().length).toBeGreaterThan(0);
    }
});

it('Cairo binding honestly discloses the Abbassia/airport station split', () => {
    const cairo = WEATHER_STATION_BINDINGS.find(b => b.location === 'Cairo')!;
    expect(cairo.scope).toContain('Abbassia');
    expect(cairo.scope).toContain('12 km');
});

it('partial location spellings fail closed, no fuzzy match', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
        const h = createWiredWeatherHandlers({archiveFallback:false});
        await expect(h.current({ location: 'New York' })).rejects.toMatchObject({ status: 502, code: 'APPROVED_SOURCES_UNAVAILABLE' });
        await expect(h.past({ location: 'New', date: '2026-11-20' })).rejects.toMatchObject({ status: 502, code: 'APPROVED_SOURCES_UNAVAILABLE' });
        expect(fetchSpy).not.toHaveBeenCalled();
    }
    finally {
        vi.unstubAllGlobals();
    }
});

it('NOAA weather approvals assert public-domain commercial use and redistribution with reviewed dates', () => {
    for (const a of [NOAA_METAR_APPROVAL, NOAA_NCEI_APPROVAL]) {
        expect(a.commercialUse).toBe(true);
        expect(a.redistribution).toBe(true);
        expect(new URL(a.termsUrl).protocol).toBe('https:');
        expect(Number.isFinite(Date.parse(a.checkedAt))).toBe(true);
    }
    expect(NOAA_METAR_APPROVAL.termsUrl).toBe('https://www.weather.gov/disclaimer');
    expect(NOAA_NCEI_APPROVAL.termsUrl).toBe('https://www.noaa.gov/disclaimer');
});

it('unbound locations fail closed for current and past without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
        const h = createWiredWeatherHandlers({archiveFallback:false});
        expect(h.currentSourceNames).toEqual(['NOAA AviationWeather measured METAR']);
        expect(h.pastSourceNames).toEqual(['NOAA NCEI measured daily station archive']);
        await expect(h.current({ location: 'Atlantis' })).rejects.toMatchObject({ status: 502, code: 'APPROVED_SOURCES_UNAVAILABLE' });
        await expect(h.past({ location: 'Atlantis', date: '2026-11-20' })).rejects.toMatchObject({ status: 502, code: 'APPROVED_SOURCES_UNAVAILABLE' });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(saveReceipt).not.toHaveBeenCalled();
    }
    finally {
        vi.unstubAllGlobals();
    }
});

it('routes /v1/weather and /v1/weather-history are wired and fail closed for unbound locations', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"results":[]}'));
    vi.stubGlobal('fetch', fetchSpy);
    const app = buildServer();
    try {
        const current = await app.inject({ method: 'GET', url: '/v1/weather?location=Atlantis' });
        expect(current.statusCode).toBe(502);
        expect(current.json().code).toBe('APPROVED_SOURCES_UNAVAILABLE');
        expect(fetchSpy).not.toHaveBeenCalled();
        const past = await app.inject({ method: 'GET', url: '/v1/weather-history?location=Atlantis&date=2026-11-20' });
        expect(past.statusCode).toBe(502);
        expect(past.json().code).toBe('APPROVED_SOURCES_UNAVAILABLE');
        // past history may ask the geocoder only; an unresolvable place never reaches the archive.
        expect(fetchSpy.mock.calls.map((c) => String(c[0]).split('?')[0])).toEqual(['https://geocoding-api.open-meteo.com/v1/search']);
    }
    finally {
        await app.close();
        vi.unstubAllGlobals();
    }
});

it('routes reject missing or future dates with 400 before any source call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const app = buildServer();
    try {
        const missing = await app.inject({ method: 'GET', url: '/v1/weather' });
        expect(missing.statusCode).toBe(400);
        const noDate = await app.inject({ method: 'GET', url: '/v1/weather-history?location=Cairo' });
        expect(noDate.statusCode).toBe(400);
        const future = await app.inject({ method: 'GET', url: '/v1/weather-history?location=Cairo&date=2099-01-01' });
        expect(future.statusCode).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    }
    finally {
        await app.close();
        vi.unstubAllGlobals();
    }
});
