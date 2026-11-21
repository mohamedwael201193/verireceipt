import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('storage copy after the Postgres cutover', () => {
  const files = [
    'components/Layout.tsx', 'pages/landing/SiteFooter.tsx',
    'pages/landing/ReceiptDeck.tsx', 'pages/landing/data.ts',
    'pages/dashboard/StatusDocs.tsx', 'pages/dashboard/benchmarks.ts',
  ];
  it.each(files)('%s does not claim SQLite is the live backend', (file) => {
    const source = readFileSync(`src/${file}`, 'utf8');
    expect(source).not.toMatch(/SQLite WAL|in SQLite|into SQLite|SQLite Grid|Grid SQLite|Persistent Disk SQLite/);
  });
  it('points reviewers at the live storage report and qualifies hosting details', () => {
    const source = readFileSync('src/pages/dashboard/StatusDocs.tsx', 'utf8');
    expect(source).toContain('GET /health (storage key)');
    expect(source).toContain('UNVERIFIED live');
    expect(source).toContain('configuration, not proof of the active backend');
  });
});
