import { api, toast, formatMoney, formatDateTime, escapeHtml, arCount, normalizeArabic, dayKey, parseKey } from './common.js';

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

const state = { customers: [], selectedId: null, detail: null, editingCustomer: null, entryKind: null };

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
  renderList();
}

async function loadDetail() {
  if (!state.selectedId) {
    state.detail = null;
    renderOverview();
    return;
  }
  try {
    state.detail = await api(`/customers/${state.selectedId}`);
    renderDetail();
  } catch (err) {
    toast(err.message, 'error');
    state.selectedId = null;
    renderOverview();
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

function select(id) {
  state.selectedId = id;
  history.replaceState(null, '', id ? `?customer=${id}` : location.pathname);
  renderList();
  loadDetail();
}

/* Rendering */

// Who owes the most first, then by name
const sortedCustomers = () =>
  [...state.customers].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, 'ar'));

function renderList() {
  const q = normalizeArabic(els.search.value.trim());
  const list = sortedCustomers().filter(
    (c) => !q || normalizeArabic(c.name).includes(q) || (c.phone ?? '').includes(q),
  );
  if (!list.length) {
    els.list.innerHTML = `<li class="rail-empty">${state.customers.length ? 'لا يوجد زبون بهذا الاسم' : 'لا يوجد زبائن بعد'}</li>`;
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

function renderOverview() {
  const debtors = sortedCustomers().filter((c) => c.balance > 0);
  const total = debtors.reduce((sum, c) => sum + c.balance, 0);
  els.panel.innerHTML = `<div class="catalog-head">
      <div>
        <h1>الديون</h1>
        <span class="catalog-count">${state.customers.length ? arCount(state.customers.length, CUSTOMERS) : ''}</span>
      </div>
    </div>
    <div class="table-wrap">
      <div class="debt-total">
        <div class="z-label">مجموع الديون على الزبائن</div>
        <div class="z-value num">${formatMoney(total)}</div>
        <div class="z-note">${debtors.length ? `على ${arCount(debtors.length, CUSTOMERS)}` : 'لا توجد ديون حاليًا'}</div>
      </div>
      ${
        debtors.length
          ? `<div class="table-scroll"><table class="ptable">
              <thead><tr>
                <th scope="col">الزبون</th>
                <th scope="col">الهاتف</th>
                <th scope="col">آخر حركة</th>
                <th scope="col" class="end">عليه</th>
              </tr></thead>
              <tbody>${debtors
                .map(
                  (c) => `<tr>
                  <td><button class="drill" type="button" data-select="${c._id}">${escapeHtml(c.name)}</button></td>
                  <td class="num">${escapeHtml(c.phone || '–')}</td>
                  <td>${c.lastActivity ? formatDateTime(c.lastActivity) : '–'}</td>
                  <td class="end num owes-text">${formatMoney(c.balance)}</td>
                </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : `<div class="empty">
              <h3>${state.customers.length ? 'كل الزبائن بلا ديون' : 'أضف أول زبون'}</h3>
              <p>أضف الزبائن من زر «إضافة»، أو اكتب اسم الزبون في الكاشير عند البيع بالدين فيُضاف تلقائيًا.</p>
            </div>`
      }
    </div>`;
}

function renderDetail() {
  const c = state.detail;
  // Running balance from the oldest entry, shown newest first
  let running = 0;
  const rows = c.entries.map((e) => {
    running += e.amount;
    return { ...e, after: running };
  });
  els.panel.innerHTML = `<div class="catalog-head">
      <div>
        <h1>${escapeHtml(c.name)}</h1>
        <span class="catalog-count">${[c.phone && `<span class="num">${escapeHtml(c.phone)}</span>`, c.note && escapeHtml(c.note)].filter(Boolean).join('، ') || 'بدون هاتف'}</span>
      </div>
      <div class="catalog-tools">
        <button class="btn btn-go" type="button" data-entry="payment"${c.balance > 0 ? '' : ' disabled'}>تسديد</button>
        <button class="btn" type="button" data-entry="manual">إضافة دين</button>
        <button class="btn btn-ghost" type="button" data-edit-customer>تعديل</button>
        <button class="btn btn-ghost danger" type="button" data-delete-customer>حذف</button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="debt-total">
        <div class="z-label">الرصيد</div>
        <div class="z-value num ${balanceClass(c.balance)}-text">${balanceText(c.balance)}</div>
      </div>
      ${
        rows.length
          ? `<div class="section-head"><h2>كشف الحساب</h2></div>
            <div class="table-scroll"><table class="ptable ledger">
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
                  <td>${formatDateTime(e.date)}</td>
                  <td>${ENTRY_LABELS[e.kind](e)}${e.note ? `<small class="pcat">${escapeHtml(e.note)}</small>` : ''}</td>
                  <td class="end num ${e.amount > 0 ? 'owes-text' : 'credit-text'}">${e.amount > 0 ? '+' : '−'}${formatMoney(Math.abs(e.amount))}</td>
                  <td class="end num">${formatMoney(e.after)}</td>
                  <td class="row-actions">${
                    e.kind === 'payment' || e.kind === 'manual'
                      ? `<button class="btn btn-sm btn-ghost danger" type="button" data-delete-entry="${e._id}">حذف</button>`
                      : ''
                  }</td>
                </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : `<div class="empty"><h3>لا توجد سجلات بعد</h3><p>البيع بالدين من الكاشير يُسجَّل هنا تلقائيًا، أو أضف دينًا سابقًا من زر «إضافة دين».</p></div>`
      }
    </div>`;
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
    state.selectedId = saved._id;
    history.replaceState(null, '', `?customer=${saved._id}`);
    await refresh();
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
els.search.addEventListener('input', renderList);
els.search.addEventListener('keydown', (e) => {
  // Enter opens the only match, or offers to add the typed name
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const matches = els.list.querySelectorAll('[data-select]');
  if (matches.length === 1) select(matches[0].dataset.select);
  else if (!matches.length && els.search.value.trim()) openCustomerDialog();
});

document.addEventListener('click', async (e) => {
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

state.selectedId = new URLSearchParams(location.search).get('customer');
refresh();
