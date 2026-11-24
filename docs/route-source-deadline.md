# Route source transport deadline

The OSRM route read now rejects after six seconds across fetch and body consumption, even if abort is ignored. At most four underlying OSRM requests are allowed at a time, with no queue. Healthy overlapping requests can complete independently. Each slot's ownership survives caller timeout until actual I/O settlement, preventing repeated requests from accumulating against a stalled demo host. Only callers arriving at full four-slot capacity receive the existing OSRM_UNREACHABLE error; timed-out underlying reads still consume their slots.

A256KB streamed-body bound and redirect refusal apply. Numeric duration, snapping, selected geocoded points, one-lightweight-request policy and static-traffic disclosure are unchanged. Geocoding has its own existing transport, outside this slice. Receipt persistence is outside the source-read budget.

The stored real OSRM route fixture still returns5282seconds with unchanged receipt evidence. Tests add stalled headers/body, repeated caller ownership, one actual settled read freeing the slot, parseable oversized body and redirect policy. Four mutations are rejected. This proves a transport fix, not the cause of any rank gap.
