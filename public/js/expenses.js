import {
  api,
  toast,
  formatMoney,
  escapeHtml,
  arCount,
  dayKey,
  monthKey,
  parseKey,
  addMonths,
  EXPENSES,
} from './common.js';

const DEFAULT_TYPES = ['طعام', 'إيجار', 'كهرباء', 'ماء', 'رواتب', 'نقل', 'صيانة', 'إنترنت', 'أخرى'];
const LOCALE = 'ar-u-nu-latn';
const rowDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const monthName = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });

const $ = (id) => document.getElementById(id);
const els = {
  form: $('expenseForm'),
  formTitle: $('formTitle'),
  date: $('eDate'),
  category: $('eCategory'),
  amount: $('eAmount'),
  note: $('eNote'),
  types: $('expenseTypes'),
  error: $('expenseError'),
  submit: $('expenseSubmit'),
  cancelEdit: $('cancelEdit'),
  month: $('monthInput'),
  prevMonth: $('prevMonth'),
  nextMonth: $('nextMonth'),
  thisMonth: $('thisMonthBtn'),
  title: $('periodTitle'),
  summary: $('expenseSummary'),
  area: $('expensesArea'),
};

let expenses = [];
let editingId = null;
let request = 0;

// Noon of the chosen day sits safely inside that day in this time zone
function dayToIso(key) {
  const d = parseKey(key);
  d.setHours(12);
  return d.toISOString();
}

/* Loading */

async function loadTypes() {
  try {
    const used = await api('/expenses/categories');
    els.types.innerHTML = [...new Set([...used, ...DEFAULT_TYPES])]
      .map((type) => `<option value="${escapeHtml(type)}"></option>`)
      .join('');
  } catch {
    // Suggestions only; typing any type still works
  }
}

