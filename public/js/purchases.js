import {
  api,
  toast,
  formatMoney,
  formatQty,
  formatWeight,
  escapeHtml,
  arCount,
  roundMoney,
  roundTo,
  roundQty,
  normalizeArabic,
  dayKey,
  monthKey,
  parseKey,
  addMonths,
  packName,
  newClientId,
  withSignIn,
} from './common.js';
import { scanBarcodes } from './scanner.js';

const LOCALE = 'ar-u-nu-latn';
const monthName = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
const dayName = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
// On touch screens, moving the focus around would keep popping up the keyboard
const finePointer = matchMedia('(pointer: fine)').matches;
const DRAFT_KEY = 'purchaseDraft';
const ITEMS = { one: 'صنف واحد', two: 'صنفان', few: 'أصناف', many: 'صنفًا', single: 'صنف' };
// After "في": "في فاتورتين"
const INVOICES_IN = { one: 'فاتورة واحدة', two: 'فاتورتين', few: 'فواتير', many: 'فاتورة', single: 'فاتورة' };

const state = {
  purchases: [],
  suppliers: [],
  products: [],
  // The invoice being entered: { lines, payMode: full | part | credit }
  draft: null,
  detail: null,
};
let lineSeq = 0;
let listRequest = 0;

const $ = (id) => document.getElementById(id);
const els = {
  listView: $('listView'),
  draftBanner: $('draftBanner'),
  month: $('monthInput'),
  prevMonth: $('prevMonth'),
  nextMonth: $('nextMonth'),
  thisMonth: $('thisMonthBtn'),
  title: $('periodTitle'),
  summary: $('purchaseSummary'),
  suppliersArea: $('suppliersArea'),
  area: $('purchasesArea'),
  composer: $('composer'),
  discard: $('discardBtn'),
  supplier: $('pSupplier'),
  supplierSuggest: $('supplierSuggest'),
  supplierNote: $('supplierNote'),
  date: $('pDate'),
  reference: $('pReference'),
  scan: $('pScan'),
  camera: $('pCamera'),
  productSuggest: $('productSuggest'),
  lines: $('purchaseLines'),
  count: $('pCount'),
  total: $('pTotal'),
  payButtons: document.querySelectorAll('[data-pay]'),
  paidField: $('paidField'),
  paid: $('pPaid'),
  remaining: $('pRemaining'),
  note: $('pNote'),
  error: $('purchaseError'),
  save: $('saveBtn'),
  detailDialog: $('detailDialog'),
  detailBody: $('detailBody'),
  detailActions: $('detailActions'),
  payForm: $('payForm'),
  payAmount: $('payAmount'),
  payAll: $('payAllBtn'),
  payDate: $('payDate'),
  payError: $('payError'),
};

/* Helpers */

const num = (value) => (String(value ?? '').trim() === '' ? NaN : Number(value));
const unitOf = (p) => p.unit ?? 'piece';
const hasPack = (p) => Boolean(p.hasWholesale && p.wholesaleQty > 0);
const packSizeOf = (line) => (line.mode === 'pack' ? line.product.wholesaleQty : 1);
const qtyIn = (qty, unit) => (unit === 'kg' ? formatWeight(qty) : formatQty(qty));
// "للعلبة", "للقطعة", "للكيلو", "للكيس"
const perWord = (unit, mode) => (mode === 'pack' ? (unit === 'kg' ? 'للكيس' : 'للعلبة') : unit === 'kg' ? 'للكيلو' : 'للقطعة');
const inThe = (unit) => (unit === 'kg' ? 'في الكيلو' : 'في القطعة');

// "3 × علبة (24 قطعة)", "12", "2.5 كغم"
function boughtLabel({ unit, mode, packSize, quantity }) {
  if (mode === 'pack') return `${formatQty(quantity)} × ${packName(unit, packSize)}`;
  return qtyIn(quantity, unit);
}

// Today keeps the time, so invoices of one day stay in the order they were entered;
// another day is stored at its noon, safely inside it in this time zone
function dayToIso(key) {
  if (key === dayKey(new Date())) return new Date().toISOString();
  const d = parseKey(key);
  d.setHours(12);
  return d.toISOString();
}

// Like the server: the quantity to the gram and the price to the cent, then the total
function lineCalc(line) {
  const packSize = packSizeOf(line);
  const qty = roundQty(num(line.quantity));
  const price = roundMoney(num(line.price));
  const valid = Number.isFinite(qty) && qty > 0 && Number.isFinite(price) && price >= 0;
  return {
    packSize,
    qty,
    price,
    total: valid ? roundMoney(qty * price) : 0,
    stockQty: Number.isFinite(qty) && qty > 0 ? roundQty(qty * packSize) : 0,
    // Not rounded to the cent: a box price shared over its pieces must add back up
    unitCost: Number.isFinite(price) ? roundTo(price / packSize, 6) : NaN,
  };
}

