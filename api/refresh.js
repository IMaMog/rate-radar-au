// Vercel serverless function: live-refresh one brand's products straight
// from the bank's CDR endpoint (the "hybrid" layer on top of the daily
// snapshot). GET /api/refresh?brandId=<dataHolderBrandId>

import { fetchRegisterBrands } from '../fetcher/cds.js';
import { fetchBrandProducts } from '../fetcher/brand.js';

let registerCache = { at: 0, brands: null };
const REGISTER_TTL_MS = 6 * 60 * 60 * 1000;

export default async function handler(req, res) {
  const brandId = req.query?.brandId;
  if (!brandId) {
    res.status(400).json({ error: 'brandId query parameter required' });
    return;
  }
  try {
    if (!registerCache.brands || Date.now() - registerCache.at > REGISTER_TTL_MS) {
      registerCache = { at: Date.now(), brands: await fetchRegisterBrands() };
    }
    // Resolve via the register (never fetch a caller-supplied URL).
    const brand = registerCache.brands.find(b => b.brandId === brandId);
    if (!brand) {
      res.status(404).json({ error: 'Unknown brandId' });
      return;
    }
    const result = await fetchBrandProducts(brand, { detailConcurrency: 4 });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      brandId: brand.brandId,
      bank: brand.name,
      fetchedAt: new Date().toISOString(),
      savings: result.savings,
      termDeposits: result.termDeposits,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || 'Upstream fetch failed' });
  }
}
