# Vendor verification without a VAT number

No VAT number found in declared VAT or any text parameter returns200no_data, valid=null and confidence0. The answer echoes the supplied vendor, or none given, and explains that VIES verifies EU VAT numbers only, never matches a vendor name to a registration, and gives no validity verdict. No source request or receipt is created for missing input.

Query can supply the whole vendor string and an extracted VAT number only when its declared field is absent. Declared VAT/vendor win. Existing any-text VAT extraction, ambiguity refusal, malformed explicit VAT refusal and non-VIES scope refusal remain. Empty explicit VAT retains existing any-text extraction behavior. This is not business identity/name lookup and makes no new validity claim.

Tests replay existing recorded Luxembourg VIES bytes, plus synthetic missing/invalid controls. No new source, manifest, shaping or registration change. Validity receipts and outage behavior stay under the existing handler contract. Tests cover no upstream call for absent VAT, exact explanatory text, declared priority, malformed/ambiguous/nonEU refusal and independent negative mutations.

V2 leaves query VAT among all text candidates until cross-field ambiguity is checked; query+context and query+vendor conflicting VATs refuse before source/receipt writes. Explicit nonempty declared VAT still wins. Every missing-VAT case separately asserts zero fetch, zero makeReceipt and zero saveReceipt with mocks cleared between cases. Receipt-creation and storage-insertion mutants are RED, as are both ambiguity regressions.
