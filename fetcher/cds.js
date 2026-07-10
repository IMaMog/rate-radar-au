// Low-level CDS (Consumer Data Standards) HTTP helpers:
// version negotiation, timeouts, retries, pagination.

const TIMEOUT_MS = 25000;

async function httpJson(url, headers, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function isUnsupportedVersion(r) {
  if (r.status === 406) return true;
  const code = r.json?.errors?.[0]?.code || '';
  return /UnsupportedVersion|InvalidVersion/i.test(code);
}

/**
 * CDS GET with x-v negotiation. Spec-compliant holders answer with their
 * highest supported version inside [x-min-v, x-v]; buggy ones want an exact
 * x-v, so we fall back through explicit versions.
 */
export async function cdsGet(url, { maxV = 8, fallbacks = [4, 3, 5, 2, 1] } = {}) {
  let res = await httpJson(url, { 'x-v': String(maxV), 'x-min-v': '1' });
  if (res.json?.data) return res.json;
  if (isUnsupportedVersion(res)) {
    for (const v of fallbacks) {
      res = await httpJson(url, { 'x-v': String(v) });
      if (res.json?.data) return res.json;
      if (!isUnsupportedVersion(res)) break;
    }
  }
  const detail = res.json?.errors?.[0]?.title || `HTTP ${res.status}`;
  throw new Error(detail);
}

export async function withRetry(fn, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

/** GET all pages of a CDS list endpoint (data.products). */
export async function cdsGetAllProducts(baseUri, category) {
  const base = baseUri.replace(/\/+$/, '');
  const products = [];
  let page = 1, totalPages = 1;
  do {
    const url = `${base}/cds-au/v1/banking/products?product-category=${category}&page-size=1000&page=${page}&effective=CURRENT`;
    const body = await withRetry(() => cdsGet(url));
    products.push(...(body.data?.products || []));
    totalPages = Math.min(body.meta?.totalPages || 1, 20);
    page++;
  } while (page <= totalPages);
  return products;
}

export async function cdsGetProductDetail(baseUri, productId) {
  const base = baseUri.replace(/\/+$/, '');
  const url = `${base}/cds-au/v1/banking/products/${encodeURIComponent(productId)}`;
  const body = await withRetry(() => cdsGet(url, { fallbacks: [6, 5, 4, 3, 2, 1] }));
  return body.data;
}

/** Simple promise pool. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i).catch(e => ({ __error: e?.message || String(e) }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const REGISTER_URL =
  'https://api.cdr.gov.au/cdr-register/v1/banking/data-holders/brands/summary';

/** All banking data-holder brands from the ACCC CDR register. */
export async function fetchRegisterBrands() {
  const res = await httpJson(REGISTER_URL, { 'x-v': '2' });
  if (!res.json?.data) throw new Error(`Register fetch failed (HTTP ${res.status})`);
  // Dedupe brands that share a product endpoint (white-label platforms).
  const seen = new Set();
  const brands = [];
  for (const b of res.json.data) {
    const uri = (b.productBaseUri || b.publicBaseUri || '').replace(/\/+$/, '');
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    brands.push({
      brandId: b.dataHolderBrandId,
      name: b.brandName,
      logo: b.logoUri || null,
      baseUri: uri,
    });
  }
  return brands;
}
