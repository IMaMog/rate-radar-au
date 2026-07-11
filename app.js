import {
  ratePartsAt,
  bestTdRateAt,
  fmtPct,
  REF_BALANCE,
} from './shared/rates.js';

const $ = id => document.getElementById(id);

const state = {
  data: null,
  tab: 'savings',
  balance: REF_BALANCE,
  search: '',
  noStrings: false,
  hideBottom: true,
  savingsSort: { key: 'max', dir: -1 },
  tdSort: { key: 12, dir: -1 },
  tdTerms: [],
  liveBrands: new Set(), // brands refreshed live this session
  drawerKey: null,
};

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
    $('loading').hidden = true;
    $('app').hidden = false;
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

// ---------- Savings ----------
function savingsRows() {
  // Percentile cutoff computed over ALL savings products at the current
  // balance (not the searched subset), so the threshold is stable.
  let cutoff = -Infinity;
  if (state.hideBottom) {
    const all = state.data.savings
      .map(p => ratePartsAt(p.structures, state.balance).max)
      .filter(m => m != null && m > 0)
      .sort((a, b) => a - b);
    if (all.length) cutoff = all[Math.floor(all.length * 0.1)];
  }

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
  const html = rows
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
        <td class="col-rank">${i + 1}</td>
        <td>${bankCell(p)}</td>
        <td class="product-cell"><span class="product-name">${esc(p.name)}</span>${intro}</td>
        <td class="rate-cell rate-max">${fmtPct(parts.max)}<span class="rate-bar" style="width:${barW}px"></span></td>
        <td class="rate-cell">${fmtPct(parts.base)}</td>
        <td><div class="cond-cell">${cond}</div></td>
      </tr>`;
    })
    .join('');
  $('savings-body').innerHTML = html;
  $('savings-empty').hidden = rows.length > 0;
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
  $('td-body').innerHTML = rows
    .map(
      (r, i) => `<tr data-key="${esc(keyOf(r.p))}">
      <td class="col-rank">${i + 1}</td>
      <td>${bankCell(r.p)}</td>
      <td class="product-cell"><span class="product-name">${esc(r.p.name)}</span></td>
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
  $('count-td').textContent = `(${rows.length})`;
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
    state.data.termDeposits.find(p => keyOf(p) === key)
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
  $('drawer-product').textContent = p.name;
  const link = $('drawer-link');
  if (p.url) { link.href = p.url; link.style.display = ''; } else { link.style.display = 'none'; }

  let body = '';
  if (p.structures) {
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
    for (const r of p.structures) {
      const bands = (r.tiers || [{ min: 0, max: null }])
        .map(t => bandLabel(t.min, t.max))
        .join('<br>');
      const note = [r.value, r.info].filter(Boolean).join(' — ');
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
  if (p.updated) {
    body += `<p class="note" style="color:var(--muted);font-size:12px;margin-top:14px">
      Last updated by the bank: ${new Date(p.updated).toLocaleString('en-AU')}</p>`;
  }
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

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- Render root ----------
function renderAll() {
  const savRows = savingsRows();
  renderSavings(savRows);
  renderTd(tdRows());
  renderStats(savRows);
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

$('hide-bottom-toggle').addEventListener('change', e => {
  state.hideBottom = e.target.checked;
  renderAll();
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
  $('hide-bottom-field').style.display = name === 'savings' ? '' : 'none';
  history.replaceState(null, '', name === 'td' ? '#td' : location.pathname + location.search);
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setTab(tab.dataset.tab));
}

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

for (const bodyId of ['savings-body', 'td-body']) {
  $(bodyId).addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openDrawer(tr.dataset.key);
  });
}

$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);
$('drawer-refresh').addEventListener('click', liveRefresh);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.drawerKey) closeDrawer();
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

load();
