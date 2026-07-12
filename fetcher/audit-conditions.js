// Audit: find savings products the site labels "No conditions" whose raw CDR
// record contains condition-style language we may be missing.
//   node fetcher/audit-conditions.js

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRegisterBrands, cdsGetProductDetail, pool } from './cds.js';
import { ratePartsAt } from '../shared/rates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'snapshot.json')));

const CONDITION_RX =
  /\bmust\b|to qualify|only (?:if|when|available|payable)|provided (?:you|that)|min(?:imum)? (?:monthly )?deposit|deposit at least|deposits? of \$|no withdrawals|no more than \w+ withdrawal|without (?:a |any )?withdrawal|grow(?:s|ing)? (?:your|the)? ?balance|balance (?:must|is higher|increase)|criteria|conditions? (?:apply|are met)|bonus interest/i;

const brands = await fetchRegisterBrands();
const brandUri = new Map(brands.map(b => [b.brandId, b.baseUri]));

// Products the site currently shows as "No conditions"
const noStrings = snapshot.savings.filter(p => {
  const parts = ratePartsAt(p.structures, 10000);
  return parts.max != null && parts.max > 0 && (parts.bonus == null || parts.bonus <= 0);
});
console.log(`${noStrings.length} products currently labelled "No conditions" — auditing raw records…\n`);

const flagged = [];
await pool(noStrings, 8, async p => {
  const uri = brandUri.get(p.brandId);
  if (!uri) return;
  let d;
  try {
    d = await cdsGetProductDetail(uri, p.productId);
  } catch {
    return;
  }
  const texts = [];
  if (d.description) texts.push(['description', d.description]);
  for (const r of d.depositRates || []) {
    if (!['VARIABLE', 'FLOATING', 'MARKET_LINKED', 'BONUS'].includes(r.depositRateType)) continue;
    if (r.additionalInfo) texts.push([r.depositRateType + '.info', r.additionalInfo]);
    if (r.additionalValue && !/^P[\dYMWD]+$/i.test(r.additionalValue))
      texts.push([r.depositRateType + '.value', r.additionalValue]);
    for (const t of r.tiers || []) {
      if (t.additionalInfo) texts.push(['tier.info', t.additionalInfo]);
    }
  }
  const hits = texts.filter(([, t]) => CONDITION_RX.test(t));
  if (hits.length) {
    flagged.push({
      bank: p.bank,
      name: p.name,
      hits: hits.map(([f, t]) => `${f}: ${String(t).slice(0, 160)}`),
    });
  }
});

flagged.sort((a, b) => a.bank.localeCompare(b.bank));
for (const f of flagged) {
  console.log(`■ ${f.bank} — ${f.name}`);
  for (const h of f.hits) console.log(`   ${h.replace(/\s+/g, ' ')}`);
}
console.log(`\n${flagged.length} of ${noStrings.length} flagged`);
