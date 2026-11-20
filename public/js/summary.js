import { api, formatMoney, formatDateTime, escapeHtml, arCount, dayKey, dayQuery, addMonths, monthKey, can, canOpen, session } from './common.js';
import { debtActivity } from './debt-activity.js';

const LOCALE = 'ar-u-nu-latn';
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const longDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthName = new Intl.DateTimeFormat(LOCALE, { month: 'long' });
const DAY_MS = 24 * 60 * 60 * 1000;
// A stocktake older than this is worth repeating
const STOCKTAKE_DAYS = 30;
const DEFAULT_LOW_STOCK = 5;
const INVOICE_COUNT = { one: 'فاتورة واحدة', two: 'فاتورتين', few: 'فواتير', many: 'فاتورة', single: 'فاتورة' };
const DAYS = { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يومًا', single: 'يوم' };
const EMPTY_SALES = { count: 0, total: 0, cost: 0, profit: 0, expenses: 0, credit: 0, collected: 0, netProfit: 0 };

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
let cashPeriod = 'today';
let cashRequest = 0;
const cashCache = new Map();

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
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthRange = new URLSearchParams({
    from: monthStart.toISOString(),
    to: addMonths(monthStart, 1).toISOString(),
  });
  const monthQuery = new URLSearchParams(monthRange);
  monthQuery.set('groupBy', 'day');
  monthQuery.set('tz', TIME_ZONE);
  const [month, valuation, products, customers, openCount] = await Promise.all([
    api(`/sales/report?${monthQuery}`),
    api('/products/valuation'),
    api('/products'),
    optional('credit', '/customers', []),
    optional('products', '/stockcounts/current', null),
  ]);
  periods = {
    today: { label: 'اليوم', range: dayQuery(now) },
    month: { label: `هذا الشهر (${monthName.format(now)})`, range: monthRange.toString() },
  };
  cashCache.clear();
  const today = month.periods.find((day) => day.key === dayKey(now)) ?? EMPTY_SALES;
  els.date.textContent = longDay.format(now);
  els.view.innerHTML = `${salesBlock(today, month.summary, now)}
    ${cashBlock()}
    <div class="summary-pair">
      ${moneyBlock(valuation)}
      ${attentionBlock({ now, products, customers, openCount, lastCountAt: valuation.lastCountAt, counts: can('products') })}
    </div>`;
  loadCash();
}

/* How the selling goes */

