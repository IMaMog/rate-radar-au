// Shared rate logic — imported by the Node fetcher, the /api/refresh function,
// and the browser app. Keep it dependency-free ESM.

const BASE_TYPES = new Set(['VARIABLE', 'FLOATING', 'MARKET_LINKED']);

export const REF_BALANCE = 10000; // reference balance for headline/default-sort rates

// ---------- ISO 8601 duration (P4M, P1Y, P120D) -> months ----------
export function durationToMonths(v) {
  if (!v || typeof v !== 'string') return null;
  const m = v.trim().toUpperCase().match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/);
  if (!m) return null;
  const [, y, mo, w, d] = m.map(x => (x ? parseInt(x, 10) : 0));
  const months = y * 12 + mo + (w * 7 + d) / 30.44;
  return months > 0 ? Math.round(months * 10) / 10 : null;
}

// ---------- Normalise one raw CDS depositRate row ----------
function normaliseRow(r) {
  const rate = parseFloat(r.rate);
  if (!Number.isFinite(rate)) return null;
  const tiers = (r.tiers || [])
    .filter(t => (t.unitOfMeasure || 'DOLLAR') === 'DOLLAR')
    .map(t => ({
      min: t.minimumValue != null ? parseFloat(t.minimumValue) : 0,
      max: t.maximumValue != null ? parseFloat(t.maximumValue) : null,
      method: t.rateApplicationMethod || 'WHOLE_BALANCE',
    }));
  return {
    type: r.depositRateType,
    rate,
    tiers: tiers.length ? tiers : null,
    // additionalValue is the condition text for BONUS, a duration for INTRODUCTORY/FIXED
    value: r.additionalValue ? String(r.additionalValue).slice(0, 600) : null,
    info: r.additionalInfo ? String(r.additionalInfo).slice(0, 600) : null,
    freq: r.applicationFrequency || null,
  };
}

export function normaliseDepositRates(depositRates) {
  return (depositRates || []).map(normaliseRow).filter(Boolean);
}

// ---------- Effective-rate maths ----------
// Group rows belonging to the same scheme (banks emit one row per balance tier).
function schemeKey(row) {
  return `${row.type}|${row.info || ''}|${row.type === 'INTRODUCTORY' ? '' : row.value || ''}`;
}

// Rate a single scheme pays on `balance`, honouring tier method.
// Banks often publish several rows covering the SAME balance band (payment
// options, duplicates) — overlapping bands take the max rate, never a sum.
function schemeRateAt(rows, balance) {
  const untiered = rows.filter(r => !r.tiers);
  let best = untiered.length ? Math.max(...untiered.map(r => r.rate)) : null;

  const pairs = rows
    .filter(r => r.tiers)
    .flatMap(r => r.tiers.map(t => ({ ...t, rate: r.rate })));

  // WHOLE_BALANCE: best rate among tiers containing the balance.
  for (const p of pairs) {
    if (p.method === 'PER_TIER') continue;
    if (balance >= p.min && (p.max == null || balance <= p.max)) {
      best = best == null ? p.rate : Math.max(best, p.rate);
    }
  }

  // PER_TIER: blend across bands up to the balance, max rate within each band.
  const pt = pairs.filter(p => p.method === 'PER_TIER' && p.min < balance);
  if (pt.length) {
    const cuts = new Set([0, balance]);
    for (const p of pt) {
      if (p.min > 0 && p.min < balance) cuts.add(p.min);
      if (p.max != null && p.max < balance) cuts.add(p.max);
    }
    const edges = [...cuts].sort((a, b) => a - b);
    let earned = 0, covered = 0;
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1], mid = (lo + hi) / 2;
      let r = null;
      for (const p of pt) {
        if (mid >= p.min && (p.max == null || mid <= p.max)) {
          r = r == null ? p.rate : Math.max(r, p.rate);
        }
      }
      if (r != null) { earned += (hi - lo) * r; covered += hi - lo; }
    }
    if (covered > 0) {
      const blended = earned / balance;
      best = best == null ? blended : Math.max(best, blended);
    }
  }
  return best;
}

// Bonus text saying the rate is the TOTAL payable, not an increment on base.
const TOTAL_RATE_RX =
  /total (?:rate|interest)|inclusive of (?:the )?(?:standard|base)|includes (?:the )?(?:standard|base)/i;
// Discretionary/targeted bonuses not generally available — excluded from ranking.
const DISCRETIONARY_RX = /selected customers|from time to time|by invitation/i;

/**
 * Compute the rate picture for a savings product at a given balance.
 * Bonus schemes are NOT summed across distinct schemes — we take the best one
 * (conservative: avoids double-counting when banks restate one bonus two ways).
 * Bonuses worded as "total rate" replace the base instead of stacking on it;
 * discretionary "selected customers" bonuses are ignored for the headline.
 */
export function ratePartsAt(structures, balance = REF_BALANCE) {
  const groups = new Map();
  for (const row of structures) {
    const k = schemeKey(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }

  let base = null, intro = null;
  const bonusGroups = [];
  for (const rows of groups.values()) {
    const type = rows[0].type;
    const r = schemeRateAt(rows, balance);
    if (r == null) continue;
    if (BASE_TYPES.has(type)) {
      base = base == null ? r : Math.max(base, r);
    } else if (type === 'BONUS') {
      // Some banks put an ISO duration (e.g. "P1M") where condition text belongs.
      const texts = [rows[0].value, rows[0].info].filter(
        t => t && !/^P[\dYMWD]+$/i.test(t.trim())
      );
      bonusGroups.push({ rate: r, text: texts[0] || '' });
    } else if (type === 'INTRODUCTORY') {
      const months = durationToMonths(rows[0].value);
      if (!intro || r > intro.rate) intro = { rate: r, months };
    }
  }

  let max = base, bonus = null, bonusConditions = null;
  for (const g of bonusGroups) {
    if (DISCRETIONARY_RX.test(g.text)) continue;
    const candidate = TOTAL_RATE_RX.test(g.text)
      ? Math.max(base ?? 0, g.rate)
      : (base ?? 0) + g.rate;
    if (max == null || candidate > max) {
      max = candidate;
      bonus = candidate - (base ?? 0);
      bonusConditions = g.text || null;
    }
  }

  return { base, bonus, bonusConditions, intro, max };
}

// ---------- Term deposits ----------
// FIXED rows: additionalValue = term duration, tiers = deposit-amount bands.
export function termDepositRates(structures) {
  const out = [];
  for (const row of structures) {
    if (row.type !== 'FIXED') continue;
    const months = durationToMonths(row.value);
    if (months == null) continue;
    const tiers = row.tiers || [{ min: 0, max: null }];
    for (const t of tiers) {
      out.push({ months, rate: row.rate, min: t.min, max: t.max, freq: row.freq, info: row.info });
    }
  }
  return out;
}

// Best TD rate for a given term (months) and deposit size.
export function bestTdRateAt(tdRates, months, deposit) {
  let best = null;
  for (const r of tdRates) {
    if (Math.round(r.months) !== months) continue;
    if (deposit < r.min || (r.max != null && deposit > r.max)) continue;
    if (best == null || r.rate > best) best = r.rate;
  }
  return best;
}

export const fmtPct = r => (r == null ? '—' : (r * 100).toFixed(2) + '%');
