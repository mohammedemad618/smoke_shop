import { api, toast, formatMoney, formatDateTime, escapeHtml, arCount, normalizeArabic, latinDigits, dayKey, parseKey, roundMoney } from './common.js';
import { debtActivity } from './debt-activity.js';

const CUSTOMERS = { one: 'زبون واحد', two: 'زبونان', few: 'زبائن', many: 'زبونًا', single: 'زبون' };
const ENTRY_LABELS = {
  sale: (e) => `شراء بالدين، فاتورة رقم ${e.saleNumber}`,
  manual: () => 'دين مضاف',
  payment: () => 'تسديد',
  return: (e) => `إرجاع من فاتورة رقم ${e.saleNumber}`,
};

const $ = (id) => document.getElementById(id);
const els = {
  search: $('customerSearch'),
  balanceFilter: $('customerBalanceFilter'),
  activityFilter: $('customerActivityFilter'),
  clearFilters: $('clearCustomerFilters'),
  add: $('addCustomerBtn'),
  list: $('customerList'),
  panel: $('customerPanel'),
  customerDialog: $('customerDialog'),
  customerForm: $('customerForm'),
  customerTitle: $('customerDialogTitle'),
  cName: $('cName'),
  cPhone: $('cPhone'),
  cNote: $('cNote'),
  customerError: $('customerError'),
  entryDialog: $('entryDialog'),
  entryForm: $('entryForm'),
  entryTitle: $('entryDialogTitle'),
  entryHint: $('entryHint'),
  amount: $('enAmount'),
  date: $('enDate'),
  note: $('enNote'),
  fullAmount: $('fullAmountBtn'),
  entryError: $('entryError'),
  entrySubmit: $('entrySubmit'),
};

const emptyEntryFilters = () => ({ kind: '', from: '', to: '' });
const state = { customers: [], selectedId: null, detail: null, editingCustomer: null, entryKind: null, entryFilters: emptyEntryFilters() };
let detailRequest = 0;

// What a balance means for the shop: + they owe us, - we owe them (they paid ahead)
function balanceText(balance) {
  if (balance > 0) return `عليه ${formatMoney(balance)}`;
  if (balance < 0) return `له ${formatMoney(-balance)}`;
  return 'لا دين';
}
const balanceClass = (balance) => (balance > 0 ? 'owes' : balance < 0 ? 'credit' : 'clear');

/* Loading */

async function loadCustomers() {
  state.customers = await api('/customers');
  renderCustomers();
}

async function loadDetail() {
  const request = ++detailRequest;
  const id = state.selectedId;
  if (!id) return;
  try {
    const customer = await api(`/customers/${encodeURIComponent(id)}`);
    if (request !== detailRequest) return;
    state.detail = customer;
    renderDetail();
  } catch (err) {
    if (request !== detailRequest) return;
    toast(err.message, 'error');
    select(null);
  }
}