function profitDetails(s, title) {
  const rows = [
    ['صافي المبيعات', s.total],
    ['تكلفة البضاعة المباعة (FIFO)', -s.cost, true],
    ['ربح المبيعات', s.profit],
    ['المصاريف', -s.expenses, true],
    ['البيع بالدين بعد تسويات المرتجعات', -s.credit, true],
    ['المحصَّل من ديون المبيعات', s.collected, true],
    ['صافي الربح', s.netProfit],
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
      <strong class="sale-total num">${formatMoney(s.total)}</strong>
      <span class="z-note">${s.count ? `مبيعات في ${arCount(s.count, INVOICE_COUNT)}` : 'لا مبيعات بعد'}</span>
    </a>
    <dl class="sale-lines">
      <div><dt>ربح المبيعات</dt><dd class="num${s.profit < 0 ? ' loss' : ''}">${formatMoney(s.profit)}</dd></div>
      <div><dt>صافي الربح</dt><dd class="num${s.netProfit < 0 ? ' loss' : ''}">${formatMoney(s.netProfit)}</dd></div>
    </dl>
    ${profitDetails(s, title)}
  </article>`;
}

function salesBlock(today, month, now) {
  return `<section class="summary-block" aria-labelledby="salesTitle">
    <div class="section-head">
      <h2 id="salesTitle">البيع</h2>
      <a class="z-link" href="/sales.html">تقرير المبيعات</a>
    </div>
    <div class="sales-pair">
      ${salesCard({ title: 'اليوم', href: '/sales.html', s: today })}
      ${salesCard({ title: periods.month.label, href: `/sales.html?month=${monthKey(now)}`, s: month })}
    </div>
  </section>`;
}

function cashBlock() {
  return `<section class="summary-block" aria-labelledby="cashTitle">
    <div class="section-head summary-cash-head">
      <h2 id="cashTitle">حركة الصندوق</h2>
      <div class="segmented segmented-sm" role="group" aria-label="فترة حركة الصندوق">
        <button type="button" data-cash-period="today" aria-pressed="${cashPeriod === 'today'}">اليوم</button>
        <button type="button" data-cash-period="month" aria-pressed="${cashPeriod === 'month'}">هذا الشهر</button>
      </div>
    </div>
    <div id="summaryCashBody" aria-live="polite"></div>
  </section>`;
}

async function loadCash() {
  const request = ++cashRequest;
  const period = periods[cashPeriod];
  const body = $('summaryCashBody');
  body.innerHTML = '<p class="hint">جارٍ تحميل حركة الصندوق…</p>';
  try {
    const cash = cashCache.get(period.range) ?? await api(`/summary/cash?${period.range}`);
    if (request !== cashRequest) return;
    cashCache.set(period.range, cash);
    const showPayments = cash.customerPayments > 0 && can('credit');
    const rows = [
      ledgerRow({ label: 'رصيد بداية الفترة', value: cash.openingBalance }),
      ledgerRow({ sign: '+', label: 'النقد المقبوض عند البيع', value: cash.salesReceived }),
      ledgerRow({ sign: '+', label: 'إجمالي تسديدات الزبائن', value: cash.customerPayments, showPayments }),
      ledgerRow({ sign: '−', label: 'المرتجعات النقدية', value: cash.refunds }),
      ledgerRow({ sign: '−', label: 'مدفوعات الموردين', value: cash.supplierPayments }),
      ledgerRow({ sign: '−', label: 'المصاريف', value: cash.expenses }),
      ledgerRow({ sign: '=', label: 'رصيد نهاية الفترة', value: cash.closingBalance, tone: 'ledger-total' }),
    ];
    body.innerHTML = `<div class="ledger">${rows.join('')}</div>`;
  } catch (err) {
    if (request !== cashRequest) return;
    body.innerHTML = `<p class="form-error" role="alert">${escapeHtml(err.message)}</p>
      <button class="btn" type="button" data-cash-retry>إعادة تحميل حركة الصندوق</button>`;
  }
}

function paymentRow(payment) {
  const customer = escapeHtml(payment.customerName || 'زبون');
  const note = payment.note ? `<small class="pct">${escapeHtml(payment.note)}</small>` : '';
  const balance = payment.balanceAfter;
  const balanceText = balance === undefined ? '—' : balance === 0 ? 'مسدّد' : `${balance > 0 ? 'عليه' : 'له'} ${formatMoney(Math.abs(balance))}`;
  return `<tr${payment.advance > 0 ? ' class="has-advance"' : ''}>
    <td class="cell-title"><a class="z-link" href="/debts.html?customer=${encodeURIComponent(payment.customer)}">${customer}</a>
      <small class="pct">${formatDateTime(payment.date)}</small>${note}</td>
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
  const period = periods[cashPeriod];
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
  const period = button.dataset.cashPeriod;
  if (period && period !== cashPeriod) {
    cashPeriod = period;
    for (const choice of els.view.querySelectorAll('[data-cash-period]')) {
      choice.setAttribute('aria-pressed', String(choice.dataset.cashPeriod === period));
    }
    loadCash();
  } else if (button.hasAttribute('data-cash-payments')) openPayments();
  else if (button.hasAttribute('data-cash-retry')) loadCash();
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

function moneyBlock(v) {
  const { owedToShop, owedByShop, owedToSuppliers } = v.debts;
  const rows = [
    ledgerRow({ sign: '', label: 'البضاعة على الرفوف', note: 'بتكلفة الدفعات المتبقية', value: v.capital, href: link('/') }),
    ledgerRow({ sign: '+', label: 'رصيد الصندوق', note: 'يشمل الرصيد الافتتاحي', value: v.cashBalance }),
    ledgerRow({ sign: '+', label: 'ديون لك عند الزبائن', value: owedToShop, href: link('/debts.html?balance=owing') }),
  ];
  if (owedByShop) rows.push(ledgerRow({ sign: '−', label: 'رصيد دفعه زبائن مقدمًا', value: owedByShop, href: link('/debts.html?balance=advance') }));
  rows.push(ledgerRow({ sign: '−', label: 'ديون عليك للموردين', value: owedToSuppliers, href: link('/purchases.html') }));
  rows.push(ledgerRow({ sign: '=', label: 'رأس مال المحل', value: v.shopCapital, tone: 'ledger-total' }));

  const notes = [];
  if (v.tracked) {
    notes.push(`البضاعة نفسها تساوي ${formatMoney(v.saleValue)} بسعر البيع، أي ربح متوقع ${formatMoney(v.saleValue - v.capital)} عند بيعها.`);
  }
  if (v.products > v.tracked) {
    notes.push(`لا يشمل المنتجات التي بلا كمية مسجّلة (${formatMoney(v.products - v.tracked)}).`);
  }
  return `<section class="summary-block" aria-labelledby="moneyTitle">
    <div class="section-head"><h2 id="moneyTitle">مال المحل</h2></div>
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
    add('is-info', `جرد مفتوح منذ ${formatDateTime(openCount.createdAt)} لم يُعتمد بعد`, '/stocktake.html');
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
