import { api, formatMoney, escapeHtml, arCount, dayKey, parseKey, addDays, addMonths, monthKey, can, canOpen, session, shopInfo } from './common.js';
import { reportCalendar } from './report-calendar.js';
import { debtActivity } from './debt-activity.js';

const LOCALE = 'ar-u-nu-latn';
const { timeZone } = await shopInfo;
const calendar = reportCalendar(timeZone);
const reportDateTime = new Intl.DateTimeFormat(LOCALE, { timeZone, dateStyle: 'medium', timeStyle: 'short' });
const longDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthName = new Intl.DateTimeFormat(LOCALE, { month: 'long' });
const DAY_MS = 24 * 60 * 60 * 1000;
// A stocktake older than this is worth repeating
const STOCKTAKE_DAYS = 30;
const DEFAULT_LOW_STOCK = 5;
const INVOICE_COUNT = { one: 'فاتورة واحدة', two: 'فاتورتين', few: 'فواتير', many: 'فاتورة', single: 'فاتورة' };
const DAYS = { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يومًا', single: 'يوم' };
const EMPTY_SALES = { count: 0, total: 0, returns: 0, cost: 0, profit: 0, expenses: 0, netProfit: 0 };

const $ = (id) => document.getElementById(id);
const els = { date: $('summaryDate'), view: $('summary') };
const payments = {
  dialog: $('summaryPayments'),
  period: $('summaryPaymentsPeriod'),
  status: $('summaryPaymentsStatus'),
  table: $('summaryPaymentsTable'),
  rows: $('summaryPaymentsRows'),
  more: $('summaryPaymentsMore'),
  range: '',
  cursor: null,
  request: 0,
};
let periods;
let flowPeriod = 'month';
let flowRequest = 0;
let pageRequest = 0;

// The page is `reports`; what it loads is open to `reports`, but for the customers who owe
// (`credit`) and the open stocktake (`products`). An account without one of those gets
// `fallback` in its place and the page without that reminder, rather than no page at all
// on the 403 (FORBIDDEN as well when the permission was taken away since the page loaded).
async function optional(key, path, fallback, query) {
  await session;
  if (!can(key)) return fallback;
  try {
    return await api(query ? `${path}?${query}` : path);
  } catch (err) {
    if (err.code === 'FORBIDDEN') return fallback;
    throw err;
  }
}

// A link only to a page the account may open
const link = (href) => (canOpen(new URL(href, location.href).pathname) ? href : null);

async function load() {
  const request = ++pageRequest;
  const now = new Date();
  const shopDay = parseKey(calendar.dayKey(now));
  const monthStart = new Date(shopDay.getFullYear(), shopDay.getMonth(), 1);
  const monthRange = new URLSearchParams(calendar.range(dayKey(monthStart), dayKey(addMonths(monthStart, 1))));
  const monthQuery = new URLSearchParams(monthRange);
  monthQuery.set('groupBy', 'day');
  monthQuery.set('tz', timeZone);
  const [month, valuation, products, customers, openCount] = await Promise.all([
    api(`/sales/report?${monthQuery}`),
    api('/products/valuation'),
    api('/products'),
    optional('credit', '/customers', []),
    optional('products', '/stockcounts/current', null),
  ]);
  if (request !== pageRequest) return;
  periods = {
    today: { label: 'اليوم', range: new URLSearchParams(calendar.range(dayKey(shopDay), dayKey(addDays(shopDay, 1)))).toString() },
    month: { label: `هذا الشهر (${monthName.format(shopDay)})`, range: monthRange.toString() },
  };
  const today = month.periods.find((day) => day.key === dayKey(shopDay)) ?? EMPTY_SALES;
  els.date.textContent = longDay.format(shopDay);
  els.view.innerHTML = `${salesBlock(today, month.summary, shopDay, valuation.cashBalance)}
    ${flowBlocks()}
    <div class="summary-pair">
      ${moneyBlock(valuation, products)}
      ${attentionBlock({ now, products, customers, openCount, lastCountAt: valuation.lastCountAt, counts: can('products') })}
    </div>`;
  loadFlows();
}

/* How the selling goes */

function profitDetails(s, title) {
  const rows = [
    ['قيمة الفواتير قبل المرتجعات', s.total + s.returns],
    ['مرتجعات الفترة', -s.returns, true],
    ['صافي المبيعات', s.total],
    ...(s.returns || s.returnedCost ? [
      ['تكلفة البضاعة قبل المرتجعات', -(s.cost + (s.returnedCost ?? 0)), true],
      ['تكلفة البضاعة المُرجعة', s.returnedCost ?? 0, true],
    ] : []),
    ['تكلفة البضاعة المباعة بعد المرتجعات', -s.cost, true],
    ['مجمل ربح المبيعات', s.profit],
    ['المصاريف المسجّلة', -s.expenses, true],
    ['صافي ربح النشاط', s.netProfit],
  ];
  return `<details class="profit-details">
    <summary aria-label="كيف حُسب صافي ربح ${title}؟">كيف حُسب؟</summary>
    <dl class="sale-lines">${rows.map(([label, value, change]) =>
      `<div><dt>${label}</dt><dd class="num${value < 0 ? ' loss' : ''}">${change && value > 0 ? '+' : ''}${formatMoney(value)}</dd></div>`,
    ).join('')}</dl>
  </details>`;
}

function salesCard({ title, href, s }) {
  return `<article class="sale-card">
    <a class="sale-card-link" href="${href}">
      <span class="z-label">${title}</span>
      <strong class="sale-total num${s.netProfit < 0 ? ' loss' : ''}">${formatMoney(s.netProfit)}</strong>
      <span class="z-note">صافي ربح النشاط بعد المصاريف</span>
    </a>
    <dl class="sale-lines">
      <div><dt>صافي المبيعات</dt><dd class="num">${formatMoney(s.total)}</dd></div>
      <div><dt>مجمل ربح المبيعات</dt><dd class="num${s.profit < 0 ? ' loss' : ''}">${formatMoney(s.profit)}</dd></div>
      <div><dt>الفواتير</dt><dd>${arCount(s.count, INVOICE_COUNT)}</dd></div>
    </dl>
    ${profitDetails(s, title)}
  </article>`;
}

function salesBlock(today, month, now, cashBalance) {
  return `<section class="summary-block" aria-labelledby="salesTitle">
    <div class="section-head">
      <h2 id="salesTitle">ربح النشاط</h2>
      <a class="z-link" href="/sales.html">تقرير المبيعات</a>
    </div>
    <div class="sales-pair">
      ${salesCard({ title: 'اليوم', href: '/sales.html', s: today })}
      ${salesCard({ title: periods.month.label, href: `/sales.html?month=${monthKey(now)}`, s: month })}
      <a class="sale-card cash-now" href="#cashTitle"><span class="z-label">رصيد الصندوق الآن</span>
        <strong class="sale-total num">${formatMoney(cashBalance)}</strong><span class="z-note">عرض حركة الصندوق</span></a>
    </div>
  </section>`;
}

function flowBlocks() {
  return `<div class="section-head summary-cash-head">
      <span id="flowLabel">فترة الصندوق والديون</span>
      <div class="segmented segmented-sm" role="group" aria-labelledby="flowLabel">
        <button type="button" data-flow-period="today" aria-pressed="${flowPeriod === 'today'}">اليوم</button>
        <button type="button" data-flow-period="month" aria-pressed="${flowPeriod === 'month'}">هذا الشهر</button>
      </div>
    </div>
    <section class="summary-block" aria-labelledby="cashTitle">
    <div class="section-head summary-cash-head">
      <h2 id="cashTitle">حركة الصندوق</h2>
    </div>
    <div id="summaryCashBody" aria-live="polite"></div>
  </section>
  <section class="summary-block" aria-labelledby="debtTitle">
    <div class="section-head"><h2 id="debtTitle">الديون والتحصيل</h2></div>
    <div id="summaryDebtBody" aria-live="polite"></div>
  </section>`;
}

function cashRows(cash) {
  const rows = [
    ledgerRow({ label: 'رصيد بداية الفترة', value: cash.openingBalance }),
    ledgerRow({ sign: '+', label: 'النقد المقبوض عند البيع', value: cash.salesReceived }),
    ledgerRow({ sign: '+', label: 'إجمالي تسديدات الزبائن', value: cash.customerPayments, showPayments: cash.customerPayments > 0 && can('credit') }),
    ledgerRow({ label: 'إجمالي الداخل', value: cash.salesReceived + cash.customerPayments, tone: 'ledger-subtotal' }),
    ledgerRow({ sign: '−', label: 'المرتجعات النقدية', value: cash.refunds }),
    ledgerRow({ sign: '−', label: 'مدفوعات الموردين', value: cash.supplierPayments }),
    ledgerRow({ sign: '−', label: 'المصاريف', value: cash.expenses }),
    ledgerRow({ label: 'إجمالي الخارج', value: cash.refunds + cash.supplierPayments + cash.expenses, tone: 'ledger-subtotal' }),
    ledgerRow({ sign: '=', label: 'رصيد نهاية الفترة', value: cash.closingBalance, tone: 'ledger-total' }),
  ];
  return `<div class="ledger">${rows.join('')}</div>`;
}

function debtRows({ sales, manual, advances, received }) {
  const columns = [
    ['opening', 'رصيد أول الفترة'], ['added', 'دين أُضيف'], ['paid', 'سدّده الزبائن'],
    ...(sales.returns || manual.returns ? [['returns', 'تسويات المرتجعات']] : []),
    ...(sales.advanceUsed || manual.advanceUsed ? [['advanceUsed', 'سُدّد من رصيد مقدّم']] : []),
    ['closing', 'الدين المتبقي'],
  ];
  const row = (label, figures) => `<tr><td class="cell-title">${label}</td>${columns.map(([key, title]) =>
    `<td class="end" data-label="${title}"><span class="num">${formatMoney(figures[key])}</span></td>`).join('')}</tr>`;
  const totals = Object.fromEntries(columns.map(([key]) => [key, sales[key] + manual[key]]));
  const table = `<table class="ptable debt-movement"><thead><tr><th scope="col">مصدر الدين</th>
    ${columns.map(([, title]) => `<th scope="col" class="end">${title}</th>`).join('')}</tr></thead>
    <tbody>${row('فواتير بيع بالدين', sales)}${row('ديون أُضيفت يدويًا', manual)}</tbody>
    <tfoot>${row('إجمالي الديون', totals)}</tfoot></table>`;
  const advanceRows = Object.values(advances).some(Boolean) ? `<h3>أرصدة الزبائن المقدّمة</h3><div class="ledger">${[
    ledgerRow({ label: 'رصيد مقدّم أول الفترة', value: advances.opening }),
    ledgerRow({ sign: '+', label: 'من دفعات الفترة', value: advances.received }),
    ...(advances.returns ? [ledgerRow({ sign: '+', label: 'من تسويات المرتجعات', value: advances.returns })] : []),
    ledgerRow({ sign: '−', label: 'استُخدم لسداد ديون', value: advances.used }),
    ledgerRow({ sign: '=', label: 'الرصيد المقدّم المتبقي', value: advances.closing }),
  ].join('')}</div>` : '';
  const label = flowPeriod === 'month' ? 'المحصّل من الديون هذا الشهر' : 'المحصّل من الديون اليوم';
  return `<div class="ledger">${ledgerRow({ label, value: received, showPayments: received > 0 && can('credit') })}</div>${table}${advanceRows}`;
}

function loadFlows() {
  const request = ++flowRequest;
  const { range } = periods[flowPeriod];
  async function render(body, response, makeRows) {
    body.innerHTML = '<p class="hint">جارٍ التحميل…</p>';
    try {
      const figures = await response;
      if (request === flowRequest) body.innerHTML = makeRows(figures);
    } catch (err) {
      if (request === flowRequest) body.innerHTML = `<p class="form-error" role="alert">${escapeHtml(err.message)}</p>
        <button class="btn" type="button" data-flow-retry>إعادة التحميل</button>`;
    }
  }
  render($('summaryCashBody'), api(`/summary/cash?${range}`), cashRows);
  render($('summaryDebtBody'), api(`/summary/debts?${range}`), debtRows);
}

function paymentRow(payment) {
  const customer = escapeHtml(payment.customerName || 'زبون');
  const note = payment.note ? `<small class="pct">${escapeHtml(payment.note)}</small>` : '';
  const balance = payment.balanceAfter;
  const balanceText = balance === undefined ? '—' : balance === 0 ? 'مسدّد' : `${balance > 0 ? 'عليه' : 'له'} ${formatMoney(Math.abs(balance))}`;
  return `<tr${payment.advance > 0 ? ' class="has-advance"' : ''}>
    <td class="cell-title"><a class="z-link" href="/debts.html?customer=${encodeURIComponent(payment.customer)}">${customer}</a>
      <small class="pct">${reportDateTime.format(new Date(payment.date))}</small>${note}</td>
    <td class="end payment-amount" data-label="مبلغ الدفعة كاملًا"><strong class="num">${formatMoney(payment.amount)}</strong></td>
    <td class="end" data-label="لسداد فواتير البيع"><span class="num">${formatPaymentPart(payment.appliedToSales)}</span></td>
    <td class="end" data-label="لسداد دين سابق أُضيف يدويًا"><span class="num">${formatPaymentPart(payment.appliedToOtherDebt)}</span></td>
    <td class="end payment-advance" data-label="رصيد مقدّم للزبون"><span class="num">${formatPaymentPart(payment.advance)}</span></td>
    <td class="end" data-label="الرصيد بعد الدفعة">${balanceText}</td>
  </tr>`;
}

function formatPaymentPart(amount) {
  return Number.isFinite(amount) ? formatMoney(amount) : '—';
}

async function loadPayments() {
  const request = ++payments.request;
  const query = new URLSearchParams(payments.range);
  if (payments.cursor) query.set('before', payments.cursor);
  payments.more.disabled = true;
  payments.status.textContent = 'جارٍ تحميل التسديدات…';
  try {
    const data = await optional('credit', '/customers/payments', null, query);
    if (request !== payments.request) return;
    if (!data) {
      payments.rows.replaceChildren();
      payments.table.hidden = true;
      payments.more.hidden = true;
      payments.status.textContent = 'عرض التسديدات يتطلب صلاحية البيع بالدين ودفعات العملاء.';
      return;
    }
    payments.rows.insertAdjacentHTML('beforeend', data.payments.map(paymentRow).join(''));
    payments.cursor = data.next;
    payments.table.hidden = !payments.rows.children.length;
    payments.status.textContent = payments.table.hidden ? 'لا توجد تسديدات في هذه الفترة.' : '';
    payments.more.hidden = !payments.cursor;
    payments.more.textContent = 'عرض المزيد';
  } catch (err) {
    if (request !== payments.request) return;
    payments.status.textContent = err.message;
    payments.more.hidden = false;
    payments.more.textContent = 'إعادة المحاولة';
  } finally {
    if (request === payments.request) payments.more.disabled = false;
  }
}

function openPayments() {
  const period = periods[flowPeriod];
  payments.range = period.range;
  payments.period.textContent = period.label;
  payments.cursor = null;
  payments.rows.replaceChildren();
  payments.table.hidden = true;
  payments.more.hidden = true;
  payments.dialog.showModal();
  loadPayments();
}

payments.more.addEventListener('click', loadPayments);
payments.dialog.addEventListener('close', () => { payments.request++; });
els.view.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const period = button.dataset.flowPeriod;
  if (period && period !== flowPeriod) {
    flowPeriod = period;
    for (const choice of els.view.querySelectorAll('[data-flow-period]')) {
      choice.setAttribute('aria-pressed', String(choice.dataset.flowPeriod === period));
    }
    loadFlows();
  } else if (button.hasAttribute('data-cash-payments')) openPayments();
  else if (button.hasAttribute('data-flow-retry')) loadFlows();
});

