# Supply scope and SEC title grammar, proposed changes

Design only. No verifier change, paid retry or result revision is included.

## UNI: keep the frozen chain scope, tighten the valuation label

Template A explicitly requests UNI on Ethereum. Its current independent parser checks that token's totalSupply and decimals against two chain-bound RPCs at the same finalized block. That is a defensible Ethereum contract total-supply fact. It is not a definition of aggregate economic supply across chains, circulating supply, free float or burn-adjusted supply.

Builder-observed A3 provider response reports all_chains total_supply 885496418.7861971 while separately reporting Ethereum chain_total_supply 1000000000. The paid scored field is the former. Substituting the latter would change which purchased field the receipt verifies. Keep A3 HOLD, and do not pick a helpful raw sibling field after seeing the result.

Recommended new spec: explicitly name the Ethereum token contract, chain id 1, whole-token contract totalSupply definition and finalized-block basis. Keep the scored total_supply field only if the live canonical intent and provider delivery path can express this same scope. If canonical params cannot guarantee chain scope, do not pretend the request obtained it. Freeze the selector contract before payment and reject all_chains scope even when its value happens to match.

Rename the resulting calculation to price times Ethereum contract total supply, or Ethereum-contract implied valuation. Avoid an unqualified claim that this is the asset's economically correct fully diluted valuation. A true cross-chain FDV needs a separately frozen definition and independent treatment of bridged duplicates, burns, mint authority, vesting and future issuance. Neither the current all-chain provider answer nor a single-chain RPC proves that economic quantity.

Required controls: wrong chain id, wrong token address, wrapped token, all_chains versus chain mismatch, equal values with conflicting scope, decimals mismatch, inconsistent finalized block hashes, and attempts to replace the scored field with chain_total_supply or circulating_supply. Existing A1/A2/A3 packets remain byte-identical.

## SEC: add explicit report-period grammar, not a broad title exception

Builder-observed B1 has a complete primary recount of three calendar-2024 10-Q filings. The current optional-assertion check rejects the provider's issuer-plus-CIK string and titles that describe report-period endings. The count alone was corroborated; the full response was not accepted. This should be described as unsupported assertion grammar, not proven numerical falsehood.

Recommended separate parser change:

1. Parse issuer plus optional anchored CIK. Require both normalized issuer identity and numeric CIK to agree with the primary issuer. Never accept one while ignoring a contradictory other.
2. Retain SEC reportDate in parsed rows as a field distinct from filingDate. Validate complete array coverage when present. A report-period title cannot bind if the primary reportDate is absent.
3. Support a tightly anchored grammar for issuer, exact form and one ISO report-period date. Bind it to a unique primary-matched accession whose reportDate equals that date, within the already frozen filing-date query window. Filing-date titles continue to bind to filingDate. Never interchange the two date meanings.
4. Bind any URL, accession, issuer, form, report date and publication/filing date supplied in a row to the same primary accession. Check the current provider's recent list explicitly rather than silently ignoring an unfamiliar structure. Reject contradictory aliases or unsupported extra assertion structures.
5. Include reportDate in duplicate-accession consistency checks and historical replay parsing. Keep full-history completeness and exact count checks unchanged. Unsupported grammar remains a failure with a specific explanation.

Required controls: correct period ending but wrong filing date; correct filing date but wrong report period; wrong issuer with correct CIK and vice versa; wrong form or amendment; valid title attached to another accession; URL/path mismatch; duplicate or ambiguous period rows; missing reportDate coverage; mixed/suffixed claims; Unicode/invisible text; multiple dates; ignored recent fields; and unchanged historical replay behavior.

Do not apply the new parser retroactively as the original B1 outcome. A read-only re-evaluation may be labeled under a new verifier version, with original HOLD preserved. A new paid experiment would require separately reviewed implementation and a new frozen spec, not a retry intended to erase a failure.

## Review boundaries

Proposed implementation should be split into scope/label tests and SEC parser tests so each has its own independent review. No changing tolerances, dropping inconvenient assertions, choosing a provider after seeing a desired number, or claiming a clean note from a partial pass.

Internal evidence: A3 and B1 final packets and sanitized failures already delivered to main. Detailed raw paid responses stay private because transport files include authorization material. Public-source provenance for the SEC recount is in the B1 source-verification record, including exact SEC submissions URLs and byte hashes. Scope conclusions here are builder-reported diagnosis, not independent certification.
