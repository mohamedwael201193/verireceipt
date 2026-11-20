import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Lazy route chunks can take >1s to load when the suite runs in parallel
// on a loaded machine; the 1s default made findBy*/waitFor flaky.
// 10s keeps the suite stable without masking a genuinely stuck route.
configure({ asyncUtilTimeout: 10_000 });
