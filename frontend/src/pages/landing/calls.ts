// Shared live-call dispatch: one intent key + params -> the lib call.
// Used by the IDE, the desk stage, and the probe so every try-it form
// hits the same real endpoints with the same params.
import { getFilings, getGridPrice, getRoute, getTvl, getTx } from "../../lib/api";
import type {
  FilingsResponse,
  GridPriceResponse,
  RouteResponse,
  TvlResponse,
  TxResponse,
} from "../../lib/types";
import type { IntentKey } from "./data";

export type AnyResponse = TxResponse | FilingsResponse | TvlResponse | RouteResponse | GridPriceResponse;

export async function callLive(key: IntentKey, p: Record<string, string>): Promise<AnyResponse> {
  switch (key) {
    case "tx":
      return getTx({ tx_hash: p.tx_hash, chain: p.chain });
    case "sec":
      return getFilings({ entity: p.entity, period: p.period });
    case "tvl":
      return getTvl({ protocol: p.protocol });
    case "route":
      return getRoute({ pair: p.pair });
    case "grid":
      return getGridPrice({ node_or_zone: p.node_or_zone, interval_start: p.interval_start });
  }
}

/** One-line live outcome for a response (used in desk stream rows). */
export function outcomeFor(key: IntentKey, data: AnyResponse): string {
  switch (key) {
    case "tx": {
      const d = data as TxResponse;
      return `${d.status} · #${d.block_number ?? "—"}`;
    }
    case "sec": {
      const d = data as FilingsResponse;
      return `${d.entity} · ${d.filing_count} filings`;
    }
    case "tvl": {
      const d = data as TvlResponse;
      return `${d.protocol_or_chain} · $${(d.tvl_usd / 1e9).toFixed(2)}B`;
    }
    case "route": {
      const d = data as RouteResponse;
      return `${(d.amount_out / 1e6).toFixed(2)} USDC / ETH`;
    }
    case "grid": {
      const d = data as GridPriceResponse;
      return `${d.node_or_zone} $${d.lmp_usd_per_mwh.toFixed(2)} USD/MWh`;
    }
  }
}
