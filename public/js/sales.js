import {
  api,
  toast,
  formatMoney,
  formatQty,
  formatWeight,
  formatTime,
  escapeHtml,
  arCount,
  qtyLabel,
  dayKey,
  monthKey,
  parseKey,
  addDays,
  addMonths,
  PIECES,
} from './common.js';

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY_MS = 24 * 60 * 60 * 1000;
// Periods longer than this are broken down by month instead of by day
const MAX_DAILY_ROWS = 62;
const MAX_RANGE_DAYS = 3 * 366;
const TOP_PRODUCTS = 10;

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
  productsSection: $('productsSection'),
  productsArea: $('productsArea'),
  sorts: document.querySelectorAll('[data-sort]'),
  returnDialog: $('returnDialog'),
  returnForm: $('returnForm'),
  returnTitle: $('returnTitle'),
  returnLines: $('returnLines'),
  returnAmount: $('returnAmount'),
  returnError: $('returnError'),
  returnAll: $('returnAllBtn'),
  returnClose: $('returnCloseBtn'),
};

let mode = 'day';
let request = 0;
let daySales = [];
let returning = null;
const productView = { rows: [], sort: 'profit', showAll: false };

/* Dates (all in the browser's time zone) */

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
    const productsRequest = api(`/sales/products?${rangeQuery(period)}`);
    if (mode === 'day') {
      const [data, products] = await Promise.all([api(`/sales?${rangeQuery(period)}`), productsRequest]);
      if (current !== request) return;
      renderSummary(data.summary, period);
      renderInvoices(data.sales);
      showProducts(products);
    } else {
      const [data, products] = await Promise.all([
        api(`/sales/report?${rangeQuery(period, { groupBy: period.groupBy, tz: TIME_ZONE })}`),
        productsRequest,
      ]);
      if (current !== request) return;
      renderSummary(data.summary, period);
      renderBreakdown(period, data);
      showProducts(products);
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

function renderSummary(s, period) {
  const margin = marginOf(s);
  const expensesLink = `/expenses.html?month=${monthKey(period.from)}`;
  els.summary.innerHTML = `
    <div><div class="z-label">عدد الفواتير</div><div class="z-value num">${formatMoney(s.count)}</div></div>
    <div>
      <div class="z-label">المبيعات</div>
      <div class="z-value num">${formatMoney(s.total)}</div>
      ${s.returns ? `<div class="z-note">بعد خصم مرتجعات <span class="num">${formatMoney(s.returns)}</span></div>` : ''}
    </div>
    <div><div class="z-label">تكلفة البضاعة المباعة</div><div class="z-value num">${formatMoney(s.cost)}</div></div>
    <div>
      <div class="z-label">ربح المبيعات</div>
      <div class="z-value num ${s.profit < 0 ? 'is-loss' : 'is-profit'}">${formatMoney(s.profit)}</div>
      ${margin ? `<div class="z-note">نسبة الربح من المبيعات <span class="num">${margin}</span></div>` : ''}
    </div>
    <div>
      <div class="z-label">المصاريف</div>
      <div class="z-value num">${formatMoney(s.expenses)}</div>
      <a class="z-link" href="${expensesLink}">${s.expenses ? 'تفاصيل المصاريف' : 'إضافة مصروف'}</a>
    </div>
    <div class="z-net">
      <div class="z-label">صافي الربح</div>
      <div class="z-value num ${s.netProfit < 0 ? 'is-loss' : 'is-profit'}">${formatMoney(s.netProfit)}</div>
      <div class="z-note">ربح المبيعات بعد طرح المصاريف</div>
    </div>`;
}

function emptyState(text) {
  els.area.innerHTML = `<div class="empty">
    <h3>${text}</h3>
    <p>الفواتير التي تتم من شاشة الكاشير تظهر هنا.</p>
  </div>`;
}

// What an invoice still counts for after its returns
// Pieces only: a box counts its pieces, weights are not pieces
const keptPieces = (sale) =>
  sale.items.reduce(
    (sum, i) => (i.unit === 'kg' ? sum : sum + (i.quantity - (i.returnedQuantity ?? 0)) * (i.packSize ?? 1)),
    0,
  );
// Pieces and packs are returned whole; a retail weight can be a fraction
const wholeOnly = (item) => item.mode === 'wholesale' || item.unit !== 'kg';
const amountOf = (item, qty) => (wholeOnly(item) ? formatQty(qty) : formatWeight(qty));
const netTotal = (sale) => sale.total - (sale.returnedTotal ?? 0);
const netProfit = (sale) => sale.profit - ((sale.returnedTotal ?? 0) - (sale.returnedCost ?? 0));

function statusBadge(sale) {
  if (sale.returnStatus === 'full') return '<span class="badge is-cancelled">ملغاة</span>';
  if (sale.returnStatus === 'partial') return '<span class="badge is-partial">مرتجع جزئي</span>';
  return '';
}

function itemsDetail(sale) {
  const items = sale.items
    .map((i) => {
      const back = i.returnedQuantity ? ` <span class="returned-inline">أُرجع ${amountOf(i, i.returnedQuantity)}</span>` : '';
      return `<li><span>${escapeHtml(i.name)} <span class="num">${qtyLabel(i)}</span>${back}</span><span class="num">${formatMoney(i.lineTotal)}</span></li>`;
    })
    .join('');
  const log = (sale.returns ?? [])
    .map(
      (r) => `<li class="returns-log"><span>إرجاع ${r.items.map((i) => `${escapeHtml(i.name)} <span class="num">${qtyLabel(i)}</span>`).join('، ')} الساعة ${formatTime(r.at)}</span><span class="num">−${formatMoney(r.amount)}</span></li>`,
    )
    .join('');
  return `<ul>${items}${log}</ul>`;
}

function renderInvoices(sales) {
  daySales = sales;
  if (!sales.length) {
    emptyState('لا توجد مبيعات في هذا اليوم');
    return;
  }
  els.area.innerHTML = `<div class="section-head"><h2>الفواتير</h2></div>
  <table class="ptable">
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
        const rowId = `items-${sale._id}`;
        const pieces = keptPieces(sale);
        const cancelled = sale.returnStatus === 'full';
        return `<tr${cancelled ? ' class="is-quiet"' : ''}>
          <td><span class="num">${sale.number}</span>${statusBadge(sale)}</td>
          <td>${formatTime(sale.createdAt)}</td>
          <td>${pieces ? arCount(pieces, PIECES) : '–'}</td>
          <td class="end">
            <span class="num">${formatMoney(netTotal(sale))}</span>
            ${sale.returnedTotal ? `<small class="returned">مرتجع <span class="num">${formatMoney(sale.returnedTotal)}</span></small>` : ''}
          </td>
          <td class="end num${profitClass(netProfit(sale))}">${formatMoney(netProfit(sale))}</td>
          <td class="row-actions">
            <button class="btn btn-sm btn-ghost" type="button" data-toggle="${rowId}" aria-expanded="false" aria-controls="${rowId}">الأصناف</button>
            ${cancelled ? '' : `<button class="btn btn-sm" type="button" data-return="${sale._id}">إرجاع</button>`}
          </td>
        </tr>
        <tr class="sale-items" id="${rowId}" hidden><td colspan="6">${itemsDetail(sale)}</td></tr>`;
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
  if (!summary.count && !summary.expenses) {
    emptyState('لا توجد مبيعات أو مصاريف في هذه الفترة');
    return;
  }
  const byKey = new Map(periods.map((p) => [p.key, p]));
  const empty = { count: 0, pieces: 0, total: 0, profit: 0, expenses: 0, netProfit: 0 };
  const byMonth = groupBy === 'month';
  const pieces = periods.reduce((sum, p) => sum + p.pieces, 0);
  const amount = (value, shown) => (shown ? formatMoney(value) : '–');

  const rows = periodKeys(period, groupBy).map((key) => {
    const row = byKey.get(key) ?? empty;
    const active = row.count || row.expenses;
    const label = byMonth ? monthName.format(parseKey(key)) : rowDay.format(parseKey(key));
    return `<tr${active ? '' : ' class="is-quiet"'}>
      <td>${
        active
          ? `<button class="drill" type="button" data-drill="${key}" title="${byMonth ? 'عرض الشهر' : 'عرض فواتير اليوم'}">${label}</button>`
          : label
      }</td>
      <td class="num">${row.count || '–'}</td>
      <td class="num">${row.pieces || '–'}</td>
      <td class="end num">${amount(row.total, row.count)}</td>
      <td class="end num${profitClass(row.profit)}">${amount(row.profit, row.count)}</td>
      <td class="end num">${marginOf(row) || '–'}</td>
      <td class="end num">${amount(row.expenses, row.expenses)}</td>
      <td class="end num net${profitClass(row.netProfit)}">${amount(row.netProfit, active)}</td>
    </tr>`;
  });

  els.area.innerHTML = `<div class="section-head"><h2>${byMonth ? 'حسب الأشهر' : 'حسب الأيام'}</h2></div>
  <div class="table-scroll"><table class="ptable breakdown">
    <thead><tr>
      <th scope="col">${byMonth ? 'الشهر' : 'اليوم'}</th>
      <th scope="col">الفواتير</th>
      <th scope="col">القطع</th>
      <th scope="col" class="end">المبيعات</th>
      <th scope="col" class="end">ربح المبيعات</th>
      <th scope="col" class="end">نسبة الربح</th>
      <th scope="col" class="end">المصاريف</th>
      <th scope="col" class="end">صافي الربح</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr>
      <td>الإجمالي</td>
      <td class="num">${formatMoney(summary.count)}</td>
      <td class="num">${formatMoney(pieces)}</td>
      <td class="end num">${formatMoney(summary.total)}</td>
      <td class="end num${profitClass(summary.profit)}">${formatMoney(summary.profit)}</td>
      <td class="end num">${marginOf(summary) || '–'}</td>
      <td class="end num">${formatMoney(summary.expenses)}</td>
      <td class="end num net${profitClass(summary.netProfit)}">${formatMoney(summary.netProfit)}</td>
    </tr></tfoot>
  </table></div>`;
}

function showProducts(rows) {
  productView.rows = rows;
  productView.showAll = false;
  renderProducts();
}

function renderProducts() {
  const { rows, sort, showAll } = productView;
  els.productsSection.hidden = rows.length === 0;
  if (!rows.length) return;

  // Ties fall back to profit, then name, so the order is stable
  const sorted = [...rows].sort(
    (a, b) => b[sort] - a[sort] || b.profit - a.profit || a.name.localeCompare(b.name, 'ar'),
  );
  const visible = showAll ? sorted : sorted.slice(0, TOP_PRODUCTS);

  els.productsArea.innerHTML = `<table class="ptable products-report">
    <thead><tr>
      <th scope="col" class="rank"><span class="sr-only">الترتيب</span></th>
      <th scope="col">المنتج</th>
      <th scope="col">الكمية</th>
      <th scope="col" class="end">المبيعات</th>
      <th scope="col" class="end">التكلفة</th>
      <th scope="col" class="end">الربح</th>
      <th scope="col" class="end">نسبة الربح</th>
    </tr></thead>
    <tbody>${visible
      .map(
        (p, i) => `<tr>
        <td class="rank num">${i + 1}</td>
        <td><div class="pname">${escapeHtml(p.name)}</div><div class="pcat num">${escapeHtml(p.barcode)}</div></td>
        <td class="num">${p.unit === 'kg' ? formatWeight(p.quantity) : formatQty(p.quantity)}</td>
        <td class="end num">${formatMoney(p.total)}</td>
        <td class="end num">${formatMoney(p.cost)}</td>
        <td class="end num${profitClass(p.profit)}">${formatMoney(p.profit)}</td>
        <td class="end num${profitClass(p.profit)}">${marginOf(p) || '–'}</td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>
  ${
    sorted.length > TOP_PRODUCTS
      ? `<button class="btn btn-sm btn-ghost show-all" type="button" data-show-all>${
          showAll ? `عرض أول ${TOP_PRODUCTS} فقط` : `عرض كل المنتجات (${formatMoney(sorted.length)})`
        }</button>`
      : ''
  }`;
}

els.sorts.forEach((b) =>
  b.addEventListener('click', () => {
    productView.sort = b.dataset.sort;
    els.sorts.forEach((s) => s.setAttribute('aria-pressed', String(s === b)));
    renderProducts();
  }),
);

els.productsArea.addEventListener('click', (e) => {
  if (!e.target.closest('[data-show-all]')) return;
  productView.showAll = !productView.showAll;
  renderProducts();
});

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

/* Returns */

// Weighed lines are typed in grams (data-scale 1000); quantities here are in the sold unit
function returnQuantities() {
  return [...els.returnLines.querySelectorAll('input')].map((input) => {
    const scale = Number(input.dataset.scale ?? 1);
    return {
      line: Number(input.dataset.index),
      item: returning.items[Number(input.dataset.index)],
      max: Number(input.max) / scale,
      quantity: input.value.trim() === '' ? 0 : Number(input.value) / scale,
    };
  });
}

const validReturn = (r) =>
  Number.isFinite(r.quantity) && r.quantity >= 0 && r.quantity <= r.max && (!wholeOnly(r.item) || Number.isInteger(r.quantity));

function updateReturnAmount() {
  const amount = returnQuantities().reduce(
    (sum, r) => sum + (validReturn(r) ? r.quantity * r.item.unitPrice : 0),
    0,
  );
  els.returnAmount.textContent = formatMoney(amount);
}

function openReturn(sale) {
  returning = sale;
  els.returnTitle.textContent = `إرجاع من الفاتورة رقم ${sale.number}`;
  els.returnError.hidden = true;
  els.returnLines.innerHTML = sale.items
    .map((item, index) => {
      const left = Math.round((item.quantity - (item.returnedQuantity ?? 0)) * 1000) / 1000;
      const per = item.mode === 'wholesale' ? 'للجملة' : item.unit === 'kg' ? 'للكيلو' : 'للقطعة';
      return `<tr${left ? '' : ' class="is-quiet"'}>
        <td><div class="pname">${escapeHtml(item.name)}</div><div class="pcat"><span class="num">${formatMoney(item.unitPrice)}</span> ${per}</div></td>
        <td><span class="num">${qtyLabel(item)}</span>${item.returnedQuantity ? ` <small class="returned-inline">أُرجع ${amountOf(item, item.returnedQuantity)}</small>` : ''}</td>
        <td>${
          wholeOnly(item)
            ? `<input class="input num return-qty" type="number" min="0" max="${left}" step="1" value="0" data-index="${index}"${left ? '' : ' disabled'} aria-label="الكمية المرتجعة من ${escapeHtml(item.name)}">`
            : `<input class="input num return-qty" type="number" min="0" max="${Math.round(left * 1000)}" step="1" value="0" data-index="${index}" data-scale="1000"${left ? '' : ' disabled'} aria-label="الوزن المرتجع بالغرام من ${escapeHtml(item.name)}"> <span class="per">غ</span>`
        }</td>
      </tr>`;
    })
    .join('');
  updateReturnAmount();
  els.returnDialog.showModal();
  els.returnLines.querySelector('input:not([disabled])')?.select();
}

els.returnLines.addEventListener('input', updateReturnAmount);
els.returnClose.addEventListener('click', () => els.returnDialog.close());
els.returnAll.addEventListener('click', () => {
  els.returnLines.querySelectorAll('input:not([disabled])').forEach((input) => (input.value = input.max));
  updateReturnAmount();
});

els.returnForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const showError = (message) => {
    els.returnError.textContent = message;
    els.returnError.hidden = false;
  };
  const rows = returnQuantities();
  const bad = rows.find((r) => !validReturn(r));
  if (bad) {
    const kind = wholeOnly(bad.item) ? 'عددًا صحيحًا' : 'وزنًا بالغرام';
    const max = wholeOnly(bad.item) ? formatQty(bad.max) : `${formatQty(Math.round(bad.max * 1000))} غ`;
    showError(`كمية «${bad.item.name}» يجب أن تكون ${kind} من 0 إلى ${max}`);
    return;
  }
  const items = rows.filter((r) => r.quantity > 0).map((r) => ({ line: r.line, quantity: r.quantity }));
  if (!items.length) {
    showError('اكتب عدد القطع المرتجعة، أو اضغط «إرجاع الكل»');
    return;
  }
  const button = els.returnForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const { refunded } = await api(`/sales/${returning._id}/returns`, { method: 'POST', body: { items } });
    els.returnDialog.close();
    toast(`تم الإرجاع. أعد للزبون ${formatMoney(refunded)}، والكمية عادت إلى المخزن`);
    load();
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
});

els.area.addEventListener('click', (e) => {
  const returnButton = e.target.closest('[data-return]');
  if (returnButton) {
    openReturn(daySales.find((s) => s._id === returnButton.dataset.return));
    return;
  }
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
