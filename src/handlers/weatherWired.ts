// WIRED measured-weather configuration (expansion slice, 2026-11-23).
//
// Enables the measured-weather handlers with reviewed station bindings
// and NOAA source terms. Doctrine (unchanged): measured station
// observations only - no forecast, reanalysis or modelled substitute
// (OpenWeatherMap was ruled out for exactly that reason); exact location
// spellings only, no fuzzy city/station resolution; a location with no
// reviewed binding fails closed.
//
// Station provenance (verified 2026-11-23 against
// https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt):
//   London      EGLL  <-> UKM00003772 HEATHROW     (WMO 03772, same site)
//   New York    KJFK  <-> USW00094789 NY JFK INTL AP (WMO 74486, same site)
//   Dubai       OMDB  <-> AEM00041194 DUBAI INTL   (WMO 41194, same site)
//   Frankfurt   EDDF  <-> GMW00035032 RHEIN MAIN   (WMO 10637, same site)
//   Cairo       HECA  <-> EGE00147727 CAIRO ABBASSIA
// GHCN has no Cairo International Airport station; the nearest listed
// Cairo city station is Abbassia (30.08, 31.29), roughly 12 km from the
// airport (30.12, 31.41). The current leg therefore observes at HECA and
// the past leg at Abbassia, and both the binding scope and the per-answer
// station disclosure say so. Nothing averages the two.
//
// Terms posture: both legs are US government (NOAA) public-domain
// observation services. The 2026-11-23 source ledger records lawful
// public-domain use with attribution/nonendorsement and third-party-data
// caveats, so commercialUse/redistribution are true here - unlike the
// finance sources, no owner terms-risk acceptance is needed or claimed.

import type { SourceApproval } from '../core/observedSources';
import { createWeatherObservationHandlers } from './weatherSources';
import { noaaWeatherSources, type WeatherStationBinding } from './noaaWeatherSources';

export const NOAA_METAR_APPROVAL: SourceApproval = {
    termsUrl: 'https://www.weather.gov/disclaimer',
    checkedAt: '2026-11-23',
    commercialUse: true,
    redistribution: true,
};
export const NOAA_NCEI_APPROVAL: SourceApproval = {
    termsUrl: 'https://www.noaa.gov/disclaimer',
    checkedAt: '2026-11-23',
    commercialUse: true,
    redistribution: true,
};

const GHCN_STATIONS_METADATA = 'https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt';
/** Reviewed station bindings. `location` is the exact accepted spelling;
 * each answer discloses the actual observing station. */
export const WEATHER_STATION_BINDINGS: readonly WeatherStationBinding[] = [
    { location: 'Cairo', icao: 'HECA', ghcn: 'EGE00147727', metadataUrl: GHCN_STATIONS_METADATA, scope: 'Current: HECA Cairo International Airport METAR. Past: GHCN Cairo Abbassia station EGE00147727, about 12 km from the airport; no GHCN airport station exists for Cairo.' },
    { location: 'London', icao: 'EGLL', ghcn: 'UKM00003772', metadataUrl: GHCN_STATIONS_METADATA, scope: 'Heathrow airport station for both current (EGLL METAR) and past (GHCN UKM00003772, WMO 03772).' },
    { location: 'New York JFK', icao: 'KJFK', ghcn: 'USW00094789', metadataUrl: GHCN_STATIONS_METADATA, scope: 'JFK airport station for both current (KJFK METAR) and past (GHCN USW00094789, WMO 74486). Label is New York JFK, not the whole New York area.' },
    { location: 'Dubai', icao: 'OMDB', ghcn: 'AEM00041194', metadataUrl: GHCN_STATIONS_METADATA, scope: 'Dubai International airport station for both current (OMDB METAR) and past (GHCN AEM00041194, WMO 41194).' },
    { location: 'Frankfurt', icao: 'EDDF', ghcn: 'GMW00035032', metadataUrl: GHCN_STATIONS_METADATA, scope: 'Frankfurt Rhein-Main airport station for both current (EDDF METAR) and past (GHCN GMW00035032, WMO 10637).' },
];

export interface WiredWeatherHandlers {
    current: (q: Record<string, string | undefined>) => Promise<Record<string, unknown>>;
    past: (q: Record<string, string | undefined>) => Promise<Record<string, unknown>>;
    currentSourceNames: readonly string[];
    pastSourceNames: readonly string[];
}

/** Composed measured-weather handlers: one NOAA leg for current METAR
 * observations and one NOAA leg for the past-day archive. */
export function createWiredWeatherHandlers(): WiredWeatherHandlers {
    const noaa = noaaWeatherSources(WEATHER_STATION_BINDINGS, { current: NOAA_METAR_APPROVAL, past: NOAA_NCEI_APPROVAL });
    const handlers = createWeatherObservationHandlers({ current: [noaa.current], past: [noaa.past] });
    return {
        current: handlers.current,
        past: handlers.past,
        currentSourceNames: [noaa.current.name],
        pastSourceNames: [noaa.past.name],
    };
}
