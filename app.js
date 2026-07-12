import {
  ratePartsAt,
  bestTdRateAt,
  bestLendingRateAt,
  fmtPct,
  REF_BALANCE,
} from './shared/rates.js';

const $ = id => document.getElementById(id);

const state = {
  data: null,
  section: 'deposits',
  tab: 'savings',
  balance: REF_BALANCE,
  search: '',
  noStrings: false,
  savingsSort: { key: 'max', dir: -1 },
  tdSort: { key: 12, dir: -1 },
  tdTerms: [],
  // Home loans
  mPurpose: 'OWNER_OCCUPIED',
  mRepay: 'PRINCIPAL_AND_INTEREST',
  mLvr: 80,
  mSearch: '',
  mOffset: false,
  mRateType: 'VARIABLE',
  mFixedMonths: 24,
  mSort: { key: 'rate', dir: 1 }, // ascending: lower is better
  mTerms: [],
  liveBrands: new Set(), // brands refreshed live this session
  drawerKey: null,
  // Investing (brokers)
  brokers: [],
  tradeSize: 2000,
  iSearch: '',
  iChess: false,
  iPromo: false,
  iSort: { key: 'asx', dir: 1 }, // ascending: cheaper is better
  // Pagination
  pageSize: 10,
  sPage: 1,
  tdPage: 1,
  mPage: 1,
  iPage: 1,
};

// ---------- Pagination ----------
const PAGE_SIZES = [10, 25, 50, 100];

function paginate(rows, pageKey) {
  const maxPage = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state[pageKey] = Math.min(Math.max(1, state[pageKey]), maxPage);
  const page = state[pageKey];
  const start = (page - 1) * state.pageSize;
  return { slice: rows.slice(start, start + state.pageSize), page, maxPage, total: rows.length, start };
}

