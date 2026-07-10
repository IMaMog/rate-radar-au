# Rate Radar AU 📡

Savings-account and term-deposit interest rates for **every retail Australian ADI**, compiled
from the official Open Banking (Consumer Data Right) **Product Reference Data** APIs — the
public, no-auth endpoints every bank is legally required to publish.

No scraping, no API keys: one call to the ACCC's CDR register enumerates ~115 brands, then
each brand's standardised `/cds-au/v1/banking/products` endpoint supplies the rates.

## How it works

```
ACCC CDR register ──► brand list (name, logo, product API base URI)
      │
      ▼  (per brand, ~8 concurrent)
GET /banking/products?product-category=TRANS_AND_SAVINGS_ACCOUNTS | TERM_DEPOSITS
GET /banking/products/{id}   ──► depositRates (base / bonus / intro / fixed, tiers)
      │
      ▼  normalise (shared/rates.js)
data/snapshot.json  ──► static frontend (index.html + app.js)
                         └► /api/refresh?brandId=…  (live per-bank re-fetch on Vercel)
```

- **`fetcher/`** — Node scripts. `node fetcher/fetch.js` does a full run (~1–2 min);
  `--limit 8` for a smoke test, `--brand ubank` for one brand. Failed brands are retried
  sequentially, then recorded in the snapshot and shown in the site footer.
- **`shared/rates.js`** — the normalisation brain, shared by fetcher, API and browser:
  ISO-duration parsing, balance-tier maths (PER_TIER blending, overlapping-band dedupe),
  and bonus-rate semantics (see caveats).
- **`data/snapshot.json`** — the daily snapshot the site reads. Refreshed by the GitHub
  Action at the repo root (`.github/workflows/refresh-rates.yml`, 5:10am AEST daily).
- **`api/refresh.js`** — Vercel serverless function for the "Refresh from bank" button:
  re-fetches a single brand live (brandId is resolved via the register — caller-supplied
  URLs are never fetched).

## Rate semantics & caveats

Banks publish rate data inconsistently; the normaliser applies these rules:

- **Max rate = base + best bonus** at the selected balance, honouring balance tiers.
  Distinct bonus schemes are never summed (avoids double-counting restated bonuses).
- Bonuses worded as a **"total rate"** replace the base instead of stacking.
- **Discretionary bonuses** ("selected customers", "from time to time") are excluded from
  rankings but still visible in the product drawer.
- **Introductory rates** are shown as a separate badge/field, never folded into max rate.
- Overlapping tier rows for the same band (payment-frequency variants, duplicates) take
  the **max** rate, never a sum.
- Business/wholesale brands and products are filtered out — this is a retail comparison.

Every product drawer shows the bank's raw published rate rows, so the fine print is always
one click away. Not financial advice; confirm with the bank before opening an account.

## Develop / deploy

```sh
node fetcher/fetch.js        # regenerate data/snapshot.json
python -m http.server 4173   # serve locally (any static server works)
```

Deploy on Vercel with this folder (`Interest rates/`) as the project root — static files
plus `api/refresh.js` work out of the box; `vercel.json` sets function timeout and snapshot
caching. URL niceties: `?theme=dark|light` forces a theme, `#td` opens the term-deposits tab.
