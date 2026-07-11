// Fetch + normalise every savings / term-deposit product for one brand.
// Shared by the batch fetcher and the /api/refresh live endpoint.

import { cdsGetAllProducts, cdsGetProductDetail, pool } from './cds.js';
import {
  normaliseDepositRates,
  normaliseLendingRates,
  bestLendingRateAt,
  ratePartsAt,
  termDepositRates,
  REF_BALANCE,
} from '../shared/rates.js';

const CATEGORIES = ['TRANS_AND_SAVINGS_ACCOUNTS', 'TERM_DEPOSITS', 'RESIDENTIAL_MORTGAGES'];

// This is a retail comparison — skip business/wholesale brands and products.
export const NON_RETAIL_BRAND_RX = /\bbusiness\b|\bwholesale\b|\bcorporate\b|intermediar/i;
const NON_RETAIL_PRODUCT_RX = /\bbusiness\b|\bcorporate\b|\bintermediar/i;
// Green/sustainability products are mostly small add-on loans (solar panels
// etc.) rather than standard mortgages — excluded from the comparison.
const GREEN_ADDON_RX = /green|sustainab|solar|\beco\b|clean energy/i;

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
  const mortgages = [];
  stubs.forEach((stub, i) => {
    const d = details[i];
    if (!d || d.__error) return;

    const common = {
      brandId: brand.brandId,
      bank: brand.name,
      logo: brand.logo,
      productId: d.productId,
      name: d.name || stub.name,
      url: d.applicationUri || d.additionalInformation?.overviewUri || null,
      updated: d.lastUpdated || null,
    };

    if (d.productCategory === 'RESIDENTIAL_MORTGAGES') {
      if (GREEN_ADDON_RX.test(common.name || '')) return;
      const lending = normaliseLendingRates(d.lendingRates);
      if (!lending.length) return;
      // Headline for default sort: variable rate, owner-occupied P&I at 80% LVR.
      const v = bestLendingRateAt(lending, {
        months: null,
        purpose: 'OWNER_OCCUPIED',
        repayment: 'PRINCIPAL_AND_INTEREST',
        lvr: 80,
      });
      mortgages.push({
        ...common,
        lending,
        offset: (d.features || []).some(f => f.featureType === 'OFFSET'),
        headlineVar: v ? v.rate : null,
      });
      return;
    }

    const structures = normaliseDepositRates(d.depositRates);
    if (!structures.length) return;

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

  return { savings, termDeposits, mortgages, productCount: stubs.length };
}
