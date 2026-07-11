// Batch fetcher: walks the CDR register, pulls every brand's savings +
// term-deposit products, writes data/snapshot.json.
//
//   node fetcher/fetch.js                 full run
//   node fetcher/fetch.js --brand ubank   single brand (substring match)
//   node fetcher/fetch.js --limit 10      first N brands (smoke test)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRegisterBrands, pool } from './cds.js';
import { fetchBrandProducts, NON_RETAIL_BRAND_RX } from './brand.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'data', 'snapshot.json');

const args = process.argv.slice(2);
const argVal = f => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const started = Date.now();
console.log('Fetching CDR register…');
let brands = await fetchRegisterBrands();
brands = brands.filter(b => !NON_RETAIL_BRAND_RX.test(b.name));
// Explicitly excluded lenders.
brands = brands.filter(b => !/^family first$/i.test(b.name.trim()));
console.log(`${brands.length} retail brands with distinct product endpoints`);

const brandFilter = argVal('--brand');
if (brandFilter) brands = brands.filter(b => b.name.toLowerCase().includes(brandFilter.toLowerCase()));
const limit = argVal('--limit');
if (limit) brands = brands.slice(0, parseInt(limit, 10));

const savings = [];
const termDeposits = [];
const mortgages = [];
let failed = [];
let done = 0;

async function harvest(brand, opts) {
  const r = await fetchBrandProducts(brand, opts);
  savings.push(...r.savings);
  termDeposits.push(...r.termDeposits);
  mortgages.push(...r.mortgages);
  return r;
}

await pool(brands, 8, async brand => {
  try {
    const r = await harvest(brand);
    done++;
    console.log(
      `[${done}/${brands.length}] ${brand.name}: ${r.savings.length} savings, ${r.termDeposits.length} TDs, ${r.mortgages.length} loans`
    );
  } catch (e) {
    done++;
    failed.push({ brand, error: e?.message || String(e) });
    console.log(`[${done}/${brands.length}] ${brand.name}: FAILED — ${e?.message}`);
  }
});

// Second pass: retry failures one at a time (some platforms rate-limit
// the concurrent first pass).
if (failed.length) {
  console.log(`\nRetrying ${failed.length} failed brands sequentially…`);
  const stillFailed = [];
  for (const f of failed) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await harvest(f.brand, { detailConcurrency: 2 });
      console.log(`retry ${f.brand.name}: ${r.savings.length} savings, ${r.termDeposits.length} TDs`);
    } catch (e) {
      stillFailed.push({ name: f.brand.name, error: e?.message || String(e) });
      console.log(`retry ${f.brand.name}: still failing — ${e?.message}`);
    }
  }
  failed = stillFailed;
} else {
  failed = [];
}

savings.sort((a, b) => (b.headline.max ?? 0) - (a.headline.max ?? 0));
termDeposits.sort((a, b) => a.bank.localeCompare(b.bank));
mortgages.sort((a, b) => (a.headlineVar ?? 99) - (b.headlineVar ?? 99));

const snapshot = {
  generatedAt: new Date().toISOString(),
  brandCount: brands.length,
  okBrandCount: brands.length - failed.length,
  failed,
  savings,
  termDeposits,
  mortgages,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot));
const kb = Math.round(JSON.stringify(snapshot).length / 1024);
console.log(
  `\nDone in ${Math.round((Date.now() - started) / 1000)}s — ` +
    `${savings.length} savings, ${termDeposits.length} TDs, ${mortgages.length} home loans, ` +
    `${failed.length} brands failed. Snapshot: ${kb} KB -> ${OUT}`
);
