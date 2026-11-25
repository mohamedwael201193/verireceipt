import type {SourceApproval} from '../core/observedSources';
import {createVesselObservationHandler} from './vesselPositionSource';
// Terms-risk record, not licence permission. Owner instruction verified separately
// on the trusted channel. Opaque date-only pointer, no private message data.
export const VESSEL_SOURCE_APPROVAL:SourceApproval={
 termsUrl:'https://openwaters.io/api/ais/',checkedAt:'2026-11-25',commercialUse:false,redistribution:false,
 ownerRiskAcceptance:{sourceReference:'owner-risk-acceptance-2026-11-23',scope:'testnet-hackathon',acceptedAt:'2026-11-23'},
};
export const handleVesselPosition=createVesselObservationHandler(VESSEL_SOURCE_APPROVAL);