async function refresh() {
  try {
    await loadCustomers();
    await loadDetail();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function updateLocation() {
  const url = new URL(location.href);
  for (const [key, value] of [
    ['customer', state.selectedId],
    ['balance', els.balanceFilter.value],
    ['activity', els.activityFilter.value],
  ]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, '', url);
}

function select(id) {
  if (id !== state.selectedId) {
    state.detail = null;
    state.entryFilters = emptyEntryFilters();
    if (id) els.panel.innerHTML = '<div class="table-wrap"><p class="hint">جارٍ تحميل كشف الحساب…</p></div>';
  }
  state.selectedId = id;
  updateLocation();
  renderCustomers();
  loadDetail();
}

/* Rendering */

// Who owes the most first, then by name
const BALANCES = { owing: 'owes', advance: 'credit', clear: 'clear' };

function searchMatches() {
  const q = normalizeArabic(latinDigits(els.search.value.trim()));
  const phone = /^[+\d\s()-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  return (customer) => (
    !q ||
    normalizeArabic(latinDigits(customer.name)).includes(q) ||
    (phone && latinDigits(customer.phone).replace(/\D/g, '').includes(phone))
  );
}

function filteredCustomers() {
  const matches = searchMatches();
  const balance = BALANCES[els.balanceFilter.value];
  const activity = els.activityFilter.value;
  const now = Date.now();
  return state.customers
    .filter((c) => matches(c) && (!balance || balanceClass(c.balance) === balance) && (!activity || debtActivity(c.lastActivity, now) === activity))
    .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, 'ar'));
}

function renderCustomers() {
  const list = filteredCustomers();
  for (const filter of [els.balanceFilter, els.activityFilter]) filter.classList.toggle('is-active', Boolean(filter.value));
  els.clearFilters.hidden = !(els.search.value || els.balanceFilter.value || els.activityFilter.value);
  renderList(list);
  if (!state.selectedId) renderOverview(list);
}

function renderList(list) {
  if (!list.length) {
    els.list.innerHTML = `<li class="rail-empty">${state.customers.length ? 'لا توجد نتائج مطابقة' : 'لا يوجد زبائن بعد'}</li>`;
    return;
  }
  els.list.innerHTML = list
    .map((c) => {
      const active = c._id === state.selectedId;
      return `<li class="rail-item${active ? ' is-active' : ''}">
        <button class="rail-link" type="button" data-select="${c._id}"${active ? ' aria-current="true"' : ''}>
          <span class="rail-name">${escapeHtml(c.name)}${c.phone ? `<small class="pcat num">${escapeHtml(c.phone)}</small>` : ''}</span>
          <span class="debt-chip ${balanceClass(c.balance)} num">${c.balance ? formatMoney(Math.abs(c.balance)) : '0'}</span>
        </button>
      </li>`;
    })
    .join('');
}

function renderOverview(customers) {
  const advance = els.balanceFilter.value === 'advance';
  const showTotal = els.balanceFilter.value !== 'clear' && customers.length > 0;
  const total = customers.reduce((sum, c) => sum + Math.max(advance ? -c.balance : c.balance, 0), 0);
  els.panel.innerHTML = `<div class="catalog-head">
      <div>
        <h1>الديون</h1>
        <span class="catalog-count">${customers.length ? arCount(customers.length, CUSTOMERS) : ''}</span>
      </div>
    </div>
    <div class="table-wrap">
      ${showTotal ? `<div class="debt-total">
        <div class="z-label">${advance ? 'مجموع الأرصدة المقدّمة' : 'مجموع الديون في النتائج'}</div>
        <div class="z-value num">${formatMoney(total)}</div>
      </div>` : ''}
      ${
        customers.length
          ? `<div class="table-scroll"><table class="ptable">
              <thead><tr>
                <th scope="col">الزبون</th>
                <th scope="col">الهاتف</th>
                <th scope="col">آخر حركة</th>
                <th scope="col" class="end">الرصيد</th>
              </tr></thead>
              <tbody>${customers
                .map(
                  (c) => `<tr>
                  <td class="cell-title"><button class="drill" type="button" data-select="${c._id}">${escapeHtml(c.name)}</button></td>
                  <td class="num" data-label="الهاتف">${escapeHtml(c.phone || '–')}</td>
                  <td data-label="آخر حركة">${c.lastActivity ? formatDateTime(c.lastActivity) : '–'}</td>
                  <td class="end" data-label="الرصيد"><span class="debt-chip ${balanceClass(c.balance)}">${balanceText(c.balance)}</span></td>
                </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : `<div class="empty">
              <h3>${state.customers.length ? 'لا توجد نتائج مطابقة' : 'أضف أول زبون'}</h3>
              ${state.customers.length ? '' : '<p>أضف زبونًا من زر «إضافة» أو عند البيع بالدين في الكاشير.</p>'}
            </div>`
      }
    </div>`;
}

function renderDetail() {
  const c = state.detail;
  const { kind, from, to } = state.entryFilters;
  els.panel.innerHTML = `<div class="catalog-head">
      <div>
        <button class="btn btn-sm btn-ghost debt-back" type="button" data-customer-overview>العودة إلى قائمة الزبائن</button>
        <h1>${escapeHtml(c.name)}</h1>
        <span class="catalog-count">${[c.phone && `<span class="num">${escapeHtml(c.phone)}</span>`, c.note && escapeHtml(c.note)].filter(Boolean).join('، ') || 'بدون هاتف'}</span>
      </div>
      <div class="catalog-tools">
        <button class="btn btn-go" type="button" data-entry="payment"${c.balance > 0 ? '' : ' disabled'}>تسديد</button>
        <button class="btn" type="button" data-entry="manual" data-need="owner">إضافة دين</button>
        <button class="btn btn-ghost" type="button" data-edit-customer>تعديل</button>
        <button class="btn btn-ghost danger" type="button" data-delete-customer data-need="owner">حذف</button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="debt-total">
        <div class="z-label">الرصيد</div>
        <div class="z-value ${balanceClass(c.balance)}-text">${balanceText(c.balance)}</div>
      </div>
      <div class="section-head"><h2>كشف الحساب</h2><span class="catalog-count" id="customerEntryCount" aria-live="polite"></span></div>
      <div class="catalog-filters debt-entry-filters" role="group" aria-label="فلترة كشف الحساب"${c.entries.length ? '' : ' hidden'}>
        <label class="filter-field">
          <span>نوع الحركة</span>
          <select class="input" id="customerEntryKind" data-entry-filter="kind">
            <option value="">كل الحركات</option>
            <option value="sale"${kind === 'sale' ? ' selected' : ''}>شراء بالدين</option>
            <option value="payment"${kind === 'payment' ? ' selected' : ''}>تسديد</option>
            <option value="manual"${kind === 'manual' ? ' selected' : ''}>دين مضاف</option>
            <option value="return"${kind === 'return' ? ' selected' : ''}>إرجاع</option>
          </select>
        </label>
        <label class="filter-field">
          <span>من تاريخ</span>
          <input class="input" type="date" data-entry-filter="from" value="${escapeHtml(from)}">
        </label>
        <label class="filter-field">
          <span>إلى تاريخ</span>
          <input class="input" type="date" data-entry-filter="to" value="${escapeHtml(to)}">
        </label>
        <button class="btn btn-sm" type="button" data-clear-entry-filters>مسح الفلاتر</button>
      </div>
      <div id="customerEntries"></div>
    </div>`;
  renderEntries();
}

function renderEntries() {
  const { kind, from, to } = state.entryFilters;
  const { entries } = state.detail;
  const area = $('customerEntries');
  const count = $('customerEntryCount');
  for (const filter of els.panel.querySelectorAll('[data-entry-filter]')) filter.classList.toggle('is-active', Boolean(filter.value));
  els.panel.querySelector('[data-clear-entry-filters]').disabled = !(kind || from || to);
  if (from && to && from > to) {
    count.textContent = '';
    area.innerHTML = '<p class="form-error" role="alert">اختر تاريخ نهاية يساوي تاريخ البداية أو يأتي بعده.</p>';
    return;
  }

  let running = 0;
  const rows = [];
  for (const entry of entries) {
    running = roundMoney(running + entry.amount);
    if (kind && entry.kind !== kind) continue;
    if (from || to) {
      const date = dayKey(new Date(entry.date));
      if ((from && date < from) || (to && date > to)) continue;
    }
    rows.push({ ...entry, after: running });
  }
  count.textContent = kind || from || to ? `عرض ${rows.length} من ${entries.length}` : '';
  if (!rows.length) {
    area.innerHTML = entries.length
      ? '<div class="empty"><h3>لا توجد حركات مطابقة</h3></div>'
      : '<div class="empty"><h3>لا توجد سجلات بعد</h3><p>البيع بالدين من الكاشير يُسجَّل هنا تلقائيًا<span data-need="owner">، أو أضف دينًا سابقًا من زر «إضافة دين»</span>.</p></div>';
    return;
  }

  area.innerHTML = `<div class="table-scroll"><table class="ptable ledger">
              <thead><tr>
                <th scope="col">التاريخ</th>
                <th scope="col">البيان</th>
                <th scope="col" class="end">المبلغ</th>
                <th scope="col" class="end">الرصيد بعده</th>
                <th scope="col"><span class="sr-only">إجراءات</span></th>
              </tr></thead>
              <tbody>${rows
                .reverse()
                .map(
                  (e) => `<tr>
                  <td data-label="التاريخ">${formatDateTime(e.date)}</td>
                  <td class="cell-title">${ENTRY_LABELS[e.kind](e)}${e.note ? `<small class="pcat">${escapeHtml(e.note)}</small>` : ''}${
                    e.madeBy?.name ? `<small class="pcat">بواسطة ${escapeHtml(e.madeBy.name)}</small>` : ''
                  }</td>
                  <td class="end num ${e.amount > 0 ? 'owes-text' : 'credit-text'}" data-label="المبلغ">${e.amount > 0 ? '+' : '−'}${formatMoney(Math.abs(e.amount))}</td>
                  <td class="end num" data-label="الرصيد بعده">${formatMoney(e.after)}</td>
                  <td class="row-actions">${
                    e.kind === 'payment' || e.kind === 'manual'
                      ? `<button class="btn btn-sm btn-ghost danger" type="button" data-delete-entry="${e._id}" data-need="owner">حذف</button>`
                      : ''
                  }</td>
                </tr>`,
                )
                .join('')}</tbody>
            </table></div>`;
}

/* Customer dialog */

function openCustomerDialog(customer = null) {
  state.editingCustomer = customer;
  els.customerTitle.textContent = customer ? 'تعديل بيانات الزبون' : 'زبون جديد';
  els.cName.value = customer?.name ?? els.search.value.trim();
  els.cPhone.value = customer?.phone ?? '';
  els.cNote.value = customer?.note ?? '';
  els.customerError.hidden = true;
  els.customerDialog.showModal();
  els.cName.focus();
}

els.customerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: els.cName.value.trim(), phone: els.cPhone.value.trim(), note: els.cNote.value.trim() };
  if (!body.name) {
    els.customerError.textContent = 'اكتب اسم الزبون';
    els.customerError.hidden = false;
    els.cName.focus();
    return;
  }
  try {
    const editing = state.editingCustomer;
    const saved = editing
      ? await api(`/customers/${editing._id}`, { method: 'PUT', body })
      : await api('/customers', { method: 'POST', body });
    els.customerDialog.close();
    toast(editing ? 'تم حفظ بيانات الزبون' : `تمت إضافة ${body.name}`);
    els.search.value = '';
    select(saved._id);
    await loadCustomers();
  } catch (err) {
    els.customerError.textContent = err.message;
    els.customerError.hidden = false;
  }
});

