# Event refusal categories

Completion logs now preserve these existing internal event error codes: EVENT_NOT_FOUND, AMBIGUOUS_EVENT, NON_BINARY_MARKET, EVENT_NOT_RESOLVED, UNCLEAN_RESOLUTION, POLYMARKET_UNREACHABLE and EVENT_TOO_LONG. Before this allowlist, all seven collapsed to OTHER_ERROR. Existing generic outcome=refused and source=none metadata is unchanged.

Only exact internal constants are recognized, not arbitrary code prefixes, suffixes or messages. No event question, candidate name, market slug, upstream response, URL or raw error is logged. Handler, source selection, refusal status, response body, receipt and yes/no/unresolved semantics are unchanged. A no-match can arise at several stages, so EVENT_NOT_FOUND alone does not identify which fallback condition failed.

Current contract checked: https://devnode.telegraphprotocol.com/engine/v1/intents/EVENT_OUTCOME_RESOLUTION_GENERAL . It requires event and exposes outcome yes/no/unresolved plus resolved_yes. This diagnostic patch does not claim to explain a leaderboard score or permit inferring an answer from a refusal.
