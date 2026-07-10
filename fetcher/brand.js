// Fetch + normalise every savings / term-deposit product for one brand.
// Shared by the batch fetcher and the /api/refresh live endpoint.

import { cdsGetAllProducts, cdsGetProductDetail, pool } from './cds.js';
import {
  normaliseDepositRates,
  ratePartsAt,
  termDepositRates,
  REF_BALANCE,
} from '../shared/rates.js';

const CATEGORIES = ['TRANS_AND_SAVINGS_ACCOUNTS', 'TERM_DEPOSITS'];

// This is a retail comparison — skip business/wholesale brands and products.
export const NON_RETAIL_BRAND_RX = /\bbusiness\b|\bwholesale\b|\bcorporate\b|intermediar/i;
const NON_RETAIL_PRODUCT_RX = /\bbusiness\b|\bcorporate\b|\bintermediar/i;

export async function fetchBrandProducts(brand, { detailConcurrency = 5 } = {}) {
  const lists = await Promise.all(
    CATEGORIES.map(c => cdsGetAllProducts(brand.baseUri, c).catch(() => null))
  );
  if (lists.every(l => l === null)) throw new Error('product list unavailable');

  const stubs = [];
  lists.forEach((list, i) => {
    for (const p of list || []) {
      if (p.productCategory !== CATEGORIES[i]) continue;
      if (NON_RETAIL_PRODUCT_RX.test(p.name || '')) continue;
      stubs.push(p);
    }
  });

  const details = await pool(stubs, detailConcurrency, s =>
    cdsGetProductDetail(brand.baseUri, s.productId)
  );

  const savings = [];
  const termDeposits = [];
  stubs.forEach((stub, i) => {
    const d = details[i];
    if (!d || d.__error) return;
    const structures = normaliseDepositRates(d.depositRates);
    if (!structures.length) return;

    const common = {
      brandId: brand.brandId,
      bank: brand.name,
      logo: brand.logo,
      productId: d.productId,
      name: d.name || stub.name,
      url: d.applicationUri || d.additionalInformation?.overviewUri || null,
      updated: d.lastUpdated || null,
    };

    // Some banks miscategorise term deposits under savings — route by content.
    const tdRates = termDepositRates(structures);
    const isTd =
      d.productCategory === 'TERM_DEPOSITS' ||
      (tdRates.length > 0 && /term deposit/i.test(common.name || ''));
    if (isTd) {
      if (tdRates.length) termDeposits.push({ ...common, rates: tdRates });
    } else {
      const parts = ratePartsAt(structures, REF_BALANCE);
      if (parts.max == null) return;
      savings.push({ ...common, structures, headline: parts });
    }
  });

  return { savings, termDeposits, productCount: stubs.length };
}