const draftTotal = () => roundMoney(state.draft.lines.reduce((sum, line) => sum + lineCalc(line).total, 0));

/* Suggestion lists (a <datalist> barely works on Android) */

function combo({ input, list, items, label, onPick }) {
  let matches = [];
  let active = -1;
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    matches = items(input.value.trim());
    active = -1;
    list.hidden = !matches.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    input.removeAttribute('aria-activedescendant');
    list.innerHTML = matches
      .map(
        (m, i) => `<li role="option" id="${list.id}-${i}">
          <button type="button" class="combo-option" data-index="${i}" tabindex="-1">${label(m)}</button>
        </li>`,
      )
      .join('');
  };
  const highlight = (index) => {
    active = index;
    list.querySelectorAll('.combo-option').forEach((b, i) => b.classList.toggle('is-active', i === index));
    input.setAttribute('aria-activedescendant', `${list.id}-${index}`);
    list.children[index]?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (index) => {
    const match = matches[index];
    close();
    onPick(match);
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  // Let a tap on a suggestion land before the list closes
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const option = e.target.closest('[data-index]');
    if (option) pick(Number(option.dataset.index));
  });
  input.addEventListener('keydown', (e) => {
    const open = !list.hidden && matches.length > 0;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      highlight((active + step + matches.length) % matches.length);
    } else if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(active);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close();
    }
  });
  return { render, close, first: () => matches[0] };
}

/* Invoice list */

