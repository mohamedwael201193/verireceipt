# Compact filing periods

24 November2026. The contract example at https://devnode.telegraphprotocol.com/engine/v1/intents/REGULATORY_FILING_MONITOR_GENERAL is spaced last12months in prose only when compressed; its actual value is "last 12 months". Compact spelling refusal was independently reported in production, not proven as a historical evaluator input or score cause.

Normalize only complete relative/calendar phrases: last/past/trailing or bare number with months/years, space/underscore/hyphen variants, YTD/year-to-date, compact QnYYYY/calendar QnYYYY and calendar/CY years. Rolling years mean12months each, not calendar years. Retain original label; resolved YTD/quarter bounds remain disclosed. ISO dates/ranges remain untouched, fiscal terms and negative/zero/over1200month periods still refuse. Full handler replay of existing complete Apple capture verifies compact spelling survives form extraction and preserves exact10-K count. No count/filter semantics, source, manifest or deployment change.

Sibling scan: SLA has a separate1..90day grammar accepting spaced last/past Ndays and Nd, but compact last30days/separator/trailing variants do not parse. Weather/storm/news window_hours are integer fields, not free-text periods; adding month/year phrases there would violate their type. No sibling changes in this slice. A separate SLA grammar change needs its own contract review.
