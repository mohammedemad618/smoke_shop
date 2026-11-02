import { api, toast, formatMoney, formatTime, escapeHtml, arCount, PIECES } from './common.js';

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY_MS = 24 * 60 * 60 * 1000;
// Periods longer than this are broken down by month instead of by day
const MAX_DAILY_ROWS = 62;
const MAX_RANGE_DAYS = 3 * 366;

const LOCALE = 'ar-u-nu-latn';
const fullDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const rowDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const shortDay = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const monthName = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });

const $ = (id) => document.getElementById(id);
const els = {
  modes: document.querySelectorAll('[data-mode]'),
  panels: document.querySelectorAll('[data-panel]'),
  day: $('dayInput'),
  prevDay: $('prevDay'),
  nextDay: $('nextDay'),
  today: $('todayBtn'),
  month: $('monthInput'),
  prevMonth: $('prevMonth'),
  nextMonth: $('nextMonth'),
  thisMonth: $('thisMonthBtn'),
  rangeForm: $('rangeForm'),
  from: $('fromInput'),
  to: $('toInput'),
  title: $('periodTitle'),
  summary: $('summary'),
  area: $('salesArea'),
};

let mode = 'day';
let request = 0;

/* Dates (all in the browser's time zone) */

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const parseKey = (key) => {
  const [y, m, d = 1] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);
const todayStart = () => parseKey(dayKey(new Date()));

function currentPeriod() {
  if (mode === 'day') {
    const from = parseKey(els.day.value);
    return { from, to: addDays(from, 1), title: fullDay.format(from) };
  }
  if (mode === 'month') {
    const from = parseKey(els.month.value);
    return { from, to: addMonths(from, 1), groupBy: 'day', title: monthName.format(from) };
  }
  const from = parseKey(els.from.value);
  const last = parseKey(els.to.value);
  return {
    from,
    to: addDays(last, 1),
    groupBy: daysBetween(from, last) + 1 > MAX_DAILY_ROWS ? 'month' : 'day',
    title: `من ${shortDay.format(from)} إلى ${shortDay.format(last)}`,
  };
}

const rangeQuery = (period, extra = {}) =>
  new URLSearchParams({ from: period.from.toISOString(), to: period.to.toISOString(), ...extra }).toString();

/* Loading */

