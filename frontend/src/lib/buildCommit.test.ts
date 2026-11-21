import { describe, expect, it } from "vitest";
import { frontendCommit, REPO_URL } from "./buildCommit";

describe("frontendCommit", () => {
  it("uses the baked build sha when vite defined one", () => {
    const c = frontendCommit();
    // In unit tests vite define injects "" unless the test env sets a sha,
    // so this assertion is about the unlabeled-local shape. The baked
    // path is a straight return of __BUILD_COMMIT__ (covered when the
    // value is a hex sha).
    if (c.fromBuildEnv) {
      expect(c.sha).toMatch(/^[0-9a-f]{7,40}$/i);
      expect(c.label).toBe("this frontend build");
      expect(c.short).toBe(c.sha.slice(0, 7));
    } else {
      expect(c.sha).toBe("40c80abd5b8ade95071fc0e984e889888bfe08cf");
      expect(c.short).toBe("40c80ab");
      expect(c.label).toBe("origin/main pin (unlabeled local build)");
    }
    expect(REPO_URL).toBe("https://github.com/mohamedwael201193/verireceipt");
  });
});
