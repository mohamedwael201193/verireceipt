# BIN network-label comparison

Live26November2026plain200bodies for457100:
- https://lookup.binlist.net/457100 returns scheme visa, debit, Nordea Bank Danmark A/S, Denmark.
- https://api.dharun.dev/v1/bin/457100 returns network VISA/DANKORT, DEBIT, NORDEA BANK DANMARK A/S, DENMARK.

Compare network labels using slash-first token, trim, lowercase, so VISA/DANKORT versus visa is not a false conflict. Preserve the source-labelled full slash co-brand network in network_co_brand_labels. Existing field precedence and answer rendering unchanged; provider raw bytes and co-brand metadata retained in receipt. Actual visa versus mastercard (including mastercard/dankort) remains a network conflict. No bank/country/card-type comparison changes, no wider normalization or source change. No full card number used.