async function load() {
  const from = parseKey(els.month.value);
  const current = ++request;
  els.title.textContent = monthName.format(from);
  els.month.max = monthKey(new Date());
  els.nextMonth.disabled = els.month.value >= monthKey(new Date());
  try {
    const query = new URLSearchParams({ from: from.toISOString(), to: addMonths(from, 1).toISOString() });
    const data = await api(`/expenses?${query}`);
    if (current !== request) return;
    expenses = data.expenses;
    renderSummary(data);
    renderList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* Rendering */

function renderSummary({ total, byCategory }) {
  if (!expenses.length) {
    els.summary.innerHTML = '';
    return;
  }
  els.summary.innerHTML = `<div class="table-scroll"><table class="ptable keep-table breakdown">
      <thead><tr>
        <th scope="col">النوع</th>
        <th scope="col" class="end">المبلغ</th>
        <th scope="col" class="end">من المجموع</th>
      </tr></thead>
      <tbody>${byCategory
        .map(
          (c) => `<tr>
          <td>${escapeHtml(c.category)} <small class="pcat">${arCount(c.count, EXPENSES)}</small></td>
          <td class="end"><span class="num">${formatMoney(c.total)}</span></td>
          <td class="end"><span class="num">${total > 0 ? `${Math.round((c.total / total) * 100)}%` : "—"}</span></td>
        </tr>`,
        )
        .join('')}</tbody>
      <tfoot><tr>
        <td>مصاريف الشهر <small class="pcat">${arCount(expenses.length, EXPENSES)}</small></td>
        <td class="end"><span class="num">${formatMoney(total)}</span></td>
        <td class="end"><span class="num">100%</span></td>
      </tr></tfoot>
    </table></div>
    <p class="hint">تُطرح المصاريف من صافي الربح في صفحة المبيعات وفي الملخص.</p>`;
}

function renderList() {
  if (!expenses.length) {
    els.area.innerHTML = `<div class="empty">
      <h3>لا توجد مصاريف في هذا الشهر</h3>
      <p>سجّل أي مبلغ يُصرف من المحل، مثل الطعام أو الإيجار أو الكهرباء، من النموذج في الأعلى.</p>
    </div>`;
    return;
  }
  els.area.innerHTML = `<div class="section-head"><h2>كل المصاريف</h2></div>
  <div class="table-scroll"><table class="ptable">
    <thead><tr>
      <th scope="col">التاريخ</th>
      <th scope="col">النوع</th>
      <th scope="col">ملاحظة</th>
      <th scope="col" class="end">المبلغ</th>
      <th scope="col"><span class="sr-only">إجراءات</span></th>
    </tr></thead>
    <tbody>${expenses
      .map(
        (e) => `<tr${e._id === editingId ? ' class="is-editing"' : ''}>
        <td>${rowDay.format(new Date(e.date))}</td>
        <td class="pname">${escapeHtml(e.category)}</td>
        <td class="pcat">${escapeHtml(e.note || '–')}</td>
        <td class="end num">${formatMoney(e.amount)}</td>
        <td class="row-actions">
          <button class="btn btn-sm" type="button" data-edit="${e._id}">تعديل</button>
          <button class="btn btn-sm btn-ghost danger" type="button" data-delete="${e._id}">حذف</button>
        </td>
      </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

/* Form */

function clearError() {
  els.error.hidden = true;
  [els.date, els.category, els.amount].forEach((input) => input.classList.remove('is-invalid'));
}

function showError(message, input) {
  els.error.textContent = message;
  els.error.hidden = false;
  if (input) {
    input.classList.add('is-invalid');
    input.focus();
  }
}

// Ready for the next expense; the date stays, since several are often entered for one day
function resetForm() {
  const date = els.date.value;
  editingId = null;
  els.form.reset();
  els.date.value = date || dayKey(new Date());
  els.formTitle.textContent = 'مصروف جديد';
  els.submit.textContent = 'إضافة المصروف';
  els.cancelEdit.hidden = true;
  clearError();
}

function startEdit(expense) {
  editingId = expense._id;
  els.date.value = dayKey(new Date(expense.date));
  els.category.value = expense.category;
  els.amount.value = expense.amount;
  els.note.value = expense.note ?? '';
  els.formTitle.textContent = 'تعديل مصروف';
  els.submit.textContent = 'حفظ التعديل';
  els.cancelEdit.hidden = false;
  clearError();
  renderList();
  els.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  els.amount.focus();
}

els.form.addEventListener('input', (e) => e.target.classList?.remove('is-invalid'));

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const date = els.date.value;
  const category = els.category.value.trim();
  const amount = els.amount.value.trim() === '' ? NaN : Number(els.amount.value);
  if (!date) return showError('اختر تاريخ المصروف', els.date);
  if (!category) return showError('اكتب نوع المصروف، مثل: طعام', els.category);
  if (!(amount > 0)) return showError('أدخل مبلغًا أكبر من صفر', els.amount);

  const body = { date: dayToIso(date), category, amount, note: els.note.value.trim() };
  const editing = editingId;
  els.submit.disabled = true;
  try {
    if (editing) await api(`/expenses/${editing}`, { method: 'PUT', body });
    else await api('/expenses', { method: 'POST', body });
    toast(editing ? 'تم حفظ التعديل' : `تمت إضافة المصروف: ${category} ${formatMoney(amount)}`);
    els.month.value = date.slice(0, 7); // show the month it belongs to
    resetForm();
    els.category.focus();
    await Promise.all([load(), loadTypes()]);
  } catch (err) {
    showError(err.message);
  } finally {
    els.submit.disabled = false;
  }
});

els.cancelEdit.addEventListener('click', () => {
  resetForm();
  renderList();
});

els.area.addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    startEdit(expenses.find((x) => x._id === edit.dataset.edit));
    return;
  }
  const remove = e.target.closest('[data-delete]');
  if (!remove) return;
  const expense = expenses.find((x) => x._id === remove.dataset.delete);
  if (!confirm(`حذف مصروف «${expense.category}» بمبلغ ${formatMoney(expense.amount)}؟`)) return;
  try {
    await api(`/expenses/${expense._id}`, { method: 'DELETE' });
    if (editingId === expense._id) resetForm();
    toast('تم حذف المصروف');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* Month */

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

// The sales page links here with ?month=YYYY-MM
const requested = new URLSearchParams(location.search).get('month');
els.month.value = /^\d{4}-\d{2}$/.test(requested ?? '') ? requested : monthKey(new Date());
els.date.value = dayKey(new Date());
loadTypes();
load();