/* What the shop owns, as a sum anyone can follow */

function ledgerRow({ sign = '', label, note, value, href, tone = '', showPayments = false }) {
  const tag = href ? 'a' : showPayments ? 'button' : 'div';
  const attributes = href ? ` href="${href}"` : showPayments ? ' type="button" data-cash-payments aria-haspopup="dialog"' : '';
  const detail = showPayments ? 'عرض الدفعات وتوزيعها' : note;
  return `<${tag} class="ledger-row ${tone}"${attributes}>
    <span class="ledger-sign" aria-hidden="true">${sign}</span>
    <span class="ledger-label">${label}${detail ? `<small>${detail}</small>` : ''}</span>
    <span class="num">${formatMoney(value)}</span>
  </${tag}>`;
}

function moneyBlock(v, products) {
  const { owedToShop, owedByShop, owedToSuppliers } = v.debts;
  const rows = [
    ledgerRow({ sign: '', label: 'المخزون بالتكلفة المسجّلة', note: 'تكلفة الكميات المتبقية من الرصيد الافتتاحي ودفعات الشراء', value: v.capital, href: link('/') }),
    ledgerRow({ sign: '+', label: 'رصيد الصندوق', note: 'يشمل الرصيد الافتتاحي', value: v.cashBalance }),
    ledgerRow({ sign: '+', label: 'ديون لك عند الزبائن', value: owedToShop, href: link('/debts.html?balance=owing') }),
  ];
  if (owedByShop) rows.push(ledgerRow({ sign: '−', label: 'رصيد دفعه زبائن مقدمًا', value: owedByShop, href: link('/debts.html?balance=advance') }));
  rows.push(ledgerRow({ sign: '−', label: 'ديون عليك للموردين', value: owedToSuppliers, href: link('/purchases.html') }));
  rows.push(ledgerRow({ sign: '=', label: 'صافي أموال المحل المسجّلة', value: v.shopCapital, tone: 'ledger-total' }));

  const notes = [];
  const openingStock = products.filter(p => p.trackStock && p.stock > 0 && !Array.isArray(p.stockLots)).length;
  if (openingStock) notes.push(`عدد الأصناف التي تُقيَّم كرصيد افتتاحي بسعر الشراء المحفوظ هو ${formatMoney(openingStock)}.`);
  if (v.tracked) {
    notes.push(`قيمة المخزون بأسعار البيع الحالية ${formatMoney(v.saleValue)}، وهامشه المتوقع قبل المصاريف ${formatMoney(v.saleValue - v.capital)}.`);
  }
  if (v.products > v.tracked) {
    notes.push(`لا يشمل المنتجات التي بلا كمية مسجّلة (${formatMoney(v.products - v.tracked)}).`);
  }
  return `<section class="summary-block" aria-labelledby="moneyTitle">
    <div class="section-head"><h2 id="moneyTitle">صافي أموال المحل الآن</h2></div>
    <div class="ledger">${rows.join('')}</div>
    ${notes.length ? `<p class="hint">${notes.join(' ')}</p>` : ''}
  </section>`;
}