async function load() {
  const period = currentPeriod();
  const current = ++request;
  els.title.textContent = period.title;
  syncLimits();
  try {
    if (mode === 'day') {
      const data = await api(`/sales?${rangeQuery(period)}`);
      if (current !== request) return;
      renderSummary(data.summary);
      renderInvoices(data.sales);
    } else {
      const data = await api(`/sales/report?${rangeQuery(period, { groupBy: period.groupBy, tz: TIME_ZONE })}`);
      if (current !== request) return;
      renderSummary(data.summary);
      renderBreakdown(period, data);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function syncLimits() {
  const today = dayKey(new Date());
  const thisMonth = monthKey(new Date());
  els.day.max = today;
  els.from.max = today;
  els.to.max = today;
  els.month.max = thisMonth;
  els.nextDay.disabled = els.day.value >= today;
  els.nextMonth.disabled = els.month.value >= thisMonth;
}

/* Rendering */

const marginOf = (row) => (row.total > 0 ? `${Math.round((row.profit / row.total) * 100)}%` : '');
const profitClass = (value) => (value < 0 ? ' loss' : '');

function renderSummary(s) {
  const margin = marginOf(s);
  els.summary.innerHTML = `
    <div><div class="z-label">عدد الفواتير</div><div class="z-value num">${formatMoney(s.count)}</div></div>
    <div><div class="z-label">المبيعات</div><div class="z-value num">${formatMoney(s.total)}</div></div>
    <div><div class="z-label">تكلفة البضاعة المباعة</div><div class="z-value num">${formatMoney(s.cost)}</div></div>
    <div>
      <div class="z-label">الربح</div>
      <div class="z-value num ${s.profit < 0 ? 'is-loss' : 'is-profit'}">${formatMoney(s.profit)}</div>
      ${margin ? `<div class="z-note">نسبة الربح من المبيعات <span class="num">${margin}</span></div>` : ''}
    </div>`;
}

function emptyState(text) {
  els.area.innerHTML = `<div class="empty">
    <h3>${text}</h3>
    <p>الفواتير التي تتم من شاشة الكاشير تظهر هنا.</p>
  </div>`;
}

function renderInvoices(sales) {
  if (!sales.length) {
    emptyState('لا توجد مبيعات في هذا اليوم');
    return;
  }
  els.area.innerHTML = `<table class="ptable">
    <thead><tr>
      <th scope="col">رقم الفاتورة</th>
      <th scope="col">الوقت</th>
      <th scope="col">القطع</th>
      <th scope="col" class="end">المبلغ</th>
      <th scope="col" class="end">الربح</th>
      <th scope="col"><span class="sr-only">الأصناف</span></th>
    </tr></thead>
    <tbody>${sales
      .map((sale) => {
        const pieces = sale.items.reduce((sum, i) => sum + i.quantity, 0);
        const rowId = `items-${sale._id}`;
        return `<tr>
          <td class="num">${sale.number}</td>
          <td>${formatTime(sale.createdAt)}</td>
          <td>${arCount(pieces, PIECES)}</td>
          <td class="end num">${formatMoney(sale.total)}</td>
          <td class="end num${profitClass(sale.profit)}">${formatMoney(sale.profit)}</td>
          <td class="row-actions"><button class="btn btn-sm btn-ghost" type="button" data-toggle="${rowId}" aria-expanded="false" aria-controls="${rowId}">الأصناف</button></td>
        </tr>
        <tr class="sale-items" id="${rowId}" hidden><td colspan="6"><ul>${sale.items
          .map(
            (i) => `<li><span>${escapeHtml(i.name)} <span class="num">× ${i.quantity}</span></span><span class="num">${formatMoney(i.lineTotal)}</span></li>`,
          )
          .join('')}</ul></td></tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

function periodKeys(period, groupBy) {
  const keys = [];
  if (groupBy === 'month') {
    for (let d = new Date(period.from.getFullYear(), period.from.getMonth(), 1); d < period.to; d = addMonths(d, 1)) {
      keys.push(monthKey(d));
    }
  } else {
    for (let d = period.from; d < period.to; d = addDays(d, 1)) keys.push(dayKey(d));
  }
  return keys;
}

function renderBreakdown(period, { groupBy, summary, periods }) {
  if (!summary.count) {
    emptyState('لا توجد مبيعات في هذه الفترة');
    return;
  }
  const byKey = new Map(periods.map((p) => [p.key, p]));
  const empty = { count: 0, pieces: 0, total: 0, profit: 0 };
  const byMonth = groupBy === 'month';
  const pieces = periods.reduce((sum, p) => sum + p.pieces, 0);

  const rows = periodKeys(period, groupBy).map((key) => {
    const row = byKey.get(key) ?? empty;
    const label = byMonth ? monthName.format(parseKey(key)) : rowDay.format(parseKey(key));
    return `<tr${row.count ? '' : ' class="is-quiet"'}>
      <td>${
        row.count
          ? `<button class="drill" type="button" data-drill="${key}" title="${byMonth ? 'عرض الشهر' : 'عرض فواتير اليوم'}">${label}</button>`
          : label
      }</td>
      <td class="num">${row.count || '–'}</td>
      <td class="num">${row.pieces || '–'}</td>
      <td class="end num">${row.count ? formatMoney(row.total) : '–'}</td>
      <td class="end num${profitClass(row.profit)}">${row.count ? formatMoney(row.profit) : '–'}</td>
      <td class="end num">${marginOf(row) || '–'}</td>
    </tr>`;
  });

  els.area.innerHTML = `<table class="ptable breakdown">
    <thead><tr>
      <th scope="col">${byMonth ? 'الشهر' : 'اليوم'}</th>
      <th scope="col">الفواتير</th>
      <th scope="col">القطع</th>
      <th scope="col" class="end">المبيعات</th>
      <th scope="col" class="end">الربح</th>
      <th scope="col" class="end">نسبة الربح</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr>
      <td>الإجمالي</td>
      <td class="num">${formatMoney(summary.count)}</td>
      <td class="num">${formatMoney(pieces)}</td>
      <td class="end num">${formatMoney(summary.total)}</td>
      <td class="end num${profitClass(summary.profit)}">${formatMoney(summary.profit)}</td>
      <td class="end num">${marginOf(summary) || '–'}</td>
    </tr></tfoot>
  </table>`;
}

/* Interactions */

function setMode(next) {
  mode = next;
  els.modes.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
  els.panels.forEach((p) => (p.hidden = p.dataset.panel !== next));
  load();
}

els.modes.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

els.day.addEventListener('change', () => els.day.value && load());
els.prevDay.addEventListener('click', () => {
  els.day.value = dayKey(addDays(parseKey(els.day.value), -1));
  load();
});
els.nextDay.addEventListener('click', () => {
  els.day.value = dayKey(addDays(parseKey(els.day.value), 1));
  load();
});
els.today.addEventListener('click', () => {
  els.day.value = dayKey(new Date());
  load();
});

els.month.addEventListener('change', () => els.month.value && load());
els.prevMonth.addEventListener('click', () => {
  els.month.value = monthKey(addMonths(parseKey(els.month.value), -1));
  load();
});
els.nextMonth.addEventListener('click', () => {
  els.month.value = monthKey(addMonths(parseKey(els.month.value), 1));
  load();
});
els.thisMonth.addEventListener('click', () => {
  els.month.value = monthKey(new Date());
  load();
});

els.rangeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!els.from.value || !els.to.value) {
    toast('اختر تاريخ البداية وتاريخ النهاية', 'error');
    return;
  }
  const days = daysBetween(parseKey(els.from.value), parseKey(els.to.value)) + 1;
  if (days < 1) {
    toast('تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساويًا له', 'error');
    return;
  }
  if (days > MAX_RANGE_DAYS) {
    toast('أقصى فترة يمكن عرضها 3 سنوات', 'error');
    return;
  }
  load();
});

els.rangeForm.addEventListener('click', (e) => {
  const preset = e.target.closest('[data-preset]')?.dataset.preset;
  if (!preset) return;
  const today = todayStart();
  const from = preset === 'year' ? new Date(today.getFullYear(), 0, 1) : addDays(today, -(Number(preset) - 1));
  els.from.value = dayKey(from);
  els.to.value = dayKey(today);
  load();
});

els.area.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const row = $(toggle.dataset.toggle);
    row.hidden = !row.hidden;
    toggle.setAttribute('aria-expanded', String(!row.hidden));
    return;
  }
  const drill = e.target.closest('[data-drill]');
  if (drill) {
    const key = drill.dataset.drill;
    if (key.length === 7) {
      els.month.value = key;
      setMode('month');
    } else {
      els.day.value = key;
      setMode('day');
    }
  }
});

const today = todayStart();
els.day.value = dayKey(today);
els.month.value = monthKey(today);
els.from.value = dayKey(new Date(today.getFullYear(), today.getMonth(), 1));
els.to.value = dayKey(today);
load();
