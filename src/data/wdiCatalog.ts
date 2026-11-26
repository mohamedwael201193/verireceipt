import catalog from './wdiIndicators.json';
export {catalog};
export const WDI_IDS:ReadonlySet<string>=new Set(catalog.map(row=>row.id));
