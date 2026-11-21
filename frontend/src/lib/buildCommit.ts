/**
 * Frontend build commit (P-C2 leftover (b)).
 *
 * Prefer the commit baked in at build time from Vercel
 * (`VERCEL_GIT_COMMIT_SHA`) or CI (`GITHUB_SHA`). An unlabeled local
 * build has no sha of its own — we then pin origin/main as of this
 * patch (`40c80abd5b8ade95071fc0e984e889888bfe08cf`) and say so in the
 * label. Never call a stale sha "the real base commit".
 */

const FALLBACK_SHA = "40c80abd5b8ade95071fc0e984e889888bfe08cf";

function bakedCommit(): string {
  try {
    const raw = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__.trim() : "";
    if (/^[0-9a-f]{7,40}$/i.test(raw)) return raw;
  } catch {
    // __BUILD_COMMIT__ is always defined by vite; a missing binding is
    // treated as an unlabeled build.
  }
  return "";
}

export interface FrontendCommit {
  /** Full or abbreviated hex sha. */
  sha: string;
  short: string;
  /**
   * Honest provenance: "this frontend build" when the sha was baked
   * in at compile time; otherwise an origin/main pin for unlabeled
   * local builds.
   */
  label: string;
  fromBuildEnv: boolean;
}

export function frontendCommit(): FrontendCommit {
  const baked = bakedCommit();
  if (baked) {
    return {
      sha: baked,
      short: baked.slice(0, 7),
      label: "this frontend build",
      fromBuildEnv: true,
    };
  }
  return {
    sha: FALLBACK_SHA,
    short: FALLBACK_SHA.slice(0, 7),
    label: "origin/main pin (unlabeled local build)",
    fromBuildEnv: false,
  };
}

export const REPO_URL = "https://github.com/mohamedwael201193/verireceipt";
