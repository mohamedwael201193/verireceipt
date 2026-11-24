# Two-airport FAA status

Source: https://nasstatus.faa.gov/api/airport-status-information

This slice accepts X to Y (airport codes or exact bundled airport names), XXX-YYY and XXX/YYY. It resolves both endpoints before fetching, refuses ambiguity or unknown names, obtains one FAA NAS snapshot and returns separate airport_statuses. Top-level disrupted is true when either endpoint has a listed FAA condition. Listed conditions retain their reason, including operational limits in closure notices.

No route or flight delay is estimated. delay_minutes is the maximum available reported airport average, not their sum, with explicit semantics. Absence means no listed condition, not normal operations. Existing single-airport and exact-name behavior stays available.

Flight numbers remain unsupported: the existing source contains no dated flight-to-origin mapping. A flight number can change route by date, so guessing an origin from its airline is unsafe. This slice makes no claim that a keyless flight source cannot exist, only that none has been verified for this implementation. A real dated flight source is needed for that subtype.

Twenty-three travel tests pass, with exact stored snapshot/digest controls for both endpoints, origin-negative/destination-positive, both-negative, ambiguous names and unsupported flight/multi-hop inputs. Three mutants killed: origin-only result, origin substituted for both endpoints and summed airport delays. Build passes.

A live local-handler LGA to LAX smoke succeeded around 21:28 UTC on 2026-11-23. The source listed an LAX general-aviation restriction, not a blanket commercial-flight cancellation. Receipt evidence preserves the exact notice. The answer therefore includes the notice reason as well as its FAA category. This is not a production deployment.
