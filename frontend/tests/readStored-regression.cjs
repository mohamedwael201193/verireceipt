// Regression test for J2 M-1 (minors round): a stored ledger array with
// ZERO valid entries must be treated as corrupt — corrupt notice + backup —
// never silently rewritten to [].
//
// Why plain node, not vitest: this clone (work-secondary) ships only the
// four secondary pages (frontend/src/pages/*). The app shell (react,
// src/lib/*, vite/vitest) lives in the frontend app repo, so no jsdom run
// is possible here. This test therefore exercises the REAL readStored
// function: it extracts the exact helper span from Receipts.tsx at run
// time, erases its TypeScript annotations, and evaluates it in memory with
// a localStorage stub. If the helpers move or change shape, extraction or
// the annotation-strip fails loudly instead of silently testing a copy.
// The React wiring (persist guard + backup effect + role="alert" notice)
// is pinned by source-order assertions below. The test writes no files:
// node writes are intermittently EPERM-denied in this sandbox (create
// succeeds, the write itself fails — same flake J2 hit with vitest/vite).
//
// Run: node frontend/tests/readStored-regression.cjs  (from repo root)
// Exit 0 = all cases pass.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RECEIPTS_TSX =
  process.env.READSTORED_SOURCE ||
  path.join(__dirname, '..', 'src', 'pages', 'Receipts.tsx');
const source = fs.readFileSync(RECEIPTS_TSX, 'utf8');

// --- Extract the real constants + helpers from the shipped file -----------
function extractConst(name) {
  const m = source.match(new RegExp(`^const ${name} = (.+);$`, 'm'));
  assert.ok(m, `could not extract const ${name} from Receipts.tsx`);
  return m[1].trim();
}
function extractStringConst(name) {
  // TS string literal: '...' or "..." (no escapes in these values).
  const lit = extractConst(name);
  const m = lit.match(/^'([^']*)'$/) || lit.match(/^"([^"]*)"$/);
  assert.ok(m, `${name} is a plain string literal`);
  return m[1];
}
const STORAGE_KEY = extractStringConst('STORAGE_KEY');
const BACKUP_KEY = extractStringConst('BACKUP_KEY');
const LEDGER_CAP = Number(extractConst('LEDGER_CAP'));
assert.equal(STORAGE_KEY, 'verireceipt.session-receipts.v1');
assert.equal(BACKUP_KEY, 'verireceipt.session-receipts.v1.corrupt-backup');
assert.ok(Number.isInteger(LEDGER_CAP) && LEDGER_CAP > 0, 'LEDGER_CAP sane');

const startMarker = 'function isNonEmptyString';
const endMarker = 'function asEnvelope';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, 'helper span markers found');
const span = source.slice(start, end);
for (const fn of ['isNonEmptyString', 'isRecord', 'isValidReceipt', 'isValidStoredReceipt', 'readStored']) {
  assert.ok(span.includes(`function ${fn}`), `span contains ${fn}`);
}

// --- Load the REAL readStored, in memory (no file writes) -----------------
// The span is evaluated with `new Function` after erasing its (few, known)
// TypeScript annotations. Node 24 could import a .ts scratch file instead,
// but node writes are intermittently EPERM-denied in this sandbox (create
// succeeds, the write itself fails — same flake J2 hit with vitest/vite),
// so the test writes no files at all. If the helpers ever gain an
// annotation shape the stripper does not know, the Function constructor
// throws a SyntaxError and the test fails loudly instead of testing a copy.
function stripTypes(ts) {
  let js = ts;
  js = js.replace(/:\s*v is [A-Za-z_]+(<[^>]*>)?/g, ''); // `: v is X` predicates
  js = js.replace(/\(\)\s*:\s*\{\s*entries:\s*StoredReceipt\[\];\s*corrupt:\s*boolean\s*\}/, '()');
  js = js.replace(/: unknown/g, ''); // param + `const parsed: unknown`
  js = js.replace(/: string/g, ''); // `asText(...): string`
  return js;
}
const stripped = stripTypes(span);
assert.ok(!/:\s*(unknown|string|boolean|StoredReceipt|Receipt|Record)\b/.test(stripped),
  'all type annotations stripped from the extracted span');
assert.ok(stripped.includes('function readStored'), 'stripped span still defines readStored');
const readStored = new Function(
  'STORAGE_KEY',
  'LEDGER_CAP',
  `${stripped}; return readStored;`,
)(STORAGE_KEY, LEDGER_CAP);

// --- localStorage stub -----------------------------------------------------
function makeStorage(seed) {
  const map = new Map();
  if (seed !== undefined) map.set(STORAGE_KEY, seed);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _raw: () => map.get(STORAGE_KEY) ?? null,
    _backup: () => map.get(BACKUP_KEY) ?? null,
  };
}

// --- Faithful simulation of the two mount effects in Receipts.tsx ---------
// Persist effect: skips the overwrite when storedCorrupt. Backup effect:
// copies the raw stored value under BACKUP_KEY when storedCorrupt. The
// wiring pins below assert these guards exist in the shipped source, in
// order; the simulation then checks the storage outcome for each case.
function assertWiring() {
  const persistGuard = source.indexOf('if (storedCorrupt) return;');
  const persistWrite = source.indexOf('localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))');
  assert.ok(persistGuard !== -1 && persistWrite !== -1 && persistGuard < persistWrite,
    'persist effect returns early on storedCorrupt before overwriting');
  const backupWrite = source.indexOf('localStorage.setItem(BACKUP_KEY, raw)');
  assert.ok(backupWrite !== -1, 'backup effect writes raw value under BACKUP_KEY');
  const notice = source.indexOf('{storedCorrupt && (');
  const alert = source.indexOf('role="alert"', notice);
  assert.ok(notice !== -1 && alert !== -1 && alert - notice < 800,
    'corrupt notice (role="alert") renders when storedCorrupt');
  assert.ok(source.slice(notice, notice + 900).includes('BACKUP_KEY'),
    'corrupt notice names the backup key');
}