/* What needs doing */

// The stocktake reminders only for an account that does the stocktake (`counts`); each row
// links to its page when the account may open it
function attentionBlock({ now, products, customers, openCount, lastCountAt, counts }) {
  const tracked = products.filter((p) => p.trackStock);
  const out = tracked.filter((p) => p.stock <= 0).length;
  const low = tracked.filter((p) => p.stock > 0 && p.stock <= (p.lowStockAlert ?? DEFAULT_LOW_STOCK)).length;
  const untracked = products.length - tracked.length;
  const overdue = customers.filter(
    (c) => c.balance > 0 && debtActivity(c.lastActivity, now) === 'stale',
  ).length;

  const items = [];
  const add = (tone, text, href, count) => items.push({ tone, text, href: link(href), count });
  if (out) add('is-stop', 'منتجات نفدت كميتها', '/?stock=out', out);
  if (low) add('is-warn', 'منتجات قاربت على النفاد', '/?stock=low', low);
  if (overdue) add('is-warn', 'زبائن عليهم دين وحسابهم بلا حركة منذ أكثر من 30 يومًا', '/debts.html?balance=owing&activity=stale', overdue);
  if (untracked) add('is-info', 'منتجات بلا كمية مسجّلة، تُسجَّل بالجرد أو بفاتورة شراء', '/?stock=untracked', untracked);
  if (counts && openCount) {
    add('is-info', `جرد مفتوح منذ ${reportDateTime.format(new Date(openCount.createdAt))} لم يُعتمد بعد`, '/stocktake.html');
  } else if (counts && !lastCountAt) {
    if (tracked.length) add('is-info', 'لم يُجرَ جرد بعد', '/stocktake.html');
  } else if (counts) {
    const days = Math.floor((now - new Date(lastCountAt)) / DAY_MS);
    if (days > STOCKTAKE_DAYS) add('is-info', `آخر جرد قبل ${arCount(days, DAYS)}`, '/stocktake.html');
  }

  const list = items.length
    ? `<ul class="attention">${items
        .map(
          (i) => `<li><${i.href ? `a href="${i.href}"` : 'div'} class="attention-row ${i.tone}">
            <span class="attention-dot" aria-hidden="true"></span>
            <span class="attention-text">${escapeHtml(i.text)}</span>
            ${i.count ? `<strong class="num">${formatMoney(i.count)}</strong>` : ''}
          </${i.href ? 'a' : 'div'}></li>`,
        )
        .join('')}</ul>`
    : '<p class="all-good">لا شيء يحتاج انتباهك الآن.</p>';
  return `<section class="summary-block" aria-labelledby="attentionTitle">
    <div class="section-head"><h2 id="attentionTitle">يحتاج انتباهك</h2></div>
    ${list}
  </section>`;
}

function showError(err) {
  els.view.innerHTML = `<div class="empty"><h3>تعذر تحميل الملخص</h3><p>${escapeHtml(err.message)}</p></div>`;
}

// Coming back to the page (e.g. after selling) shows fresh figures
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load().catch(showError);
});

load().catch(showError);