/* Payment / debt dialog */

function openEntryDialog(kind) {
  const c = state.detail;
  state.entryKind = kind;
  const paying = kind === 'payment';
  els.entryTitle.textContent = paying ? `تسديد من ${c.name}` : `إضافة دين على ${c.name}`;
  els.entryHint.textContent = paying
    ? `${balanceText(c.balance)}. اكتب المبلغ الذي دفعه الآن.`
    : 'مثل دين سابق قبل استخدام النظام، أو مبلغ أخذه نقدًا.';
  els.fullAmount.hidden = !paying || c.balance <= 0;
  els.entrySubmit.textContent = paying ? 'تسجيل التسديد' : 'إضافة الدين';
  els.amount.value = '';
  els.note.value = '';
  els.date.value = dayKey(new Date());
  els.date.max = dayKey(new Date());
  els.entryError.hidden = true;
  els.entryDialog.showModal();
  els.amount.focus();
}

els.fullAmount.addEventListener('click', () => {
  els.amount.value = state.detail.balance;
  els.amount.focus();
});

els.entryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number(els.amount.value);
  const showError = (message) => {
    els.entryError.textContent = message;
    els.entryError.hidden = false;
  };
  if (!(amount > 0)) {
    showError('أدخل مبلغًا أكبر من صفر');
    els.amount.focus();
    return;
  }
  const c = state.detail;
  const paying = state.entryKind === 'payment';
  if (paying && amount > c.balance && !confirm(`المبلغ أكبر من الدين (${formatMoney(c.balance)}). سيصبح للزبون رصيد ${formatMoney(amount - c.balance)}. متابعة؟`)) {
    return;
  }
  // Today keeps the current time so it sorts after today's sales; another day sits at noon
  const key = els.date.value || dayKey(new Date());
  const date = key === dayKey(new Date()) ? new Date() : new Date(parseKey(key).setHours(12));
  els.entrySubmit.disabled = true;
  try {
    const { balance } = await api(`/customers/${c._id}/entries`, {
      method: 'POST',
      body: { kind: state.entryKind, amount, note: els.note.value.trim(), date: date.toISOString() },
    });
    els.entryDialog.close();
    toast(`${paying ? 'تم تسجيل التسديد' : 'تمت إضافة الدين'}. ${balanceText(balance)}`);
    await refresh();
  } catch (err) {
    showError(err.message);
  } finally {
    els.entrySubmit.disabled = false;
  }
});

