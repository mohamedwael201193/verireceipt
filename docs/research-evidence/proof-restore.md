# Exact proof evidence restore

Operator-only command after build: node dist/tools/restoreProofEvidence.js RECEIPT_ID EXACT_BODY_PATH [PAGE_INDEX]. Reads active DATABASE_URL or SQLITE_PATH. Requires the complete id already in PROOF_RECEIPT_IDS, an existing metadata row, exact SHA256 equality against its stored digest, and at most64MiB uncompressed bytes. A page restore requires its own page digest. Wrong bytes, missing rows, invalid indices and unpinned ids refuse. It never creates metadata or changes hashes/timestamps. Existing evidence is not overwritten. Database transaction and row lock protect the PG write; repeated matching restore is idempotent.

Do not reconstruct JSON with pretty-printing: use the original byte file. Pin cannot recover already-pruned data; this tool only reinstates a hash-matching held copy. Run only with separately approved production account authority, then independently fetch metadata/raw and recompute digest. This commit does not run a production restore or contain recovered proof copies.

SQLite and actual local PG18.1 both exercise main/page restore and mismatch refusals. Four mutation checks killed digest removal, pin removal, wrong page-table routing and non-idempotent overwrite. Unit payloads test storage mechanics, not product proof data. Test PostgreSQL installed outside repo, no production credentials.
