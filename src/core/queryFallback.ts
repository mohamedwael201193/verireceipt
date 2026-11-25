import { isIP } from 'node:net';

// Only use a query fallback when the declared key is absent, never overwrite it.
export function queryFallback(
  query: Record<string, string | undefined>, key: string,
  extract: (text: string) => string | undefined,
): Record<string, string | undefined> {
  if (query[key] !== undefined || query.query === undefined) return query;
  return { ...query, [key]: extract(query.query.trim()) };
}
export function firstIp(text: string): string | undefined {
  return text.split(/\s+/).map(t => t.replace(/^[(["']+|[)\]"',;!?]+$/g, ''))
    .map(t=>t.endsWith('.')?t.slice(0,-1):t).find(t => isIP(t) !== 0);
}
export function firstHostname(text: string): string | undefined {
  for (const token of text.split(/\s+/)) {
    const clean=token.replace(/^[(["']+|[)\]"',;!?]+$/g,'');
    if (/^https?:\/\//i.test(clean)) {
      try { const host=new URL(clean).hostname; if (host) return host; } catch { /* Continue to next token. */ }
    }
    const host=clean.replace(/\.$/,'');
    if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(host)) return host;
  }
  return undefined;
}