async function loadList() {
  const from = parseKey(els.month.value);
  const current = ++listRequest;
  els.title.textContent = monthName.format(from);
  els.month.max = monthKey(new Date());
  els.nextMonth.disabled = els.month.value >= monthKey(new Date());
  try {
    const query = new URLSearchParams({ from: from.toISOString(), to: addMonths(from, 1).toISOString() });
    const [data, suppliers] = await Promise.all([api(`/purchases?${query}`), api('/purchases/suppliers')]);
    if (current !== listRequest) return;
    state.purchases = data.purchases;
    state.suppliers = suppliers;
    renderSummary(data);
    renderSuppliers(data.owedToSuppliers);
    renderList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderDraftBanner() {
  const draft = readDraft();
  els.draftBanner.innerHTML = draft?.lines?.length
    ? `<div class="draft-banner">
        <span>لديك فاتورة شراء لم تُحفظ بعد (${arCount(draft.lines.length, ITEMS)}).</span>
        <a class="btn btn-sm btn-primary" href="#new">متابعتها</a>
      </div>`
    : '';
}

// One line for the month; the shop's figures as a whole are on the summary page
function renderSummary(data) {
  els.summary.hidden = !data.count;
  els.summary.innerHTML = `مشتريات الشهر <strong class="num">${formatMoney(data.total)}</strong>
    في ${arCount(data.count, INVOICES_IN)}، دُفع منها <span class="num">${formatMoney(data.paid)}</span>.`;
}

// The total is the server's figure over all invoices, the same one the summary shows;
// invoices entered without a supplier's name get a row of their own
function renderSuppliers(total) {
  const owed = state.suppliers
    .filter((s) => s.owed > 0)
    .sort((a, b) => b.owed - a.owed)
    .map((s) => ({ name: escapeHtml(s.name), owed: s.owed }));
  const unnamed = roundMoney(total - owed.reduce((sum, s) => sum + s.owed, 0));
  if (unnamed > 0) owed.push({ name: '<span class="muted">بدون اسم مورد</span>', owed: unnamed });
  els.suppliersArea.innerHTML = total > 0
    ? `<div class="section-head"><h2>عليك للموردين <span class="num loss">${formatMoney(total)}</span></h2></div>
      <table class="ptable keep-table supplier-debts">
        <thead><tr><th scope="col">المورد</th><th scope="col" class="end">المتبقي عليك</th></tr></thead>
        <tbody>${owed
          .map((s) => `<tr><td class="pname">${s.name}</td><td class="end"><span class="num loss">${formatMoney(s.owed)}</span></td></tr>`)
          .join('')}</tbody>
      </table>`
    : '';
}

function statusBadge(p) {
  if (p.status === 'cancelled') return '<span class="badge is-cancelled">ملغاة</span>';
  if (p.remaining > 0) return `<span class="badge is-partial">${p.paid > 0 ? 'مدفوعة جزئيًا' : 'آجلة'}</span>`;
  return '';
}

function renderList() {
  if (!state.purchases.length) {
    els.area.innerHTML = `<div class="empty">
      <h3>لا توجد مشتريات في هذا الشهر</h3>
      <p>عند وصول بضاعة من المورد أدخل فاتورتها هنا، فتُضاف الكميات إلى المخزن ويُسجَّل ما بقي عليك للمورد.</p>
      <a class="btn btn-primary" href="#new">فاتورة شراء جديدة</a>
    </div>`;
    return;
  }
  els.area.innerHTML = `<div class="section-head"><h2>فواتير الشراء</h2></div>
  <table class="ptable purchases-table">
    <thead><tr>
      <th scope="col">الرقم</th>
      <th scope="col">التاريخ</th>
      <th scope="col">المورد</th>
      <th scope="col" class="end">الأصناف</th>
      <th scope="col" class="end">الإجمالي</th>
      <th scope="col" class="end">المتبقي</th>
      <th scope="col"><span class="sr-only">تفاصيل</span></th>
    </tr></thead>
    <tbody>${state.purchases
      .map(
        (p) => `<tr class="${p.status === 'cancelled' ? 'is-cancelled' : ''}">
        <td><span class="invoice-no num">${p.number}</span>${statusBadge(p)}</td>
        <td>${dayName.format(new Date(p.date))}</td>
        <td>${p.supplier ? escapeHtml(p.supplier) : '<span class="muted">—</span>'}</td>
        <td class="end"><span class="num">${p.items.length}</span></td>
        <td class="end"><span class="num">${formatMoney(p.total)}</span></td>
        <td class="end">${p.remaining ? `<span class="num loss">${formatMoney(p.remaining)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="row-actions"><button class="btn btn-sm" type="button" data-detail="${p._id}">التفاصيل</button></td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

els.area.addEventListener('click', (e) => {
  const detail = e.target.closest('[data-detail]');
  if (detail) showDetail(detail.dataset.detail);
});

els.month.addEventListener('change', () => els.month.value && loadList());
els.prevMonth.addEventListener('click', () => {
  els.month.value = monthKey(addMonths(parseKey(els.month.value), -1));
  loadList();
});
els.nextMonth.addEventListener('click', () => {
  els.month.value = monthKey(addMonths(parseKey(els.month.value), 1));
  loadList();
});
els.thisMonth.addEventListener('click', () => {
  els.month.value = monthKey(new Date());
  loadList();
});

/* One invoice: details, payments, cancelling */

async function showDetail(id) {
  try {
    state.detail = await api(`/purchases/${id}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  renderDetail();
  els.payForm.hidden = true;
  if (!els.detailDialog.open) els.detailDialog.showModal();
}

function renderDetail() {
  const p = state.detail;
  const cancelled = p.status === 'cancelled';
  const meta = [`<span>${dayName.format(new Date(p.date))}</span>`];
  if (p.supplier) meta.push(`<span>${escapeHtml(p.supplier)}</span>`);
  if (p.reference) meta.push(`<span>فاتورة المورد <span class="num">${escapeHtml(p.reference)}</span></span>`);
  els.detailBody.innerHTML = `<h2 id="detailTitle">فاتورة شراء رقم <span class="num">${p.number}</span> ${statusBadge(p)}</h2>
    <p class="count-meta">${meta.join('')}</p>
    ${cancelled ? `<p class="form-error">أُلغيت هذه الفاتورة وأُخرجت كمياتها من المخزن. ما دُفع للمورد (${formatMoney(p.paid)}) يُسترد منه مباشرة.</p>` : ''}
    <table class="ptable">
      <thead><tr>
        <th scope="col">المنتج</th>
        <th scope="col">الكمية</th>
        <th scope="col" class="end">السعر</th>
        <th scope="col" class="end">الإجمالي</th>
      </tr></thead>
      <tbody>${p.items
        .map(
          (i) => `<tr>
          <td><div class="pname">${escapeHtml(i.name)}</div>${
            i.startedTracking ? '<div class="pcat">بدأت متابعة كميته من هذه الفاتورة</div>' : ''
          }</td>
          <td><span>${boughtLabel(i)}</span>${
            i.mode === 'pack' ? `<small class="pct">دخل المخزن ${qtyIn(i.stockQty, i.unit)}</small>` : ''
          }</td>
          <td class="end"><span class="num">${formatMoney(i.price)}</span><small class="pct">${perWord(i.unit, i.mode)}</small></td>
          <td class="end"><span class="num">${formatMoney(i.total)}</span></td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>
    <dl class="purchase-totals">
      <div><dt>الإجمالي</dt><dd class="num">${formatMoney(p.total)}</dd></div>
      <div><dt>المدفوع</dt><dd class="num">${formatMoney(p.paid)}</dd></div>
      ${cancelled ? '' : `<div class="${p.remaining ? 'is-owed' : ''}"><dt>المتبقي عليك</dt><dd class="num">${formatMoney(p.remaining)}</dd></div>`}
    </dl>
    ${
      p.payments.length
        ? `<h3 class="detail-subtitle">الدفعات</h3>
      <ul class="payment-list">${p.payments
        .map((pay) => `<li><span>${dayName.format(new Date(pay.date))}</span><span class="num">${formatMoney(pay.amount)}</span></li>`)
        .join('')}</ul>`
        : ''
    }
    ${p.note ? `<p class="hint">ملاحظة: ${escapeHtml(p.note)}</p>` : ''}`;

  const actions = [];
  if (!cancelled && p.remaining > 0) actions.push('<button class="btn btn-primary" type="button" data-action="pay">تسديد مبلغ للمورد</button>');
  if (!cancelled) actions.push('<button class="btn danger" type="button" data-action="cancel">إلغاء الفاتورة</button>');
  actions.push('<button class="btn btn-ghost" type="button" data-action="close">إغلاق</button>');
  els.detailActions.innerHTML = actions.join('');
}

function openPayForm() {
  const p = state.detail;
  els.payForm.hidden = false;
  els.payError.hidden = true;
  els.detailActions.querySelector('[data-action="pay"]')?.remove();
  els.payAmount.value = p.remaining;
  els.payAmount.max = p.remaining;
  els.payDate.value = dayKey(new Date());
  els.payAmount.focus();
  els.payAmount.select();
}

els.detailActions.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') els.detailDialog.close();
  else if (action === 'pay') openPayForm();
  else if (action === 'cancel') cancelPurchase();
});

els.payAll.addEventListener('click', () => {
  els.payAmount.value = state.detail.remaining;
  els.payAmount.focus();
});

els.payForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = num(els.payAmount.value);
  const showPayError = (message) => {
    els.payError.textContent = message;
    els.payError.hidden = false;
    els.payAmount.focus();
  };
  if (!(amount > 0)) return showPayError('أدخل مبلغًا أكبر من صفر');
  if (amount > state.detail.remaining) return showPayError(`المتبقي على هذه الفاتورة ${formatMoney(state.detail.remaining)} فقط`);
  if (!els.payDate.value) return showPayError('اختر تاريخ الدفع');
  const submit = els.payForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    state.detail = await api(`/purchases/${state.detail._id}/payments`, {
      method: 'POST',
      body: { amount, date: dayToIso(els.payDate.value) },
    });
    toast(
      state.detail.remaining
        ? `سُجّلت دفعة ${formatMoney(amount)}. يبقى ${formatMoney(state.detail.remaining)}`
        : `سُجّلت دفعة ${formatMoney(amount)}. الفاتورة مدفوعة بالكامل`,
    );
    els.payForm.hidden = true;
    renderDetail();
    loadList();
  } catch (err) {
    showPayError(err.message);
  } finally {
    submit.disabled = false;
  }
});

async function cancelPurchase() {
  const p = state.detail;
  const goods = p.items.map((i) => `${i.name}: ${qtyIn(i.stockQty, i.unit)}`).join('، ');
  const paidNote = p.paid > 0 ? ` ما دُفع للمورد (${formatMoney(p.paid)}) لا يُسترد تلقائيًا.` : '';
  if (!confirm(`إلغاء فاتورة الشراء رقم ${p.number}؟ ستُخرج كمياتها من المخزن (${goods}) وتعود الأسعار السابقة إن لم تتغيّر بعدها.${paidNote}`)) return;
  try {
    state.detail = await api(`/purchases/${p._id}/cancel`, { method: 'POST' });
    toast(`أُلغيت فاتورة الشراء رقم ${p.number}`);
    renderDetail();
    loadList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* New invoice */

function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing was saved
  }
}

// Kept on this device until the invoice is saved, so an interrupted entry is not lost
function saveDraft() {
  const d = state.draft;
  if (!d) return;
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        supplier: els.supplier.value,
        date: els.date.value,
        reference: els.reference.value,
        note: els.note.value,
        payMode: d.payMode,
        paid: els.paid.value,
        clientId: d.clientId,
        lines: d.lines.map((l) => ({
          product: l.product._id,
          mode: l.mode,
          quantity: l.quantity,
          price: l.price,
          salePrice: l.salePrice,
        })),
      }),
    );
  } catch {
    // Private browsing or full storage: the invoice still works, it just is not kept
  }
}

async function openComposer() {
  els.listView.hidden = true;
  els.composer.hidden = false;
  window.scrollTo(0, 0);
  clearError();
  // One id per invoice, kept with the draft: saving it twice still makes one invoice
  state.draft = { lines: [], payMode: 'full', clientId: newClientId() };
  els.supplier.value = '';
  els.reference.value = '';
  els.note.value = '';
  els.paid.value = '';
  els.date.value = dayKey(new Date());
  els.date.max = dayKey(new Date());
  renderLines();
  try {
    const [products, suppliers] = await Promise.all([api('/products'), api('/purchases/suppliers')]);
    state.products = products;
    state.suppliers = suppliers;
  } catch (err) {
    toast(err.message, 'error');
  }
  restoreDraft();
  updateSupplierNote();
  if (finePointer) (state.draft.lines.length ? els.scan : els.supplier).focus();
}

function restoreDraft() {
  const saved = readDraft();
  if (!saved?.lines) return;
  const byId = new Map(state.products.map((p) => [p._id, p]));
  els.supplier.value = saved.supplier ?? '';
  els.date.value = saved.date || dayKey(new Date());
  els.reference.value = saved.reference ?? '';
  els.note.value = saved.note ?? '';
  els.paid.value = saved.paid ?? '';
  state.draft.payMode = ['full', 'part', 'credit'].includes(saved.payMode) ? saved.payMode : 'full';
  if (typeof saved.clientId === 'string') state.draft.clientId = saved.clientId;
  let missing = 0;
  for (const l of saved.lines) {
    const product = byId.get(l.product);
    if (!product) {
      missing++;
      continue;
    }
    const mode = l.mode === 'pack' && hasPack(product) ? 'pack' : 'unit';
    state.draft.lines.push({ key: ++lineSeq, product, mode, quantity: l.quantity, price: l.price, salePrice: l.salePrice });
  }
  renderLines();
  if (state.draft.lines.length) toast(`عدت إلى الفاتورة التي لم تُحفظ (${arCount(state.draft.lines.length, ITEMS)})`);
  if (missing) toast(`أُزيل ${arCount(missing, ITEMS)} حُذف من المنتجات`, 'error');
}

function showList() {
  els.composer.hidden = true;
  els.listView.hidden = false;
  state.draft = null;
  renderDraftBanner();
  loadList();
}

function route() {
  if (location.hash === '#new') openComposer();
  else showList();
}
window.addEventListener('hashchange', route);

/* Supplier field */

combo({
  input: els.supplier,
  list: els.supplierSuggest,
  items: (q) => {
    const nq = normalizeArabic(q);
    const exact = state.suppliers.some((s) => s.name === q);
    return state.suppliers.filter((s) => !nq || exact || normalizeArabic(s.name).includes(nq)).slice(0, 8);
  },
  label: (s) => `<span>${escapeHtml(s.name)}</span>${
    s.owed > 0 ? `<span class="debt-chip owes num">عليك ${formatMoney(s.owed)}</span>` : ''
  }`,
  onPick: (s) => {
    els.supplier.value = s.name;
    updateSupplierNote();
    saveDraft();
    if (finePointer) els.reference.focus();
  },
});

function updateSupplierNote() {
  const name = els.supplier.value.trim();
  const known = state.suppliers.find((s) => s.name === name);
  els.supplierNote.textContent = !name
    ? ''
    : known
      ? known.owed > 0
        ? `عليك له حاليًا ${formatMoney(known.owed)} من فواتير سابقة`
        : 'لا شيء عليك له حاليًا'
      : 'مورد جديد';
}

els.supplier.addEventListener('input', updateSupplierNote);
[els.supplier, els.date, els.reference, els.note].forEach((input) => input.addEventListener('input', saveDraft));

/* Adding products */

const productCombo = combo({
  input: els.scan,
  list: els.productSuggest,
  items: (q) => {
    if (!q) return [];
    const nq = normalizeArabic(q);
    return state.products.filter((p) => normalizeArabic(p.name).includes(nq) || p.barcode.includes(q)).slice(0, 8);
  },
  label: (p) => `<span>${escapeHtml(p.name)}<small class="num">${escapeHtml(p.barcode)}</small></span>
    <span class="debt-chip clear num">${p.trackStock ? `في المخزن ${qtyIn(p.stock, unitOf(p))}` : 'بلا كمية'}</span>`,
  onPick: (p) => {
    els.scan.value = '';
    addProduct(p);
  },
});

async function findByCode(code) {
  const known = state.products.find((p) => p.barcode === code);
  if (known) return known;
  try {
    // Added on the products page after this screen opened
    const product = await api(`/products/barcode/${encodeURIComponent(code)}`);
    state.products.push(product);
    return product;
  } catch {
    return null;
  }
}

els.scan.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const text = els.scan.value.trim();
  if (!text) return;
  const product = (await findByCode(text)) ?? productCombo.first();
  if (product) {
    els.scan.value = '';
    productCombo.close();
    addProduct(product);
    return;
  }
  els.scan.classList.remove('is-error');
  void els.scan.offsetWidth; // restart the shake
  els.scan.classList.add('is-error');
  toast(/^\d+$/.test(text) ? `لا يوجد منتج بالباركود ${text}. أضفه أولًا من صفحة المنتجات` : 'لا يوجد منتج بهذا الاسم', 'error');
});

els.camera.addEventListener('click', async () => {
  await scanBarcodes(async (code) => {
    const product = await findByCode(code);
    if (!product) return { ok: false, message: `لا يوجد منتج بالباركود ${code}. أضفه أولًا من صفحة المنتجات` };
    const line = addProduct(product, { focus: false });
    return { ok: true, message: `«${product.name}»: ${boughtLabel({ ...lineCalc(line), unit: unitOf(product), mode: line.mode, packSize: packSizeOf(line), quantity: num(line.quantity) })}` };
  });
});

// Scanning a product already on the invoice adds one more of it
function addProduct(product, { focus = true } = {}) {
  const d = state.draft;
  let line = d.lines.find((l) => l.product._id === product._id);
  if (line) {
    const qty = num(line.quantity);
    line.quantity = String(Number.isFinite(qty) ? roundQty(qty + 1) : 1);
  } else {
    const mode = hasPack(product) ? 'pack' : 'unit';
    line = {
      key: ++lineSeq,
      product,
      mode,
      quantity: '1',
      price: String(roundMoney(product.purchasePrice * (mode === 'pack' ? product.wholesaleQty : 1))),
      salePrice: String(product.salePrice),
    };
    d.lines.unshift(line); // newest on top, next to the scan box
  }
  clearError();
  renderLines();
  saveDraft();
  const row = els.lines.querySelector(`[data-key="${line.key}"]`);
  row?.classList.add('is-flash');
  if (focus && finePointer) {
    const qty = row?.querySelector('[data-field="quantity"]');
    qty?.focus();
    qty?.select();
  }
  return line;
}

/* Invoice lines */

function lineRow(line) {
  const p = line.product;
  const unit = unitOf(p);
  const unitWord = unit === 'kg' ? 'كغم' : 'قطعة';
  const unitControl = hasPack(p)
    ? `<select class="input" data-field="mode" aria-label="وحدة الشراء">
        <option value="pack"${line.mode === 'pack' ? ' selected' : ''}>${escapeHtml(packName(unit, p.wholesaleQty))}</option>
        <option value="unit"${line.mode === 'unit' ? ' selected' : ''}>${unitWord}</option>
      </select>`
    : `<span class="unit-word">${unitWord}</span>`;
  const step = line.mode === 'pack' || unit === 'piece' ? '1' : 'any';
  return `<tr data-key="${line.key}">
    <td>
      <div class="pname">${escapeHtml(p.name)}</div>
      <small class="line-hint" data-info="stock"></small>
    </td>
    <td>
      <div class="qty-field">
        <input class="input num" data-field="quantity" type="number" min="0" step="${step}" inputmode="${step === '1' ? 'numeric' : 'decimal'}" value="${escapeHtml(line.quantity)}" aria-label="كمية ${escapeHtml(p.name)}">
        ${unitControl}
      </div>
    </td>
    <td>
      <input class="input num" data-field="price" type="number" min="0" step="any" inputmode="decimal" value="${escapeHtml(line.price)}" aria-label="سعر شراء ${escapeHtml(p.name)}">
      <small class="line-hint" data-info="cost"></small>
    </td>
    <td class="end"><strong class="num" data-info="total"></strong></td>
    <td>
      <input class="input num" data-field="salePrice" type="number" min="0" step="any" inputmode="decimal" value="${escapeHtml(line.salePrice)}" aria-label="سعر بيع ${escapeHtml(p.name)}">
      <small class="line-hint" data-info="margin"></small>
    </td>
    <td class="row-actions"><button class="icon-btn danger" type="button" data-remove title="إزالة" aria-label="إزالة ${escapeHtml(p.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>
  </tr>`;
}

function renderLines() {
  const lines = state.draft?.lines ?? [];
  if (!lines.length) {
    els.lines.innerHTML = `<div class="lines-empty">
      <strong>الفاتورة فارغة</strong>
      <p>امسح باركود البضاعة التي وصلت، أو اكتب اسم المنتج في الخانة أعلاه واختره.</p>
    </div>`;
  } else {
    els.lines.innerHTML = `<table class="ptable purchase-table">
      <thead><tr>
        <th scope="col">المنتج</th>
        <th scope="col">الكمية</th>
        <th scope="col">سعر الشراء</th>
        <th scope="col" class="end">الإجمالي</th>
        <th scope="col">سعر البيع</th>
        <th scope="col"><span class="sr-only">إزالة</span></th>
      </tr></thead>
      <tbody>${lines.map(lineRow).join('')}</tbody>
    </table>`;
    lines.forEach(updateLineInfo);
  }
  updateTotals();
}

// The figures under each field: stock after receiving, the price change, the margin
function updateLineInfo(line) {
  const row = els.lines.querySelector(`[data-key="${line.key}"]`);
  if (!row) return;
  const p = line.product;
  const unit = unitOf(p);
  const c = lineCalc(line);

  const stock = row.querySelector('[data-info="stock"]');
  if (!p.trackStock) {
    stock.textContent = c.stockQty ? `كميته غير مسجّلة. تبدأ متابعتها من ${qtyIn(c.stockQty, unit)}` : 'كميته غير مسجّلة';
  } else {
    stock.textContent = `في المخزن ${qtyIn(p.stock, unit)}${c.stockQty ? ` ← يصبح ${qtyIn(roundQty(p.stock + c.stockQty), unit)}` : ''}`;
  }

  const cost = row.querySelector('[data-info="cost"]');
  const parts = [];
  if (line.mode === 'pack' && Number.isFinite(c.unitCost)) parts.push(`أي ${formatMoney(c.unitCost)} ${perWord(unit, 'unit')}`);
  if (c.price === 0) parts.push('مجاني، لا يغيّر سعر الشراء');
  else if (Number.isFinite(c.unitCost) && c.unitCost !== p.purchasePrice) parts.push(`كان ${formatMoney(p.purchasePrice)} ${perWord(unit, 'unit')}`);
  cost.textContent = parts.join('، ');
  cost.className = `line-hint${c.price > 0 && c.unitCost > p.purchasePrice ? ' is-up' : c.price > 0 && c.unitCost < p.purchasePrice ? ' is-down' : ''}`;

  row.querySelector('[data-info="total"]').textContent = formatMoney(c.total);

  const margin = row.querySelector('[data-info="margin"]');
  const sale = num(line.salePrice);
  const unitCost = c.price === 0 ? p.purchasePrice : c.unitCost;
  if (Number.isFinite(sale) && Number.isFinite(unitCost)) {
    const profit = roundMoney(sale - unitCost);
    margin.textContent =
      profit < 0
        ? `خسارة ${formatMoney(-profit)} ${inThe(unit)}`
        : `ربح ${formatMoney(profit)} ${inThe(unit)}${unitCost > 0 ? ` (${Math.round((profit / unitCost) * 100)}%)` : ''}`;
    margin.className = `line-hint${profit < 0 ? ' is-up' : ''}`;
  } else {
    margin.textContent = '';
  }
}

function updateTotals() {
  const d = state.draft;
  if (!d) return;
  const total = draftTotal();
  els.count.textContent = d.lines.length ? arCount(d.lines.length, ITEMS) : 'لا أصناف بعد';
  els.total.textContent = formatMoney(total);
  els.payButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pay === d.payMode)));
  els.paidField.hidden = d.payMode !== 'part';

  const paid = d.payMode === 'full' ? total : d.payMode === 'credit' ? 0 : num(els.paid.value);
  const note = els.remaining;
  note.className = 'margin-note';
  if (!d.lines.length) note.textContent = '';
  else if (d.payMode === 'part' && !Number.isFinite(paid)) note.textContent = 'اكتب المبلغ الذي دفعته الآن';
  else if (paid > total) {
    note.textContent = 'المدفوع أكبر من إجمالي الفاتورة';
    note.classList.add('is-loss');
  } else if (paid < total) {
    note.textContent = `يبقى عليك للمورد ${formatMoney(roundMoney(total - paid))}`;
    note.classList.add('is-loss');
  } else {
    note.textContent = 'مدفوعة بالكامل';
    note.classList.add('is-gain');
  }
  els.save.disabled = !d.lines.length;
}

els.lines.addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  if (!field || field === 'mode') return;
  const line = state.draft.lines.find((l) => String(l.key) === e.target.closest('[data-key]').dataset.key);
  line[field] = e.target.value;
  e.target.classList.remove('is-invalid');
  updateLineInfo(line);
  updateTotals();
  saveDraft();
});

// Switching between boxes and pieces keeps the same cost per piece
els.lines.addEventListener('change', (e) => {
  if (e.target.dataset.field !== 'mode') return;
  const line = state.draft.lines.find((l) => String(l.key) === e.target.closest('[data-key]').dataset.key);
  const { unitCost } = lineCalc(line);
  line.mode = e.target.value;
  if (Number.isFinite(unitCost)) line.price = String(roundMoney(unitCost * packSizeOf(line)));
  renderLines();
  saveDraft();
});

els.lines.addEventListener('click', (e) => {
  if (!e.target.closest('[data-remove]')) return;
  const key = e.target.closest('[data-key]').dataset.key;
  state.draft.lines = state.draft.lines.filter((l) => String(l.key) !== key);
  renderLines();
  saveDraft();
});

// Enter in a line's field moves on, and from the last field back to the scan box
els.lines.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.dataset.field) return;
  e.preventDefault();
  const order = ['quantity', 'price', 'salePrice'];
  const next = order[order.indexOf(e.target.dataset.field) + 1];
  const target = next && e.target.closest('tr').querySelector(`[data-field="${next}"]`);
  (target ?? els.scan).focus();
  target?.select();
});

els.payButtons.forEach((b) =>
  b.addEventListener('click', () => {
    state.draft.payMode = b.dataset.pay;
    if (b.dataset.pay === 'part') {
      els.paid.value = '';
      updateTotals();
      els.paid.focus();
    } else {
      updateTotals();
    }
    saveDraft();
  }),
);
els.paid.addEventListener('input', () => {
  updateTotals();
  saveDraft();
});

/* Saving */

function clearError() {
  els.error.hidden = true;
}

function showError(message, input) {
  els.error.textContent = message;
  els.error.hidden = false;
  if (input) {
    input.classList.add('is-invalid');
    input.focus();
  } else {
    els.error.scrollIntoView({ block: 'nearest' });
  }
}

// The first problem in the invoice, pointing at its field
function checkDraft() {
  const d = state.draft;
  if (!els.date.value) return { message: 'اختر تاريخ الفاتورة', input: els.date };
  for (const line of d.lines) {
    const p = line.product;
    const row = els.lines.querySelector(`[data-key="${line.key}"]`);
    const c = lineCalc(line);
    const whole = line.mode === 'pack' || unitOf(p) === 'piece';
    if (!(c.qty > 0)) return { message: `أدخل كمية «${p.name}»`, input: row.querySelector('[data-field="quantity"]') };
    if (whole && !Number.isInteger(c.qty)) {
      return { message: `كمية «${p.name}» يجب أن تكون عددًا صحيحًا`, input: row.querySelector('[data-field="quantity"]') };
    }
    if (!(c.price >= 0)) return { message: `أدخل سعر شراء «${p.name}»`, input: row.querySelector('[data-field="price"]') };
    const sale = num(line.salePrice);
    if (String(line.salePrice).trim() !== '' && !(sale >= 0)) {
      return { message: `سعر بيع «${p.name}» غير صالح`, input: row.querySelector('[data-field="salePrice"]') };
    }
  }
  if (d.payMode === 'part') {
    const paid = num(els.paid.value);
    if (!(paid >= 0)) return { message: 'اكتب المبلغ الذي دفعته للمورد الآن', input: els.paid };
    if (paid > draftTotal()) return { message: 'المدفوع أكبر من إجمالي الفاتورة', input: els.paid };
  }
  return null;
}

els.save.addEventListener('click', async () => {
  clearError();
  const d = state.draft;
  const problem = checkDraft();
  if (problem) {
    showError(problem.message, problem.input);
    return;
  }
  const total = draftTotal();
  const paid = d.payMode === 'full' ? total : d.payMode === 'credit' ? 0 : num(els.paid.value);
  const body = {
    date: dayToIso(els.date.value),
    supplier: els.supplier.value.trim(),
    reference: els.reference.value.trim(),
    note: els.note.value.trim(),
    paid,
    clientId: d.clientId,
    items: d.lines.map((l) => ({
      product: l.product._id,
      mode: l.mode,
      quantity: num(l.quantity),
      price: num(l.price),
      salePrice: String(l.salePrice).trim() === '' ? undefined : num(l.salePrice),
    })),
  };
  els.save.disabled = true;
  try {
    const purchase = await withSignIn(() => api('/purchases', { method: 'POST', body }));
    clearDraft();
    toast(`حُفظت فاتورة الشراء رقم ${purchase.number}، وأُضيفت الكميات إلى المخزن`);
    els.month.value = els.date.value.slice(0, 7);
    location.hash = '';
  } catch (err) {
    showError(err.message);
  } finally {
    els.save.disabled = !state.draft?.lines.length;
  }
});

els.discard.addEventListener('click', () => {
  if (state.draft.lines.length && !confirm('إلغاء هذه الفاتورة؟ لن يُحفظ شيء ولن تتغيّر أي كمية.')) return;
  clearDraft();
  state.draft = null;
  location.hash = '';
});

// The month can come from a link (?month=YYYY-MM)
const requested = new URLSearchParams(location.search).get('month');
els.month.value = /^\d{4}-\d{2}$/.test(requested ?? '') ? requested : monthKey(new Date());
route();
