// Build the existing Desk research path as a fixed server-only CommonJS module.
// No source map, frontend import, key, environment value or signing request is embedded.
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
buildSync({
  entryPoints: [resolve(__dirname, '../desk/src/visitorRuntime.ts')],
  outfile: resolve(__dirname, '../dist/visitor-runtime.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  sourcemap: false, legalComments: 'none',
});
