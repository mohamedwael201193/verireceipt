import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { dominantChainTvl } from '../src/handlers/tvl';

// Additional real catalog fields, selected before handler edits. These
// isolated source-key projections do not invent a positive metric value
// where the real source reports zero, or claim a new full API response.
const source = JSON.parse(readFileSync(join(__dirname, 'fixtures/tvl-chain-other-metrics-real-sources.json'), 'utf8'));
interface Example { metric: string; entry: { slug: string; chains: string[]; chainTvls: Record<string, number> }; }
for (const item of source.cases as Example[]) {
  it(`${item.metric}: the captured bare/suffixed metric projection is not a chain reading`, () => {
    const map = Object.fromEntries(Object.entries(item.entry.chainTvls).filter(([key]) => {
      const lower = key.toLowerCase(); return lower === item.metric || lower.endsWith('-' + item.metric);
    }));
    expect(Object.keys(map).length).toBeGreaterThan(0);
    expect(dominantChainTvl(map)).toBeNull();
  });
  it(`${item.metric}: preserves the captured actual named-chain projection`, () => {
    const map = Object.fromEntries(Object.entries(item.entry.chainTvls).filter(([key]) => item.entry.chains.includes(key)));
    const positive = Object.values(map).filter(value => Number.isFinite(value) && value > 0);
    expect(dominantChainTvl(map)).toBe(positive.length ? Math.max(...positive) : null);
  });
}
