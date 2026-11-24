# Macro and DNS diagnostics

Macro answers log only alias_known:boolean. Recognized endpoint aliases that produce an answer log true; UNSUPPORTED_INDICATOR refusals log false. This means recognized by the existing endpoint normalizer, not valid under the registered request enum. No indicator, country, year or observation value is logged. Missing-parameter and other early failures are not classified by this change.

DNS successful observations log record_type from the ten-value closed enum and record_result:found|empty. A conclusive empty result is distinct from a resolver failure, which remains refused and receives no false empty category. Domains, record values, resolver bodies and raw errors are excluded. Metadata never enters response or receipt evidence.

The current macro request schema5 and onchain enum allow only unemployment rate. The response describes SL.UEM.TOTL.ZS percent0..100, despite inflation/cpi aliases in the response metadata. The explicit request enum prevents widening the registration to other series. Existing native endpoint aliases are unchanged in this logging-only slice and are not newly certified as contract-compatible.

Source: https://devnode.telegraphprotocol.com/engine/v1/intents/MACRO_ECONOMIC_INDICATOR_GENERAL . No numerical or source-selection behavior changes.