/* Interactions */

document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

els.add.addEventListener('click', () => openCustomerDialog());
els.search.addEventListener('input', renderCustomers);
for (const filter of [els.balanceFilter, els.activityFilter]) {
  filter.addEventListener('change', () => select(null));
}
els.clearFilters.addEventListener('click', () => {
  els.search.value = '';
  els.balanceFilter.value = '';
  els.activityFilter.value = '';
  select(null);
  els.search.focus();
});
els.search.addEventListener('keydown', (e) => {
  // Enter opens the only match, or offers to add the typed name
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const matches = filteredCustomers();
  if (matches.length === 1) select(matches[0]._id);
  else if (!matches.length && els.search.value.trim() && !state.customers.some(searchMatches())) openCustomerDialog();
});

els.panel.addEventListener('change', (e) => {
  const key = e.target.dataset.entryFilter;
  if (!key) return;
  state.entryFilters[key] = e.target.value;
  renderEntries();
});

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-customer-overview]')) {
    select(null);
    return;
  }
  if (e.target.closest('[data-clear-entry-filters]')) {
    state.entryFilters = emptyEntryFilters();
    for (const field of els.panel.querySelectorAll('[data-entry-filter]')) field.value = '';
    renderEntries();
    $('customerEntryKind').focus();
    return;
  }
  const pick = e.target.closest('[data-select]');
  if (pick) {
    select(pick.dataset.select);
    return;
  }
  const entry = e.target.closest('[data-entry]');
  if (entry) {
    openEntryDialog(entry.dataset.entry);
    return;
  }
  if (e.target.closest('[data-edit-customer]')) {
    openCustomerDialog(state.detail);
    return;
  }
  if (e.target.closest('[data-delete-customer]')) {
    const c = state.detail;
    if (c.entries.length) {
      toast('لا يمكن حذف زبون له سجلات دين', 'error');
      return;
    }
    if (!confirm(`حذف الزبون «${c.name}»؟`)) return;
    try {
      await api(`/customers/${c._id}`, { method: 'DELETE' });
      toast(`تم حذف ${c.name}`);
      select(null);
      await loadCustomers();
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }
  const removeEntry = e.target.closest('[data-delete-entry]');
  if (removeEntry) {
    const item = state.detail.entries.find((x) => x._id === removeEntry.dataset.deleteEntry);
    const what = item.kind === 'payment' ? 'التسديد' : 'الدين المضاف';
    if (!confirm(`حذف ${what} بمبلغ ${formatMoney(Math.abs(item.amount))}؟`)) return;
    try {
      const { balance } = await api(`/customers/${state.detail._id}/entries/${item._id}`, { method: 'DELETE' });
      toast(`تم الحذف. ${balanceText(balance)}`);
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

const query = new URLSearchParams(location.search);
state.selectedId = query.get('customer');
for (const [control, key] of [[els.balanceFilter, 'balance'], [els.activityFilter, 'activity']]) {
  const value = query.get(key);
  if ([...control.options].some((option) => option.value === value)) control.value = value;
}
refresh();
