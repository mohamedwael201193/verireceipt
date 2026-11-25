# Cross-chain input coverage

Chains may be separated by commas, semicolons, slash, pipe, arrows, "to" or "and", including "from X to Y". Known aliases normalize to existing configured chains. Aliases never add RPC coverage. Order is retained and duplicates removed.

Missing reference or missing chain text remains400. An unsupported reference format, unsupported chain or fewer than two distinct chains returns200with status "not verifiable here", complete=false and consistent=false. The boolean contract has no unknown value: false means not verified in these incomplete responses, not a proven inconsistency or failed transfer. The summary names each limitation and states that nothing was inferred.

For a usable EVM reference, configured chains are still checked independently through the existing quorum even when another named chain is unsupported or a second chain is missing. No-source responses carry no receipt. Partial reads retain a receipt of only the actual reads and their limitations. This is not a bridge verifier. Existing full-coverage terminal-state and runtime-code comparison semantics are unchanged.
