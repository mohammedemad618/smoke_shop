import { api, formatMoney, formatDateTime, escapeHtml, arCount, dayQuery, addMonths, monthKey } from './common.js';

const LOCALE = 'ar-u-nu-latn';
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const longDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthName = new Intl.DateTimeFormat(LOCALE, { month: 'long' });
const DAY_MS = 24 * 60 * 60 * 1000;
// A customer who owes and whose account has not moved for this long needs a reminder
const OVERDUE_DAYS = 30;
// A stocktake older than this is worth repeating
const STOCKTAKE_DAYS = 30;
const DEFAULT_LOW_STOCK = 5;
const INVOICE_COUNT = { one: 'فاتورة واحدة', two: 'فاتورتين', few: 'فواتير', many: 'فاتورة', single: 'فاتورة' };
const DAYS = { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يومًا', single: 'يوم' };

const $ = (id) => document.getElementById(id);
const els = { date: $('summaryDate'), view: $('summary') };

async function load() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthQuery = new URLSearchParams({
    from: monthStart.toISOString(),
    to: addMonths(monthStart, 1).toISOString(),
    groupBy: 'day',
    tz: TIME_ZONE,
  });
  const [today, month, valuation, products, customers, openCount] = await Promise.all([
    api(`/sales?${dayQuery(now)}`),
    api(`/sales/report?${monthQuery}`),
    api('/products/valuation'),
    api('/products'),
    api('/customers'),
    api('/stockcounts/current'),
  ]);
  els.date.textContent = longDay.format(now);
  els.view.innerHTML = `${salesBlock(today.summary, month.summary, now)}
    <div class="summary-pair">
      ${moneyBlock(valuation)}
      ${attentionBlock({ now, products, customers, openCount, lastCountAt: valuation.lastCountAt })}
    </div>`;
}

/* How the selling goes */

function salesCard({ title, href, s }) {
  return `<a class="sale-card" href="${href}">
    <span class="z-label">${title}</span>
    <strong class="sale-total num">${formatMoney(s.total)}</strong>
    <span class="z-note">${s.count ? `مبيعات في ${arCount(s.count, INVOICE_COUNT)}` : 'لا مبيعات بعد'}</span>
    <dl class="sale-lines">
      <div><dt>ربح المبيعات</dt><dd class="num${s.profit < 0 ? ' loss' : ''}">${formatMoney(s.profit)}</dd></div>
      <div><dt>صافي الربح</dt><dd class="num${s.netProfit < 0 ? ' loss' : ''}">${formatMoney(s.netProfit)}</dd></div>
    </dl>
  </a>`;
}

function salesBlock(today, month, now) {
  return `<section class="summary-block" aria-labelledby="salesTitle">
    <div class="section-head">
      <h2 id="salesTitle">البيع</h2>
      <a class="z-link" href="/sales.html">تقرير المبيعات</a>
    </div>
    <div class="sales-pair">
      ${salesCard({ title: 'اليوم', href: '/sales.html', s: today })}
      ${salesCard({ title: `هذا الشهر (${monthName.format(now)})`, href: `/sales.html?month=${monthKey(now)}`, s: month })}
    </div>
    <p class="hint">صافي الربح = ربح المبيعات − المصاريف − ما بيع بالدين ولم يُحصَّل + ما حُصِّل من الديون.</p>
  </section>`;
}

/* What the shop owns, as a sum anyone can follow */

function ledgerRow({ sign, label, note, value, href, tone = '' }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="ledger-row ${tone}"${href ? ` href="${href}"` : ''}>
    <span class="ledger-sign" aria-hidden="true">${sign}</span>
    <span class="ledger-label">${label}${note ? `<small>${note}</small>` : ''}</span>
    <span class="num">${formatMoney(value)}</span>
  </${tag}>`;
}

function moneyBlock(v) {
  const { owedToShop, owedByShop, owedToSuppliers } = v.debts;
  const capital = v.capital + owedToShop - owedByShop - owedToSuppliers;
  const rows = [
    ledgerRow({ sign: '', label: 'البضاعة على الرفوف', note: 'بسعر الشراء', value: v.capital, href: '/' }),
    ledgerRow({ sign: '+', label: 'ديون لك عند الزبائن', value: owedToShop, href: '/debts.html' }),
  ];
  if (owedByShop) rows.push(ledgerRow({ sign: '−', label: 'رصيد دفعه زبائن مقدمًا', value: owedByShop, href: '/debts.html' }));
  rows.push(ledgerRow({ sign: '−', label: 'ديون عليك للموردين', value: owedToSuppliers, href: '/purchases.html' }));
  rows.push(ledgerRow({ sign: '=', label: 'رأس مال المحل', value: capital, tone: 'ledger-total' }));

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

function attentionBlock({ now, products, customers, openCount, lastCountAt }) {
  const tracked = products.filter((p) => p.trackStock);
  const out = tracked.filter((p) => p.stock <= 0).length;
  const low = tracked.filter((p) => p.stock > 0 && p.stock <= (p.lowStockAlert ?? DEFAULT_LOW_STOCK)).length;
  const untracked = products.length - tracked.length;
  const overdue = customers.filter(
    (c) => c.balance > 0 && c.lastActivity && now - new Date(c.lastActivity) > OVERDUE_DAYS * DAY_MS,
  ).length;

  const items = [];
  const add = (tone, text, href, count) => items.push({ tone, text, href, count });
  if (out) add('is-stop', 'منتجات نفدت كميتها', '/?stock=out', out);
  if (low) add('is-warn', 'منتجات قاربت على النفاد', '/?stock=low', low);
  if (overdue) add('is-warn', 'زبائن عليهم دين وحسابهم بلا حركة منذ أكثر من شهر', '/debts.html', overdue);
  if (untracked) add('is-info', 'منتجات بلا كمية مسجّلة، تُسجَّل بالجرد أو بفاتورة شراء', '/?stock=untracked', untracked);
  if (openCount) {
    add('is-info', `جرد مفتوح منذ ${formatDateTime(openCount.createdAt)} لم يُعتمد بعد`, '/stocktake.html');
  } else if (!lastCountAt) {
    if (tracked.length) add('is-info', 'لم يُجرَ جرد بعد', '/stocktake.html');
  } else {
    const days = Math.floor((now - new Date(lastCountAt)) / DAY_MS);
    if (days > STOCKTAKE_DAYS) add('is-info', `آخر جرد قبل ${arCount(days, DAYS)}`, '/stocktake.html');
  }

  const list = items.length
    ? `<ul class="attention">${items
        .map(
          (i) => `<li><a class="attention-row ${i.tone}" href="${i.href}">
            <span class="attention-dot" aria-hidden="true"></span>
            <span class="attention-text">${escapeHtml(i.text)}</span>
            ${i.count ? `<strong class="num">${formatMoney(i.count)}</strong>` : ''}
          </a></li>`,
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
