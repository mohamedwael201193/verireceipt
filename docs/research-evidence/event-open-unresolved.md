# Found open binary markets

24 November 2026. Contract checked at https://devnode.telegraphprotocol.com/engine/v1/intents/EVENT_OUTCOME_RESOLUTION_GENERAL . outcome permits yes/no/unresolved; resolved_yes is bool and winner/date are off-chain fields.

Only uniquely matched, explicitly closed=false, Yes/No binary markets with usable prices and source slug return disclosed unresolved. confidence0.9 describes observed open status only, never a probability. resolved_yes=false does not assert NO when outcome is unresolved; winner and resolved_at are absent. The exact upstream search body remains in the persisted evidence wrapper and the receipt hashes that exact wrapper, as before.

Closed-pending and closed-unclean markets remain refused. Missing closed status cannot become open by coercion. Genuine no-match retains the existing narrow Wikipedia fallback; ambiguity/nonbinary cannot trigger it. Resolved yes/no path unchanged. No manifest change or live market probe. Tests mutate a recorded real body and label those scenarios synthetic, not live observations.
