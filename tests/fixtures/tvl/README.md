# Parent protocol regression snapshots

Observed on November 22, 2026, around 03:16 UTC.

- `parent-protocols.json`: selected scalar fields and exact parentProtocol relationships from https://api.llama.fi/protocols . Includes all Curve Finance children plus explicit-version regression rows.
- `curve-finance-tvl.txt`: exact bare-number response from https://api.llama.fi/tvl/curve-finance . This is the parent aggregate, not the Curve DEX child.
- Parent identity was also checked against https://api.llama.fi/protocol/curve-finance , which reports id `parent#curve-finance` and isParentProtocol true. Its approximately 31.9 MB history is not needed for the small primary total read.

The committed catalog seed was refreshed from the real protocols endpoint and https://api.llama.fi/v2/chains . Its timestamp is the older download's observed filesystem time, not a new freshness claim for older values. Runtime metadata upgrades merge only exact child-to-parent relationships; they do not refresh cached numeric values.
