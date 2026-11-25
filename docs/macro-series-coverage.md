# Annual macro series coverage

New aliases select exact World Bank annual series, not substitutes:

| Input family | Series | Unit |
| --- | --- | --- |
| GDP, nominal GDP | NY.GDP.MKTP.CD | current US dollars |
| Real GDP, GDP constant | NY.GDP.MKTP.KD | constant2015US dollars |
| Interest rate, real interest rate | FR.INR.RINR | percent real interest rate |
| Trade percent of GDP | NE.TRD.GNFS.ZS | exports plus imports of goods and services as percent of GDP |

The real GDP reference year2015 is from the recorded API metadata. Real interest rate is a lending interest rate adjusted using the GDP deflator, not a policy rate; this limitation is stated even for bare "interest rate". GDP growth and GDP per capita retain their original series. Country resolution and annual selection are unchanged. Unknown measures still refuse, rather than choosing a nearby number.

GDP amounts are not percentages and never populate rate_pct. Published values outside that scored0-100field remain disclosed in the answer with rate_pct null; nothing is clamped. No separate export or import series was added. Live metadata and exact annual observation captures, URLs and hashes are recorded in tests/fixtures/macro-series/PROVENANCE.json.
