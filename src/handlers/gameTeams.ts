export function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function teamNameMatches(asked: string, carried: string): boolean {
  const a = norm(asked);
  const b = norm(carried);
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  const ta = a.split(" ");
  const tb = new Set(b.split(" "));
  const inter = ta.filter((t) => tb.has(t)).length;
  return (2 * inter) / (ta.length + tb.size) >= 0.6;
}

