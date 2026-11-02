import { api, toast, formatMoney, formatTime, escapeHtml, arCount, PIECES, dayQuery } from './common.js';

const $ = (id) => document.getElementById(id);
const els = {
  date: $('dateInput'),
  prev: $('prevDay'),
  next: $('nextDay'),
  today: $('todayBtn'),
  summary: $('summary'),
  area: $('salesArea'),
};

const toDateValue = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function setDate(value) {
  els.date.value = value;
  const today = toDateValue(new Date());
  els.date.max = today;
  els.next.disabled = value >= today;
  load();
}

function shiftDay(delta) {
  const [y, m, d] = els.date.value.split('-').map(Number);
  setDate(toDateValue(new Date(y, m - 1, d + delta)));
}

async function load() {
  const [y, m, d] = els.date.value.split('-').map(Number);
  try {
    render(await api(`/sales?${dayQuery(new Date(y, m - 1, d))}`));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function render({ summary, sales }) {
  els.summary.innerHTML = `
    <div><div class="z-label">عدد الفواتير</div><div class="z-value num">${summary.count}</div></div>
    <div><div class="z-label">إجمالي المبيعات</div><div class="z-value num">${formatMoney(summary.total)}</div></div>
    <div><div class="z-label">الربح</div><div class="z-value num ${summary.profit < 0 ? 'is-loss' : 'is-profit'}">${formatMoney(summary.profit)}</div></div>`;

  if (!sales.length) {
    els.area.innerHTML = `<div class="empty">
      <h3>لا توجد مبيعات في هذا اليوم</h3>
      <p>الفواتير التي تتم من شاشة الكاشير تظهر هنا.</p>
    </div>`;
    return;
  }

  els.area.innerHTML = `<table class="ptable">
    <thead><tr>
      <th scope="col">رقم الفاتورة</th>
      <th scope="col">الوقت</th>
      <th scope="col">القطع</th>
      <th scope="col" class="end">الإجمالي</th>
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
          <td class="end num${sale.profit < 0 ? ' loss' : ''}">${formatMoney(sale.profit)}</td>
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

els.area.addEventListener('click', (e) => {
  const button = e.target.closest('[data-toggle]');
  if (!button) return;
  const row = $(button.dataset.toggle);
  row.hidden = !row.hidden;
  button.setAttribute('aria-expanded', String(!row.hidden));
});

els.date.addEventListener('change', () => els.date.value && setDate(els.date.value));
els.prev.addEventListener('click', () => shiftDay(-1));
els.next.addEventListener('click', () => shiftDay(1));
els.today.addEventListener('click', () => setDate(toDateValue(new Date())));

setDate(toDateValue(new Date()));
