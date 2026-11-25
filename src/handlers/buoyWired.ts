import type {SourceApproval} from '../core/observedSources';
import {createBuoyObservationHandler} from './buoySource';
// Truthful terms-risk record, not licence permission. Owner instruction verified
// separately on trusted channel; opaque date pointer, no private message data.
export const BUOY_SOURCE_APPROVAL:SourceApproval={termsUrl:'https://www.ndbc.noaa.gov/faq/rt_data_access.shtml',checkedAt:'2026-11-25',commercialUse:false,redistribution:false,ownerRiskAcceptance:{sourceReference:'owner-risk-acceptance-2026-11-23',scope:'testnet-hackathon',acceptedAt:'2026-11-23'}};
// Exactly one instance per process, shared by every request/metric/server build.
// Cache resets on restart. Do not scale across processes without shared budget.
export const handleBuoySensor=createBuoyObservationHandler(BUOY_SOURCE_APPROVAL);