function mount(storage, corrupt, entries) {
  // Persist effect: writes the (validated) ledger — skipped when corrupt.
  if (!corrupt) storage.setItem(STORAGE_KEY, JSON.stringify(entries ?? []));
  // Backup effect (mount-only).
  if (corrupt) {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw !== null) storage.setItem(BACKUP_KEY, raw);
  }
}

const VALID_ENTRY = {
  key: 'tx-1',
  endpoint: 'tx',
  label: 'tx lookup',
  params: 'tx_hash=0xabc…',
  summary: 'confirmed',
  fetchedAt: '2026-11-20T10:00:00.000Z',
  receipt: {
    receipt_id: 'r-1',
    upstream_url: 'https://example.invalid/rpc',
    raw_response_sha256: '0x' + 'a'.repeat(64),
    fetched_at: '2026-11-20T10:00:00.000Z',
  },
};

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  assertWiring();
  console.log('PASS wiring pins (persist guard, backup write, alert notice)');

  const seed = (storage, raw) => {
    globalThis.localStorage = storage;
    if (raw !== undefined) storage.setItem(STORAGE_KEY, raw);
  };

  // M-1 repro 1: [1,2,3] — zero valid entries, non-empty array.
  check('seed [1,2,3] -> corrupt, empty ledger, raw preserved + backup', () => {
    const storage = makeStorage();
    seed(storage, '[1,2,3]');
    const { entries, corrupt } = readStored();
    assert.equal(corrupt, true);
    assert.deepEqual(entries, []);
    mount(storage, corrupt, entries);
    assert.equal(storage._raw(), '[1,2,3]');
    assert.equal(storage._backup(), '[1,2,3]');
  });

  // M-1 repro 2: objects failing validation — zero valid entries.
  check('seed [{"key":123},{"label":null}] -> corrupt, empty ledger, raw preserved + backup', () => {
    const storage = makeStorage();
    seed(storage, '[{"key":123},{"label":null}]');
    const { entries, corrupt } = readStored();
    assert.equal(corrupt, true);
    assert.deepEqual(entries, []);
    mount(storage, corrupt, entries);
    assert.equal(storage._raw(), '[{"key":123},{"label":null}]');
    assert.equal(storage._backup(), '[{"key":123},{"label":null}]');
  });

  // Legitimate empty ledger: no notice, no backup, persist may rewrite [].
  check('seed [] -> NOT corrupt, empty ledger, no backup', () => {
    const storage = makeStorage();
    seed(storage, '[]');
    const { entries, corrupt } = readStored();
    assert.equal(corrupt, false);
    assert.deepEqual(entries, []);
    mount(storage, corrupt, entries);
    assert.equal(storage._raw(), '[]');
    assert.equal(storage._backup(), null);
  });

  // Valid entries: no notice, kept, no backup.
  check('seed [valid] -> NOT corrupt, entry kept, no backup', () => {
    const storage = makeStorage();
    seed(storage, JSON.stringify([VALID_ENTRY]));
    const { entries, corrupt } = readStored();
    assert.equal(corrupt, false);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'tx-1');
    mount(storage, corrupt, entries);
    assert.equal(storage._backup(), null);
  });

  // Partial invalid: valid entries survive, no corrupt flag (pre-existing).
  check('seed [valid, 1, 2] -> NOT corrupt, only valid kept', () => {
    const storage = makeStorage();
    seed(storage, JSON.stringify([VALID_ENTRY, 1, 2]));
    const { entries, corrupt } = readStored();
    assert.equal(corrupt, false);
    assert.equal(entries.length, 1);
  });

  // Pre-existing corrupt paths still work.
  check('seed unparseable -> corrupt, raw preserved + backup', () => {
    const storage = makeStorage();
    seed(storage, '{bad json');
    const { entries, corrupt } = readStored();
    assert.equal(corrupt, true);
    assert.deepEqual(entries, []);
    mount(storage, corrupt, entries);
    assert.equal(storage._raw(), '{bad json');
    assert.equal(storage._backup(), '{bad json');
  });

  check('seed non-array object -> corrupt, raw preserved + backup', () => {
    const storage = makeStorage();
    seed(storage, '{"a":1}');
    const { entries, corrupt } = readStored();
    assert.equal(corrupt, true);
    assert.deepEqual(entries, []);
    mount(storage, corrupt, entries);
    assert.equal(storage._backup(), '{"a":1}');
  });

  check('no stored key -> NOT corrupt, empty ledger', () => {
    const storage = makeStorage();
    seed(storage);
    const { entries, corrupt } = readStored();
    assert.equal(corrupt, false);
    assert.deepEqual(entries, []);
  });

  console.log(`\n${passed}/8 cases passed (+ wiring pins)`);
}

main()
  .catch((err) => {
    console.error(`FAIL ${err.message}`);
    process.exitCode = 1;
  });
