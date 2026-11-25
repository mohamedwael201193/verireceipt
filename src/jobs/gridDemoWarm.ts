import { gridDemoDeadline } from './gridDemoDeadline';
// Independent fixed-key cache warm, never part of the ordinary source sweep.
import { getGridPrice, saveGridPrice } from '../core/storage';
import { GRID_DEMO_INTERVALS } from './gridFinality';
import { fetchCaisoDamLmp } from './gridIngester';

export const GRID_DEMO_WARM_INTERVAL_MS = 60 * 60 * 1000;
export const GRID_DEMO_WARM_TIMEOUT_MS = 15_000;
const NODE = 'TH_NP15_GEN-APND';
let running = false;
let generation = 0;
let timer: NodeJS.Timeout | null = null;

export async function warmGridDemos(): Promise<void> {
  if (running) return;
  running = true;
  const startedGeneration = generation;
  try {
    for (const interval of GRID_DEMO_INTERVALS) {
      if (startedGeneration !== generation) break;
      const held = await getGridPrice(NODE, interval);
      if (held && held.market === 'CAISO' && Number.isFinite(held.lmp_usd_per_mwh)
        && Number.isFinite(Date.parse(held.ingested_at)) && Date.parse(held.ingested_at) <= Date.now()) continue;
      try {
        const value = await gridDemoDeadline(fetchCaisoDamLmp(NODE, interval, GRID_DEMO_WARM_TIMEOUT_MS));
        if (value && startedGeneration === generation) {
          await saveGridPrice(NODE, interval, value.lmp, 'CAISO', new Date().toISOString(), value.upstreamUrl);
        }
      } catch {
        console.warn(JSON.stringify({ event: 'grid_demo_warm_unavailable', market: 'CAISO' }));
      }
    }
  } finally {
    running = false;
  }
}

export function startGridDemoWarm(): NodeJS.Timeout {
  if (timer) return timer;
  void warmGridDemos().catch(() => {});
  timer = setInterval(() => { void warmGridDemos().catch(() => {}); }, GRID_DEMO_WARM_INTERVAL_MS);
  timer.unref();
  return timer;
}

export function stopGridDemoWarm(): void {
  generation++;
  if (timer) clearInterval(timer);
  timer = null;
}

export function __getGridDemoWarmTimerForTests(): NodeJS.Timeout | null { return timer; }
