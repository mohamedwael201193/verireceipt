// PG-CUTOVER (2026-11-21): one-shot SQLite -> Postgres copy at boot.
//
// The Render service has no shell we can reach, so the migration tool
// (migrateSqliteToPg.ts, judged r3) cannot be run by hand. This runs the
// SAME migrate() in-process, BEFORE the store opens and before listen():
//   * only when DATABASE_URL is set (Postgres backend) AND
//     MIGRATE_ON_BOOT=1 AND the SQLite file at SQLITE_PATH exists;
//   * copy + verify in one call (idempotent: ON CONFLICT DO NOTHING; the
//     SQLite file is opened READ-ONLY and never modified or deleted);
//   * prints one redacted JSON summary line (counts only);
//   * a failed verify or an error exits 1, so the instance never serves
//     Postgres with an incomplete copy. Recovery: set DATABASE_URL="" and
//     redeploy -> the service boots on the untouched SQLite file.
// With the disk attached the old instance has stopped before this one
// boots, so nothing writes SQLite during the copy (no 404 window).

import { existsSync } from "fs";
import { migrate } from "./migrateSqliteToPg";
import { redactSecrets } from "../core/db";

export type BootMigrateResult = "skipped" | "ok";

export async function maybeMigrateOnBoot(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = (c) => process.exit(c),
): Promise<BootMigrateResult> {
  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  if (!databaseUrl || env.MIGRATE_ON_BOOT !== "1") return "skipped";
  const sqlitePath = (env.SQLITE_PATH ?? "").trim();
  if (!sqlitePath || !existsSync(sqlitePath)) {
    console.log(JSON.stringify({ boot_migrate: "skipped", reason: "sqlite_file_absent" }));
    return "skipped";
  }
  const t0 = Date.now();
  try {
    const s = await migrate({ sqlitePath, databaseUrl });
    console.log(
      redactSecrets(
        JSON.stringify({
          boot_migrate: s.ok ? "ok" : "failed",
          ms: Date.now() - t0,
          source: s.source,
          inserted: s.inserted,
          verified: s.verified,
          evidence_pruned_source: s.evidence_pruned_source,
          evidence_pruned_target: s.evidence_pruned_target,
          mismatch_count: s.mismatches.length,
          prune_violation_count: s.prune_violations.length,
          first_mismatches: s.mismatches.slice(0, 10),
        }),
        [databaseUrl],
      ),
    );
    if (!s.ok) {
      console.error("FATAL: boot migration verify failed; refusing to serve Postgres");
      return exit(1);
    }
    return "ok";
  } catch (err: unknown) {
    console.error(
      redactSecrets(`FATAL: boot migration failed: ${err instanceof Error ? err.message : String(err)}`, [databaseUrl]),
    );
    return exit(1);
  }
}
