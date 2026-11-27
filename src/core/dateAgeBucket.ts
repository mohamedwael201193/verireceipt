/** Fixed-label age bucket of a YYYY-MM-DD date relative to today (UTC).
 * Labels only, never the date: '<=7d' | '8-30d' | '>30d' | 'future' | 'invalid'. */
export function dateAgeBucket(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'invalid';
  const t = Date.parse(v + 'T00:00:00Z');
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) return 'invalid';
  const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const ageDays = Math.round((today - t) / 86400000);
  if (ageDays < 0) return 'future';
  if (ageDays <= 7) return '<=7d';
  if (ageDays <= 30) return '8-30d';
  return '>30d';
}
