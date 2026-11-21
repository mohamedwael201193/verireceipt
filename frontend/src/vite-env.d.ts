/// <reference types="vite/client" />

/** Git commit sha baked in at build time (VERCEL_GIT_COMMIT_SHA / GITHUB_SHA), or "". */
declare const __BUILD_COMMIT__: string;