function renderPager(el, pg, pageKey) {
  if (pg.total <= PAGE_SIZES[0]) { el.innerHTML = ''; return; }
  const end = Math.min(pg.start + state.pageSize, pg.total);
  el.innerHTML = `
    <span class="pg-status">Showing ${pg.start + 1}–${end} of ${pg.total}</span>
    <span class="pager-right">
      <label class="page-size-wrap">Per page
        <select class="page-size" data-pagekey="${pageKey}">
          ${PAGE_SIZES.map(s => `<option value="${s}" ${s === state.pageSize ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </label>
      <button class="pg-btn" data-pagekey="${pageKey}" data-pg="prev" ${pg.page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
      <span class="pg-status">Page ${pg.page} of ${pg.maxPage}</span>
      <button class="pg-btn" data-pagekey="${pageKey}" data-pg="next" ${pg.page >= pg.maxPage ? 'disabled' : ''} aria-label="Next page">›</button>
    </span>`;
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.pg-btn[data-pg]');
  if (!btn || btn.disabled) return;
  const k = btn.dataset.pagekey;
  state[k] += btn.dataset.pg === 'next' ? 1 : -1;
  renderAll(false);
});
document.addEventListener('change', e => {
  const sel = e.target.closest('.page-size');
  if (!sel) return;
  state.pageSize = parseInt(sel.value, 10);
  state.sPage = state.tdPage = state.mPage = state.iPage = 1;
  renderAll(false);
});

const keyOf = p => `${p.brandId}|${p.productId}`;
const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
const fmtMoney = n => '$' + Math.round(n).toLocaleString('en-AU');

// ---------- Data load ----------
async function load() {
  $('loading').hidden = false;
  $('load-error').hidden = true;
  try {
    const res = await fetch('data/snapshot.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    // Broker data is hand-curated and optional — the site works without it.
    try {
      const bres = await fetch('data/brokers.json', { cache: 'no-cache' });
      if (bres.ok) {
        state.brokers = (await bres.json())
          .filter(b => b.active !== false)
          .map(b => ({ ...b, brandId: 'brokers', productId: b.id, bank: b.name, logo: null }));
      }
    } catch { /* keep [] */ }
    $('loading').hidden = true;
    $('app').hidden = false;
    $('report-fab').hidden = false;
    initDerived();
    renderAll();
  } catch (e) {
    $('loading').hidden = true;
    $('load-error').hidden = false;
  }
}

function initDerived() {
  // Term columns: most common terms across TD products, ascending.
  const counts = new Map();
  for (const p of state.data.termDeposits) {
    const seen = new Set();
    for (const r of p.rates) {
      const m = Math.round(r.months);
      if (!seen.has(m)) { seen.add(m); counts.set(m, (counts.get(m) || 0) + 1); }
    }
  }
  state.tdTerms = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(e => e[0])
    .sort((a, b) => a - b);
  if (!state.tdTerms.includes(state.tdSort.key)) {
    state.tdSort.key = state.tdTerms.includes(12) ? 12 : state.tdTerms[0];
  }

  // Fixed-term columns for home loans: most common fixed terms, ascending.
  const fixedCounts = new Map();
  for (const p of state.data.mortgages || []) {
    const seen = new Set();
    for (const r of p.lending) {
      if (r.type !== 'FIXED' || r.months == null) continue;
      const m = Math.round(r.months);
      if (!seen.has(m)) { seen.add(m); fixedCounts.set(m, (fixedCounts.get(m) || 0) + 1); }
    }
  }
  state.mTerms = [...fixedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(e => e[0])
    .sort((a, b) => a - b);
  if (!state.mTerms.includes(state.mFixedMonths)) state.mFixedMonths = state.mTerms[0] ?? 24;
  $('term-chips').innerHTML = state.mTerms
    .map(
      m =>
        `<button class="chip ${m === state.mFixedMonths ? 'active' : ''}" data-months="${m}">${m % 12 === 0 ? m / 12 + ' yr' : m + ' mo'}</button>`
    )
    .join('');

  const d = new Date(state.data.generatedAt);
  const hrs = Math.max(0, Math.round((Date.now() - d) / 36e5));
  const rel = hrs < 1 ? 'just now' : hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
  const badge = $('updated-badge');
  badge.textContent = `Updated ${rel}`;
  badge.title = `Snapshot generated ${d.toLocaleString('en-AU')}`;
}

// ---------- Shared row helpers ----------
function bankCell(p) {
  const initials = esc(p.bank.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase());
  const live = state.liveBrands.has(p.brandId)
    ? ' <span class="badge badge-intro" title="Refreshed live from the bank this session">live</span>'
    : '';
  const logo = p.logo
    ? `<img class="bank-logo" src="${esc(p.logo)}" alt="" loading="lazy"
         onerror="this.outerHTML='<span class=&quot;bank-avatar&quot;>${initials}</span>'" />`
    : `<span class="bank-avatar">${initials}</span>`;
  return `<div class="bank-cell">${logo}<span class="bank-name">${esc(p.bank)}${live}</span></div>`;
}

function matchesSearch(p) {
  if (!state.search) return true;
  return (p.bank + ' ' + p.name).toLowerCase().includes(state.search);
}

const eligBadges = p =>
  (p.elig || [])
    .map(e => `<span class="badge badge-elig" title="Eligibility restriction">${esc(e)}</span>`)
    .join('');

// ---------- Savings ----------
function savingsRows() {
  // The lowest-earning 10% of accounts at the current balance are always
  // excluded. Percentile computed over ALL savings products (not the
  // searched subset), so the threshold is stable.
  let cutoff = -Infinity;
  const all = state.data.savings
    .map(p => ratePartsAt(p.structures, state.balance).max)
    .filter(m => m != null && m > 0)
    .sort((a, b) => a - b);
  if (all.length) cutoff = all[Math.floor(all.length * 0.1)];

  const rows = [];
  for (const p of state.data.savings) {
    if (!matchesSearch(p)) continue;
    const parts = ratePartsAt(p.structures, state.balance);
    if (parts.max == null || parts.max <= 0) continue;
    if (parts.max < cutoff) continue;
    const noStrings = parts.bonus == null || parts.bonus <= 0;
    if (state.noStrings && !noStrings) continue;
    rows.push({ p, parts, noStrings });
  }
  const { key, dir } = state.savingsSort;
  rows.sort((a, b) => {
    if (key === 'bank') return dir * a.p.bank.localeCompare(b.p.bank);
    const av = a.parts[key] ?? -1, bv = b.parts[key] ?? -1;
    return dir * (av - bv) || a.p.bank.localeCompare(b.p.bank);
  });
  return rows;
}

function renderSavings(rows) {
  const maxRate = rows.reduce((m, r) => Math.max(m, r.parts.max), 0) || 1;
  const pg = paginate(rows, 'sPage');
  const html = pg.slice
    .map((r, i) => {
      const { p, parts } = r;
      const intro = parts.intro
        ? `<span class="badge badge-intro" title="Introductory offer">+${(parts.intro.rate * 100).toFixed(2)}% intro${parts.intro.months ? ` · ${Math.round(parts.intro.months)} mo` : ''}</span>`
        : '';
      const condText = parts.bonusConditions || 'Conditions apply — see details';
      const cond = r.noStrings
        ? '<span class="badge badge-nostrings">No conditions</span>'
        : `<span title="${esc(condText)}">${esc(condText)}</span>`;
      const barW = Math.max(4, Math.round((parts.max / maxRate) * 64));
      return `<tr data-key="${esc(keyOf(p))}">
        <td class="col-rank">${pg.start + i + 1}</td>
        <td>${bankCell(p)}</td>
        <td class="product-cell"><span class="product-name">${esc(p.name)}</span>${intro}${eligBadges(p)}</td>
        <td class="rate-cell rate-max">${fmtPct(parts.max)}<span class="rate-bar" style="width:${barW}px"></span></td>
        <td class="rate-cell">${fmtPct(parts.base)}</td>
        <td><div class="cond-cell">${cond}</div></td>
      </tr>`;
    })
    .join('');
  $('savings-body').innerHTML = html;
  $('savings-empty').hidden = rows.length > 0;
  renderPager($('savings-pager'), pg, 'sPage');
  $('count-savings').textContent = `(${rows.length})`;
  $('at-balance-note').textContent = `at ${fmtMoney(state.balance)}`;

  for (const th of document.querySelectorAll('#savings-table th.sortable')) {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.savingsSort.key) {
      th.classList.add(state.savingsSort.dir === 1 ? 'sorted-asc' : 'sorted-desc');
    }
  }
}

// ---------- Term deposits ----------
function tdRows() {
  const rows = [];
  for (const p of state.data.termDeposits) {
    if (!matchesSearch(p)) continue;
    const byTerm = {};
    let any = false;
    for (const m of state.tdTerms) {
      const r = bestTdRateAt(p.rates, m, state.balance);
      byTerm[m] = r;
      if (r != null) any = true;
    }
    if (any) rows.push({ p, byTerm });
  }
  const { key, dir } = state.tdSort;
  rows.sort((a, b) => {
    if (key === 'bank') return dir * a.p.bank.localeCompare(b.p.bank);
    return dir * ((a.byTerm[key] ?? -1) - (b.byTerm[key] ?? -1)) || a.p.bank.localeCompare(b.p.bank);
  });
  return rows;
}

function renderTd(rows) {
  const fmtTerm = m => (m % 12 === 0 ? `${m / 12} yr` : `${m} mo`);
  const head = `<tr>
    <th class="col-rank">#</th>
    <th class="col-bank sortable ${state.tdSort.key === 'bank' ? (state.tdSort.dir === 1 ? 'sorted-asc' : 'sorted-desc') : ''}" data-sort="bank">Bank</th>
    <th class="col-product">Product</th>
    ${state.tdTerms
      .map(
        m =>
          `<th class="col-rate sortable ${state.tdSort.key === m ? (state.tdSort.dir === 1 ? 'sorted-asc' : 'sorted-desc') : ''}" data-sort="${m}">${fmtTerm(m)}</th>`
      )
      .join('')}
  </tr>`;
  $('td-head').innerHTML = head;

  const best = {};
  for (const m of state.tdTerms) {
    best[m] = rows.reduce((mx, r) => Math.max(mx, r.byTerm[m] ?? 0), 0);
  }
  const pg = paginate(rows, 'tdPage');
  $('td-body').innerHTML = pg.slice
    .map(
      (r, i) => `<tr data-key="${esc(keyOf(r.p))}">
      <td class="col-rank">${pg.start + i + 1}</td>
      <td>${bankCell(r.p)}</td>
      <td class="product-cell"><span class="product-name">${esc(r.p.name)}</span>${eligBadges(r.p)}</td>
      ${state.tdTerms
        .map(m => {
          const v = r.byTerm[m];
          const top = v != null && v === best[m] && v > 0;
          return `<td class="rate-cell ${top ? 'rate-max' : ''}">${fmtPct(v)}</td>`;
        })
        .join('')}
    </tr>`
    )
    .join('');
  $('td-empty').hidden = rows.length > 0;
  renderPager($('td-pager'), pg, 'tdPage');
  $('count-td').textContent = `(${rows.length})`;
}

// ---------- Home loans ----------
function loanFilters(months) {
  return { months, purpose: state.mPurpose, repayment: state.mRepay, lvr: state.mLvr };
}

const selectedMonths = () => (state.mRateType === 'FIXED' ? state.mFixedMonths : null);

function loansRows() {
  const months = selectedMonths();
  const rows = [];
  for (const p of state.data.mortgages || []) {
    if (state.mSearch && !(p.bank + ' ' + p.name).toLowerCase().includes(state.mSearch)) continue;
    if (state.mOffset && !p.offset) continue;
    const entry = bestLendingRateAt(p.lending, loanFilters(months));
    if (entry) rows.push({ p, entry });
  }
  const { key, dir } = state.mSort;
  rows.sort((a, b) => {
    if (key === 'bank') return dir * a.p.bank.localeCompare(b.p.bank);
    const val = r => (key === 'comp' ? r.entry.comparison : r.entry.rate);
    const av = val(a) ?? (dir === 1 ? Infinity : -Infinity);
    const bv = val(b) ?? (dir === 1 ? Infinity : -Infinity);
    return dir * (av - bv) || a.p.bank.localeCompare(b.p.bank);
  });
  return rows;
}

const fmtLoanTerm = m => (m % 12 === 0 ? `${m / 12} yr fixed` : `${m} mo fixed`);

function renderLoans(rows) {
  const sortCls = k =>
    state.mSort.key === k ? (state.mSort.dir === 1 ? 'sorted-asc' : 'sorted-desc') : '';
  const months = selectedMonths();
  const rateLabel = months == null ? 'Variable rate' : fmtLoanTerm(months);
  $('loans-head').innerHTML = `<tr>
    <th class="col-rank">#</th>
    <th class="col-bank sortable ${sortCls('bank')}" data-sort="bank">Lender</th>
    <th class="col-product">Loan</th>
    <th class="col-rate sortable ${sortCls('rate')}" data-sort="rate">${rateLabel}</th>
    <th class="col-rate sortable ${sortCls('comp')}" data-sort="comp">Comparison rate</th>
  </tr>`;

  const bestRate = rows.reduce((mn, r) => Math.min(mn, r.entry.rate), Infinity);
  const pg = paginate(rows, 'mPage');
  $('loans-body').innerHTML = pg.slice
    .map(
      (r, i) => `<tr data-key="${esc(keyOf(r.p))}">
      <td class="col-rank">${pg.start + i + 1}</td>
      <td>${bankCell(r.p)}</td>
      <td class="product-cell"><span class="product-name">${esc(r.p.name)}</span>${r.p.offset ? '<span class="badge badge-intro" title="Comes with an offset account">Offset</span>' : ''}</td>
      <td class="rate-cell ${r.entry.rate === bestRate ? 'rate-max' : ''}">${fmtPct(r.entry.rate)}</td>
      <td class="rate-cell">${r.entry.comparison != null ? fmtPct(r.entry.comparison) : '—'}</td>
    </tr>`
    )
    .join('');
  $('loans-empty').hidden = rows.length > 0;
  renderPager($('loans-pager'), pg, 'mPage');
}

function renderLoanStats() {
  const lowestAt = months => {
    let best = null;
    for (const p of state.data.mortgages || []) {
      const r = bestLendingRateAt(p.lending, loanFilters(months));
      if (r && (!best || r.rate < best.rate)) best = { ...r, p };
    }
    return best;
  };
  const setTile = (id, best) => {
    $(id).textContent = best ? fmtPct(best.rate) : '—';
    $(id + '-sub').textContent = best ? `${best.p.bank} · ${best.p.name}` : '';
  };
  setTile('stat-low-var', lowestAt(null));
  setTile('stat-low-3y', lowestAt(36));
  setTile('stat-low-5y', lowestAt(60));
  const lenders = new Set((state.data.mortgages || []).map(m => m.brandId));
  $('stat-lenders').textContent = lenders.size;
  $('stat-lenders-sub').textContent = `${(state.data.mortgages || []).length} home loan products`;
}

// ---------- Investing (brokers) ----------
// Fee for an ASX trade of `size`: first tier whose ceiling covers it.
// A tier with both flat and pct means "pct with a $flat minimum".
function asxFeeAt(b, size) {
  for (const t of b.asxTiers || []) {
    if (t.upTo != null && size > t.upTo) continue;
    const pctFee = t.pct != null ? size * t.pct : null;
    if (t.flat != null && pctFee != null) return Math.max(t.flat, pctFee);
    if (pctFee != null) return pctFee;
    if (t.flat != null) return t.flat;
    return null;
  }
  return null;
}

const fmtFee = f =>
  f == null ? '—' : f === 0 ? '$0' : '$' + (Number.isInteger(f) ? f : f.toFixed(2));

function investRows() {
  const rows = [];
  for (const b of state.brokers) {
    if (state.iSearch && !b.name.toLowerCase().includes(state.iSearch)) continue;
    if (state.iChess && !b.chess) continue;
    if (state.iPromo && !b.promo) continue;
    rows.push({ b, fee: asxFeeAt(b, state.tradeSize) });
  }
  const { key, dir } = state.iSort;
  rows.sort((a, c) => {
    if (key === 'bank') return dir * a.b.name.localeCompare(c.b.name);
    const val = r => (key === 'fx' ? r.b.fxPct : r.fee);
    const av = val(a) ?? (dir === 1 ? Infinity : -Infinity);
    const cv = val(c) ?? (dir === 1 ? Infinity : -Infinity);
    return dir * (av - cv) || a.b.name.localeCompare(c.b.name);
  });
  return rows;
}

function renderInvest(rows) {
  const sortCls = k =>
    state.iSort.key === k ? (state.iSort.dir === 1 ? 'sorted-asc' : 'sorted-desc') : '';
  $('invest-head').innerHTML = `<tr>
    <th class="col-rank">#</th>
    <th class="col-bank sortable ${sortCls('bank')}" data-sort="bank">Broker</th>
    <th class="col-rate sortable ${sortCls('asx')}" data-sort="asx">ASX trade at ${fmtMoney(state.tradeSize)}</th>
    <th>US shares</th>
    <th class="col-rate sortable ${sortCls('fx')}" data-sort="fx">FX spread</th>
    <th>Perks &amp; promos</th>
  </tr>`;

  const bestFee = rows.reduce((mn, r) => Math.min(mn, r.fee ?? Infinity), Infinity);
  const pg = paginate(rows, 'iPage');
  $('invest-body').innerHTML = pg.slice
    .map((r, i) => {
      const b = r.b;
      const chess = b.chess
        ? '<span class="badge badge-chess" title="Shares held in your own name on the CHESS register">CHESS</span>'
        : '';
      const monthly = b.monthlyFeeDesc
        ? `<span class="badge badge-elig" title="Ongoing account fee">${esc(b.monthlyFeeDesc)}</span>`
        : '';
      const eff = r.fee != null && r.fee > 0 ? `<span class="fee-sub">${((r.fee / state.tradeSize) * 100).toFixed(2)}% of trade</span>` : '';
      const promo = b.promo
        ? `<span class="badge badge-promo">🎁 promo</span> <span title="${esc(b.promo.text)}">${esc(b.promo.text.slice(0, 70))}</span>`
        : '<span style="color:var(--muted)">—</span>';
      return `<tr data-key="${esc(keyOf(b))}">
        <td class="col-rank">${pg.start + i + 1}</td>
        <td>${bankCell(b)}</td>
        <td class="rate-cell ${r.fee != null && r.fee === bestFee ? 'rate-max' : ''}">${fmtFee(r.fee)}${eff}</td>
        <td class="product-cell">${esc(b.usFeeDesc || '—')}${chess ? ' ' + chess : ''}${monthly ? ' ' + monthly : ''}</td>
        <td class="rate-cell">${b.fxPct != null ? (b.fxPct * 100).toFixed(2) + '%' : '—'}</td>
        <td><div class="cond-cell">${promo}</div></td>
      </tr>`;
    })
    .join('');
  $('invest-empty').hidden = rows.length > 0;
  renderPager($('invest-pager'), pg, 'iPage');

  const dates = state.brokers.map(b => b.verified).filter(Boolean).sort();
  $('invest-verified').textContent = state.brokers.length
    ? `Broker fees and promos are hand-verified (last check: ${dates[dates.length - 1] || '—'}) — not from Open Banking APIs. Promos are the broker's advertised offers; conditions always apply.`
    : '';
}

function renderInvestStats(rows) {
  const cheapest = rows.filter(r => r.fee != null).reduce((m, r) => (m == null || r.fee < m.fee ? r : m), null);
  $('stat-cheap-asx-label').textContent = `Cheapest ASX trade at ${fmtMoney(state.tradeSize)}`;
  $('stat-cheap-asx').textContent = cheapest ? fmtFee(cheapest.fee) : '—';
  $('stat-cheap-asx-sub').textContent = cheapest ? cheapest.b.name : '';
  $('stat-chess').textContent = state.brokers.filter(b => b.chess).length;
  const promos = state.brokers.filter(b => b.promo);
  $('stat-promos').textContent = promos.length;
  $('stat-promos-sub').textContent = promos.length ? `at ${promos.slice(0, 3).map(b => b.name).join(', ')}${promos.length > 3 ? '…' : ''}` : '';
  $('stat-brokers').textContent = state.brokers.length;
  $('stat-brokers-sub').textContent = 'AU retail share-trading platforms';
}

// ---------- Stats & histogram ----------
function renderStats(savRows) {
  const topRow = savRows.length
    ? savRows.reduce((m, r) => (r.parts.max > m.parts.max ? r : m), savRows[0])
    : null;
  $('stat-top-rate').textContent = topRow ? fmtPct(topRow.parts.max) : '—';
  $('stat-top-rate-sub').textContent = topRow ? `${topRow.p.bank} · ${topRow.p.name}` : '';

  const baseRows = savRows.filter(r => r.noStrings);
  const topBase = baseRows.length
    ? baseRows.reduce((m, r) => (r.parts.max > m.parts.max ? r : m), baseRows[0])
    : null;
  $('stat-top-base').textContent = topBase ? fmtPct(topBase.parts.max) : '—';
  $('stat-top-base-sub').textContent = topBase ? `${topBase.p.bank} · ${topBase.p.name}` : '';

  let topTd = null;
  for (const p of state.data.termDeposits) {
    const r = bestTdRateAt(p.rates, 12, state.balance);
    if (r != null && (!topTd || r > topTd.r)) topTd = { r, p };
  }
  $('stat-top-td').textContent = topTd ? fmtPct(topTd.r) : '—';
  $('stat-top-td-sub').textContent = topTd ? `${topTd.p.bank} · ${topTd.p.name}` : '';

  const d = state.data;
  $('stat-coverage').textContent = `${d.okBrandCount} banks`;
  $('stat-coverage-sub').textContent = `${d.savings.length + d.termDeposits.length} products from ${d.brandCount} CDR brands`;
  $('failed-note').textContent = d.failed?.length
    ? `Currently unreachable: ${d.failed.map(f => f.name).join(', ')}.`
    : '';

  renderHistogram(savRows);
}

function renderHistogram(rows) {
  const el = $('dist-chart');
  const rates = rows.map(r => r.parts.max * 100);
  if (!rates.length) { el.innerHTML = ''; return; }
  const BIN = 0.5;
  const maxR = Math.ceil(Math.max(...rates) / BIN) * BIN;
  const bins = [];
  for (let lo = 0; lo < maxR; lo += BIN) bins.push({ lo, hi: lo + BIN, n: 0 });
  for (const r of rates) {
    const i = Math.min(bins.length - 1, Math.floor(r / BIN));
    bins[i].n++;
  }
  const W = 260, H = 56, gap = 2;
  const bw = W / bins.length - gap;
  const maxN = Math.max(...bins.map(b => b.n)) || 1;
  const bars = bins
    .map((b, i) => {
      const h = b.n === 0 ? 0 : Math.max(2, (b.n / maxN) * (H - 4));
      return `<rect x="${(i * W) / bins.length}" y="${H - h}" width="${Math.max(1, bw)}" height="${h}" rx="1.5"
        data-tip="${b.n} account${b.n === 1 ? '' : 's'} at ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}%"></rect>`;
    })
    .join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
  $('dist-label').textContent = `Savings max-rate distribution at ${fmtMoney(state.balance)}`;

  const tip = $('dist-tooltip');
  el.onmousemove = e => {
    const t = e.target.closest('rect');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    const host = el.closest('.dist-tile').getBoundingClientRect();
    tip.style.left = e.clientX - host.left + 'px';
    tip.style.top = e.clientY - host.top + 'px';
    tip.hidden = false;
  };
  el.onmouseleave = () => { tip.hidden = true; };
}

// ---------- Drawer ----------
function findProduct(key) {
  return (
    state.data.savings.find(p => keyOf(p) === key) ||
    state.data.termDeposits.find(p => keyOf(p) === key) ||
    (state.data.mortgages || []).find(p => keyOf(p) === key) ||
    state.brokers.find(p => keyOf(p) === key)
  );
}

function openDrawer(key) {
  const p = findProduct(key);
  if (!p) return;
  state.drawerKey = key;
  renderDrawer(p);
  $('drawer').hidden = false;
  $('drawer-backdrop').hidden = false;
  requestAnimationFrame(() => {
    $('drawer').classList.add('open');
    $('drawer-backdrop').classList.add('open');
  });
}

function closeDrawer() {
  state.drawerKey = null;
  $('drawer').classList.remove('open');
  $('drawer-backdrop').classList.remove('open');
  setTimeout(() => {
    $('drawer').hidden = true;
    $('drawer-backdrop').hidden = true;
  }, 220);
}

function bandLabel(min, max) {
  if ((min ?? 0) <= 0 && max == null) return 'Any balance';
  if (max == null) return `${fmtMoney(min)}+`;
  return `${fmtMoney(min ?? 0)} – ${fmtMoney(max)}`;
}

function renderDrawer(p) {
  $('drawer-bank').innerHTML = bankCell(p);
  $('drawer-product').textContent = p.asxTiers ? 'Share trading' : p.name;
  const link = $('drawer-link');
  if (p.url) { link.href = p.url; link.style.display = ''; } else { link.style.display = 'none'; }
  // Brokers aren't CDR data holders — no live refresh for them.
  $('drawer-refresh').style.display = p.asxTiers ? 'none' : '';

  let body = '';
  if (p.asxTiers) {
    const fee = asxFeeAt(p, state.tradeSize);
    body += `<div class="rate-summary">
      <div class="cell"><div class="k">ASX trade at ${fmtMoney(state.tradeSize)}</div><div class="v">${fmtFee(fee)}</div>
        <div class="s">${fee != null && fee > 0 ? ((fee / state.tradeSize) * 100).toFixed(2) + '% of trade' : ''}</div></div>
      <div class="cell"><div class="k">Holding type</div><div class="v" style="font-size:16px">${p.chess ? 'CHESS-sponsored' : 'Custodial'}</div>
        <div class="s">${p.chess ? 'shares in your name' : 'held via a custodian'}</div></div>
    </div>`;
    body += `<div class="drawer-section-title">Fees</div>
      <table class="detail-table"><tbody>
        <tr><td>ASX brokerage</td><td class="note">${esc(p.asxFeeDesc || '—')}</td></tr>
        <tr><td>US brokerage</td><td class="note">${esc(p.usFeeDesc || 'No US trading')}</td></tr>
        <tr><td>FX conversion</td><td class="note">${p.fxPct != null ? (p.fxPct * 100).toFixed(2) + '%' : '—'}</td></tr>
        <tr><td>Account fee</td><td class="note">${esc(p.monthlyFeeDesc || 'None')}</td></tr>
        <tr><td>Markets</td><td class="note">${esc((p.markets || []).join(', '))}</td></tr>
      </tbody></table>`;
    if (p.promo) {
      body += `<div class="drawer-section-title">Current sign-up offer</div>
        <div class="cond-block">${esc(p.promo.text)}${p.promo.conditions ? `<br><span style="font-size:12px">${esc(p.promo.conditions)}</span>` : ''}</div>`;
    }
    if (p.notes) body += `<p class="note" style="color:var(--ink-2);font-size:13px">${esc(p.notes)}</p>`;
    if (p.verified) {
      body += `<p class="note" style="color:var(--muted);font-size:12px;margin-top:14px">Hand-verified ${esc(p.verified)} from the broker's published pricing.</p>`;
    }
  } else if (p.lending) {
    const lvrLabel = state.mLvr ? `≤${state.mLvr}% LVR` : 'any LVR';
    const purposeLabel = state.mPurpose === 'INVESTMENT' ? 'investor' : 'owner-occupier';
    const repayLabel = state.mRepay === 'INTEREST_ONLY' ? 'interest only' : 'P&I';
    const variable = bestLendingRateAt(p.lending, loanFilters(null));
    let bestFixed = null;
    for (const m of state.mTerms) {
      const r = bestLendingRateAt(p.lending, loanFilters(m));
      if (r && (!bestFixed || r.rate < bestFixed.rate)) bestFixed = { ...r, months: m };
    }
    body += `<div class="rate-summary">
      <div class="cell"><div class="k">Variable rate</div><div class="v">${variable ? fmtPct(variable.rate) : '—'}</div>
        <div class="s">${variable?.comparison != null ? fmtPct(variable.comparison) + ' comparison' : ''}</div></div>
      <div class="cell"><div class="k">Best fixed</div><div class="v">${bestFixed ? fmtPct(bestFixed.rate) : '—'}</div>
        <div class="s">${bestFixed ? fmtLoanTerm(bestFixed.months) + (bestFixed.comparison != null ? ` · ${fmtPct(bestFixed.comparison)} comp` : '') : ''}</div></div>
    </div>
    <div class="cond-block">Showing rates for ${purposeLabel}, ${repayLabel}, ${lvrLabel}. Change the filters above the table to see other combinations.</div>`;

    const typeOrder = t => (t === 'VARIABLE' || t === 'FLOATING' || t === 'MARKET_LINKED' ? 0 : t === 'FIXED' ? 1 : t === 'INTRODUCTORY' ? 2 : 3);
    const rows = [...p.lending].sort(
      (a, b) => typeOrder(a.type) - typeOrder(b.type) || (a.months ?? 0) - (b.months ?? 0) || a.rate - b.rate
    );
    body += `<div class="drawer-section-title">All published rates</div>
      <table class="detail-table"><thead><tr><th>Type</th><th style="text-align:right">Rate</th><th style="text-align:right">Comp.</th><th>Applies to</th></tr></thead><tbody>`;
    for (const r of rows) {
      const typeLabel =
        r.type === 'FIXED' && r.months != null
          ? fmtLoanTerm(Math.round(r.months))
          : r.type[0] + r.type.slice(1).toLowerCase().replace(/_/g, ' ');
      const bits = [];
      if (r.purpose !== 'ANY') bits.push(r.purpose === 'INVESTMENT' ? 'Investor' : 'Owner-occ.');
      if (r.repayment !== 'ANY') bits.push(r.repayment === 'INTEREST_ONLY' ? 'Interest only' : 'P&I');
      for (const t of r.tiers || []) {
        if (t.unit === 'PERCENT') {
          const lo = t.min <= 1.5 ? t.min * 100 : t.min;
          const hi = t.max == null ? null : t.max <= 1.5 ? t.max * 100 : t.max;
          bits.push(hi == null ? `LVR ${Math.round(lo)}%+` : `LVR ${Math.round(lo)}–${Math.round(hi)}%`);
        } else {
          bits.push(bandLabel(t.min, t.max));
        }
      }
      if (r.info) bits.push(r.info.slice(0, 120));
      body += `<tr>
        <td>${esc(typeLabel)}</td>
        <td class="num">${fmtPct(r.rate)}</td>
        <td class="num">${r.comparison != null ? fmtPct(r.comparison) : '—'}</td>
        <td class="note">${esc(bits.join(' · '))}</td>
      </tr>`;
    }
    body += '</tbody></table>';
  } else if (p.structures) {
    const parts = ratePartsAt(p.structures, state.balance);
    body += `<div class="rate-summary">
      <div class="cell"><div class="k">Max rate at ${fmtMoney(state.balance)}</div><div class="v">${fmtPct(parts.max)}</div></div>
      <div class="cell"><div class="k">Base (no conditions)</div><div class="v">${fmtPct(parts.base)}</div></div>
      <div class="cell"><div class="k">Bonus on top</div><div class="v">${fmtPct(parts.bonus)}</div></div>
      <div class="cell"><div class="k">Intro offer</div><div class="v">${parts.intro ? fmtPct(parts.intro.rate) : '—'}</div>
        <div class="s">${parts.intro?.months ? `first ${Math.round(parts.intro.months)} months` : ''}</div></div>
    </div>`;
    if (parts.bonusConditions) {
      body += `<div class="drawer-section-title">Bonus conditions</div>
        <div class="cond-block">${esc(parts.bonusConditions)}</div>`;
    }
    body += `<div class="drawer-section-title">All published rates</div>
      <table class="detail-table"><thead><tr><th>Type</th><th style="text-align:right">Rate</th><th>Balance band</th><th>Notes</th></tr></thead><tbody>`;
    const typeOrder = t =>
      t === 'VARIABLE' || t === 'FLOATING' || t === 'MARKET_LINKED' ? 0
      : t === 'BONUS' ? 1
      : t === 'INTRODUCTORY' ? 2
      : 3;
    const lowestBand = r => Math.min(...(r.tiers || [{ min: 0 }]).map(t => t.min));
    const sortedRows = [...p.structures].sort(
      (a, b) => typeOrder(a.type) - typeOrder(b.type) || lowestBand(a) - lowestBand(b) || b.rate - a.rate
    );
    for (const r of sortedRows) {
      const bands = (r.tiers || [{ min: 0, max: null }])
        .sort((a, b) => a.min - b.min)
        .map(t => bandLabel(t.min, t.max))
        .join('<br>');
      const note = [r.cond, r.value, r.info].filter(Boolean).join(' — ');
      body += `<tr>
        <td>${esc(r.type[0] + r.type.slice(1).toLowerCase().replace(/_/g, ' '))}</td>
        <td class="num">${fmtPct(r.rate)}</td>
        <td class="note">${bands}</td>
        <td class="note">${esc(note.slice(0, 220))}</td>
      </tr>`;
    }
    body += '</tbody></table>';
  } else {
    const sorted = [...p.rates].sort((a, b) => a.months - b.months || b.rate - a.rate);
    body += `<div class="drawer-section-title">Term deposit rates</div>
      <table class="detail-table"><thead><tr><th>Term</th><th style="text-align:right">Rate</th><th>Deposit</th><th>Interest paid</th></tr></thead><tbody>`;
    for (const r of sorted) {
      body += `<tr>
        <td>${r.months % 12 === 0 ? r.months / 12 + ' yr' : r.months + ' mo'}</td>
        <td class="num">${fmtPct(r.rate)}</td>
        <td class="note">${bandLabel(r.min, r.max)}</td>
        <td class="note">${esc((r.info || '').slice(0, 90))}</td>
      </tr>`;
    }
    body += '</tbody></table>';
  }
  if (p.elig?.length) {
    body += `<div class="drawer-section-title">Who can open it</div>
      <div class="cond-block">${esc(p.elig.join(' · '))}</div>`;
  }
  if (p.updated) {
    body += `<p class="note" style="color:var(--muted);font-size:12px;margin-top:14px">
      Last updated by the bank: ${new Date(p.updated).toLocaleString('en-AU')}</p>`;
  }
  body += `<p style="margin-top:10px"><button class="report-link" data-report-product>
    🕵️ Something off with this product's numbers? Dob it in</button></p>`;
  $('drawer-body').innerHTML = body;
}

// ---------- Live refresh (hybrid) ----------
async function liveRefresh() {
  const p = state.drawerKey && findProduct(state.drawerKey);
  if (!p) return;
  const btn = $('drawer-refresh');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML =
    '<svg class="spin" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg> Refreshing…';
  try {
    const res = await fetch(`/api/refresh?brandId=${encodeURIComponent(p.brandId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh = await res.json();
    state.data.savings = state.data.savings
      .filter(x => x.brandId !== p.brandId)
      .concat(fresh.savings || []);
    state.data.termDeposits = state.data.termDeposits
      .filter(x => x.brandId !== p.brandId)
      .concat(fresh.termDeposits || []);
    state.data.mortgages = (state.data.mortgages || [])
      .filter(x => x.brandId !== p.brandId)
      .concat(fresh.mortgages || []);
    state.liveBrands.add(p.brandId);
    renderAll();
    const again = findProduct(state.drawerKey);
    if (again) renderDrawer(again);
    else closeDrawer();
    toast(`${p.bank} rates refreshed live from the bank`);
  } catch {
    toast('Live refresh unavailable — showing the daily snapshot');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ---------- Report a dodgy rate (on-site modal -> /api/report) ----------
function currentFilterSummary() {
  if (state.section === 'invest') {
    return `Brokers at ${fmtMoney(state.tradeSize)} trade size`;
  }
  if (state.section === 'loans') {
    return `${state.mRateType === 'FIXED' ? fmtLoanTerm(state.mFixedMonths) : 'Variable'} / ${
      state.mPurpose === 'INVESTMENT' ? 'Investor' : 'Owner-occupier'
    } / ${state.mRepay === 'INTEREST_ONLY' ? 'Interest only' : 'P&I'} / ${
      state.mLvr ? `≤${state.mLvr}% LVR` : 'any LVR'
    }`;
  }
  return `${state.tab === 'td' ? 'Term deposits' : 'Savings'} at ${fmtMoney(state.balance)}`;
}

let reportProduct = null; // product context when opened from a drawer

function openReportModal(p) {
  reportProduct = p || null;
  $('report-context').textContent = p
    ? `About: ${p.bank} — ${p.name}`
    : `About: ${state.section === 'loans' ? 'Home loans' : 'Deposits'} (${currentFilterSummary()})`;
  $('report-message').value = '';
  $('report-error').hidden = true;
  $('report-form-view').hidden = false;
  $('report-done-view').hidden = true;
  $('report-modal').hidden = false;
  $('report-backdrop').hidden = false;
  $('report-backdrop').classList.add('open');
  requestAnimationFrame(() => $('report-message').focus());
}

function closeReportModal() {
  $('report-modal').hidden = true;
  $('report-backdrop').classList.remove('open');
  $('report-backdrop').hidden = true;
}

async function sendReport() {
  const message = $('report-message').value.trim();
  const errEl = $('report-error');
  if (message.length < 3) {
    errEl.textContent = 'Give us a few words to go on — what looks off?';
    errEl.hidden = false;
    return;
  }
  const btn = $('report-send');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        website: $('report-website').value, // honeypot
        context: {
          product: reportProduct?.name || null,
          bank: reportProduct?.bank || null,
          brandId: reportProduct?.brandId || null,
          productId: reportProduct?.productId || null,
          view: `${state.section === 'loans' ? 'Home loans' : 'Deposits'} (${currentFilterSummary()})`,
          snapshot: state.data?.generatedAt || null,
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $('report-form-view').hidden = true;
    $('report-done-view').hidden = false;
    setTimeout(closeReportModal, 2400);
  } catch {
    errEl.textContent = "Hmm, the carrier pigeon bounced. Give it another go in a tick?";
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send it in';
  }
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- Render root ----------
// Any filter/sort change resets to page 1; pager controls pass false.
function renderAll(resetPages = true) {
  if (resetPages) state.sPage = state.tdPage = state.mPage = state.iPage = 1;
  const savRows = savingsRows();
  renderSavings(savRows);
  renderTd(tdRows());
  renderStats(savRows);
  renderLoans(loansRows());
  renderLoanStats();
  const iRows = investRows();
  renderInvest(iRows);
  renderInvestStats(iRows);
}

const SECTION_HASH = { loans: '#home-loans', invest: '#investing' };

function setSection(name) {
  state.section = name;
  for (const l of document.querySelectorAll('.nav-link')) {
    l.classList.toggle('active', l.dataset.section === name);
  }
  $('section-deposits').hidden = name !== 'deposits';
  $('section-loans').hidden = name !== 'loans';
  $('section-invest').hidden = name !== 'invest';
  history.replaceState(
    null,
    '',
    SECTION_HASH[name] || (state.tab === 'td' ? '#td' : location.pathname + location.search)
  );
}

// ---------- Events ----------
function setBalance(n, fromChip) {
  state.balance = n > 0 ? n : REF_BALANCE;
  if (!fromChip) {
    for (const c of document.querySelectorAll('#balance-chips .chip')) {
      c.classList.toggle('active', parseInt(c.dataset.amount, 10) === state.balance);
    }
  }
  renderAll();
}

$('balance-input').addEventListener('input', e => {
  const digits = e.target.value.replace(/[^\d]/g, '');
  const n = parseInt(digits || '0', 10);
  if (digits) e.target.value = n.toLocaleString('en-AU');
  setBalance(n);
});

$('balance-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const n = parseInt(chip.dataset.amount, 10);
  $('balance-input').value = n.toLocaleString('en-AU');
  for (const c of document.querySelectorAll('#balance-chips .chip')) {
    c.classList.toggle('active', c === chip);
  }
  setBalance(n, true);
});

$('search-input').addEventListener('input', e => {
  state.search = e.target.value.trim().toLowerCase();
  renderAll();
});

$('nostrings-toggle').addEventListener('change', e => {
  state.noStrings = e.target.checked;
  renderAll();
});

$('offset-toggle').addEventListener('change', e => {
  state.mOffset = e.target.checked;
  renderAll();
});

$('report-issue').addEventListener('click', () => openReportModal(null));
$('report-fab').addEventListener('click', () => openReportModal(null));
$('report-cancel').addEventListener('click', closeReportModal);
$('report-backdrop').addEventListener('click', closeReportModal);
$('report-send').addEventListener('click', sendReport);
$('drawer-body').addEventListener('click', e => {
  if (e.target.closest('[data-report-product]')) {
    const p = state.drawerKey && findProduct(state.drawerKey);
    openReportModal(p || null);
  }
});

function setTab(name) {
  state.tab = name;
  for (const t of document.querySelectorAll('.tab')) {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active);
  }
  $('panel-savings').hidden = name !== 'savings';
  $('panel-td').hidden = name !== 'td';
  $('nostrings-field').style.display = name === 'savings' ? '' : 'none';
  if (state.section === 'deposits') {
    history.replaceState(null, '', name === 'td' ? '#td' : location.pathname + location.search);
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setTab(tab.dataset.tab));
}

for (const link of document.querySelectorAll('.nav-link')) {
  link.addEventListener('click', () => setSection(link.dataset.section));
}

function segListener(id, apply) {
  $(id).addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of $(id).querySelectorAll('button')) b.classList.toggle('active', b === btn);
    apply(btn.dataset.value ?? btn.dataset.lvr);
    renderAll();
  });
}
segListener('purpose-seg', v => { state.mPurpose = v; });
segListener('repay-seg', v => { state.mRepay = v; });
segListener('lvr-chips', v => { state.mLvr = v === '' ? null : parseInt(v, 10); });
segListener('ratetype-seg', v => {
  state.mRateType = v;
  $('term-field').hidden = v !== 'FIXED';
});
$('term-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  for (const c of $('term-chips').querySelectorAll('.chip')) c.classList.toggle('active', c === chip);
  state.mFixedMonths = parseInt(chip.dataset.months, 10);
  renderAll();
});

$('loans-search').addEventListener('input', e => {
  state.mSearch = e.target.value.trim().toLowerCase();
  renderAll();
});

// Investing controls
$('trade-input').addEventListener('input', e => {
  const digits = e.target.value.replace(/[^\d]/g, '');
  const n = parseInt(digits || '0', 10);
  if (digits) e.target.value = n.toLocaleString('en-AU');
  state.tradeSize = n > 0 ? n : 2000;
  for (const c of document.querySelectorAll('#trade-chips .chip')) {
    c.classList.toggle('active', parseInt(c.dataset.amount, 10) === state.tradeSize);
  }
  renderAll();
});
$('trade-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const n = parseInt(chip.dataset.amount, 10);
  $('trade-input').value = n.toLocaleString('en-AU');
  for (const c of document.querySelectorAll('#trade-chips .chip')) c.classList.toggle('active', c === chip);
  state.tradeSize = n;
  renderAll();
});
$('invest-search').addEventListener('input', e => {
  state.iSearch = e.target.value.trim().toLowerCase();
  renderAll();
});
$('chess-toggle').addEventListener('change', e => { state.iChess = e.target.checked; renderAll(); });
$('promo-toggle').addEventListener('change', e => { state.iPromo = e.target.checked; renderAll(); });
$('invest-head').addEventListener('click', e => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  const s = state.iSort;
  if (s.key === key) s.dir = -s.dir;
  else { s.key = key; s.dir = 1; }
  renderAll();
});

$('loans-head').addEventListener('click', e => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  const s = state.mSort;
  if (s.key === key) s.dir = -s.dir;
  else { s.key = key; s.dir = 1; }
  renderAll();
});

document.querySelector('#savings-table thead').addEventListener('click', e => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  const s = state.savingsSort;
  if (s.key === key) s.dir = -s.dir;
  else { s.key = key; s.dir = key === 'bank' ? 1 : -1; }
  renderAll();
});

$('td-head').addEventListener('click', e => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const raw = th.dataset.sort;
  const key = raw === 'bank' ? 'bank' : parseInt(raw, 10);
  const s = state.tdSort;
  if (s.key === key) s.dir = -s.dir;
  else { s.key = key; s.dir = key === 'bank' ? 1 : -1; }
  renderAll();
});

for (const bodyId of ['savings-body', 'td-body', 'loans-body', 'invest-body']) {
  $(bodyId).addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openDrawer(tr.dataset.key);
  });
}

$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);
$('drawer-refresh').addEventListener('click', liveRefresh);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('report-modal').hidden) closeReportModal();
  else if (state.drawerKey) closeDrawer();
});

$('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const current =
    root.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('theme', next);
});

$('retry-load').addEventListener('click', load);

// Shareable URL states: ?theme=dark|light forces a theme, #td opens term deposits.
const urlTheme = new URLSearchParams(location.search).get('theme');
if (urlTheme === 'dark' || urlTheme === 'light') {
  document.documentElement.dataset.theme = urlTheme;
}
if (location.hash === '#td') setTab('td');
if (location.hash === '#home-loans') setSection('loans');
if (location.hash === '#investing') setSection('invest');

load();

