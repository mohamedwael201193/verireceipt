# CORD receipt annotation fixtures

Source: NAVER CLOVA CORD-v2, test split, rows 0, 1, and 2.
Retrieved 2026-11-25 from:
https://datasets-server.huggingface.co/first-rows?dataset=naver-clova-ix%2Fcord-v2&config=default&split=test
Dataset: https://huggingface.co/datasets/naver-clova-ix/cord-v2
License metadata: https://huggingface.co/datasets/naver-clova-ix/cord-v2/raw/main/README.md

Attribution: NAVER CLOVA, CORD dataset. The dataset card states CC BY 4.0. These fixtures retain selected annotation objects, not images. They are test data, never a live receipt or a production answer. Original ground-truth annotations supply the text; no OCR model or language model ran here.

Each annotation JSON retains the source meta, gt_parse and valid_line properties. Each text file groups valid_line words by row_id, sorts rows by their vertical position and words by horizontal position, joins words with spaces, and joins rows with newlines. No amount, label, merchant or date is added. Tests verify this reconstruction.

Row 1 has one supported explicit inline total. Rows 0 and 2 exercise refusal rather than asserting broad receipt support. Removed merchant/date information cannot be recovered. A successful total extraction does not verify the purchase, currency, merchant, date, or completeness of the source.
