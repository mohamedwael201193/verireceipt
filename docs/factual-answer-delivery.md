# Factual answer delivery

Each success response keeps one factual `answer`, typed intent fields, a separate verification `verdict`, confidence, source attribution, source/response times and a receipt. The shared envelope puts `answer` before potentially large data arrays. It does not change the source evidence or its hash.

The repository YAML selects `answer` as its signal label instead of the verification-only `verdict`. Its reason remains `source`; typed output paths and units stay unchanged. This is a global mapping across the six registered intents, not a per-validator override. Repository YAML is not proof that the network has activated that configuration. The registered configuration must be checked separately.

TVL and grid prose preserve the measured number as an ungrouped decimal, rather than rounding the human answer while retaining a different typed value. Grid answers that could not be confirmed after their provisional window start with an explicit unverified qualification and its reason. That qualification remains visible when the answer is read without its sibling verdict/confidence/source fields.

Freshness metadata is retained. A cached observation must not become a newly observed source value because it was served again. The validator's finalized-root binding, source quorum, conflict rejection and gwei-valued effective balance are unchanged. An effective balance is not current balance, uptime or APR.

This fits the receipt model: the human answer and protocol label state the same bounded claim, while the receipt lets the reader inspect the evidence and its limits. It is an information-preservation change, not a promise of a particular evaluator score or rank.

## Validation boundaries

Controlled tests cover the six mappings, unchanged numeric/receipt fields, large data arrays, real zero, decimal rendering, refusal bodies and both grid unconfirmed reasons. Controlled fixtures are not live-source or evaluator measurements. A public source probe, a direct API response, a paid network purchase and a scoring result are separate kinds of evidence.

Publishing code does not activate a YAML update. Registry updates and service restarts require their own current identity, authority, continuity and timing checks. A new registration must never be treated as an in-place edit with assumed ranking continuity.
