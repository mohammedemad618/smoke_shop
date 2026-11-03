import {
  api,
  toast,
  formatMoney,
  formatQty,
  formatWeight,
  formatDateTime,
  escapeHtml,
  arCount,
  roundQty,
  normalizeArabic,
  PRODUCTS,
  PIECES,
} from './common.js';
import { scanBarcode } from './scanner.js';

// On touch screens, refocusing the scan box would keep popping up the keyboard
const finePointer = matchMedia('(pointer: fine)').matches;

const state = {
  count: null, // the open stocktake, or null
  history: [],
  products: [],
  lines: new Map(), // product id -> its line in the open stocktake
  category: '',
  filter: 'all', // all | todo | diff
  query: '',
  current: null, // the product in the count window
};

const $ = (id) => document.getElementById(id);
const els = {
  view: $('view'),
  headActions: $('headActions'),
  countDialog: $('countDialog'),
  countForm: $('countForm'),
  countTitle: $('countTitle'),
  countMeta: $('countMeta'),
  countExpected: $('countExpected'),
  countPrevRow: $('countPrevRow'),
  countPrev: $('countPrev'),
  countRemove: $('countRemove'),
  countLabel: $('countLabel'),
  countInput: $('countInput'),
  countAddRow: $('countAddRow'),
  countAdd: $('countAdd'),
  countDiff: $('countDiff'),
  countError: $('countError'),
  countActions: $('countActions'),
  countSave: $('countSave'),
  countNext: $('countNext'),
  applyDialog: $('applyDialog'),
  applyForm: $('applyForm'),
  applySummary: $('applySummary'),
  applyConfirm: $('applyConfirm'),
  historyDialog: $('historyDialog'),
  historyBody: $('historyBody'),
};

const SCAN_ICON =
  '<svg class="scan-icon" viewBox="0 0 24 20" aria-hidden="true"><path fill="currentColor" d="M1 1h2v18H1zM5 1h1v18H5zM8 1h3v18H8zM13 1h1v18h-1zM16 1h2v18h-2zM20 1h1v18h-1zM22 1h1v18h-1z"/></svg>';
const CAMERA_ICON =
  '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M8 9v6M11 9v6M14 9v6M17 9v6"/></svg>';

const unitOf = (p) => p.unit ?? 'piece';
// Table cells: "12" pieces, "2.5 كغم" or "750 غ"
const qtyIn = (qty, unit) => (unit === 'kg' ? formatWeight(qty) : formatQty(qty));
// Sentences: "3 قطع", "قطعة واحدة", "750 غ"
const amount = (qty, unit) => (unit === 'kg' ? formatWeight(qty) : arCount(qty, PIECES));
// Counted minus what the system had; null when its quantity was not tracked before
const diffOf = (line) => (line.expected === null ? null : roundQty(line.counted - line.expected));
const recordedOf = (p) => (p.trackStock ? p.stock : null);

/* Data */

async function load() {
  const [count, products, history] = await Promise.all([
    api('/stockcounts/current'),
    api('/products'),
    api('/stockcounts'),
  ]);
  state.count = count;
  state.products = products;
  state.history = history;
  state.lines = new Map((count?.lines ?? []).map((l) => [String(l.product), l]));
  render();
}

// Sales on other devices change the recorded quantities: pick them up on coming back
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.count) return;
  try {
    state.products = await api('/products');
    updateOpen();
  } catch {
    // The figures on screen stay; the server uses the live quantities anyway
  }
});

function summarize(lines) {
  const s = { short: 0, shortValue: 0, over: 0, overValue: 0, fresh: 0 };
  for (const line of lines) {
    const diff = diffOf(line);
    if (diff === null) s.fresh++;
    else if (diff < 0) {
      s.short++;
      s.shortValue += -diff * line.purchasePrice;
    } else if (diff > 0) {
      s.over++;
      s.overValue += diff * line.purchasePrice;
    }
  }
  return s;
}

/* Rendering */

function render() {
  if (state.count) renderOpen();
  else renderIdle();
}

function renderIdle() {
  els.headActions.innerHTML = '';
  els.view.dataset.view = 'idle';
  els.view.innerHTML = `<section class="count-intro">
      <h2>عدّ البضاعة الموجودة فعلًا</h2>
      <ol class="count-steps">
        <li>امسح باركود كل منتج على الرفوف، بالقارئ أو بكاميرا الجهاز، واكتب العدد الموجود.</li>
        <li>يقارن النظام عدّك بالكمية المسجّلة ويُظهر النقص والزيادة وقيمتهما.</li>
        <li>اعتمد الجرد فتُصحَّح الكميات ويُحفظ بتاريخه في السجل.</li>
      </ol>
      <p class="hint">العمل يُحفظ أولًا بأول: يمكنك التوقف والإكمال لاحقًا، أو جرد قسم واحد فقط. المنتجات التي لا تعدّها تبقى كمياتها كما هي.</p>
      <button class="btn btn-primary" type="button" data-start>بدء جرد جديد</button>
    </section>
    <section class="report-section">
      <div class="section-head"><h2>الجرود السابقة</h2></div>
      ${historyTable()}
    </section>`;
}

function historyTable() {
  if (!state.history.length) return '<p class="hint">لا توجد جرود سابقة بعد.</p>';
  return `<table class="ptable">
    <thead><tr>
      <th scope="col">التاريخ</th>
      <th scope="col" class="end">المعدود</th>
      <th scope="col" class="end">النقص</th>
      <th scope="col" class="end">الزيادة</th>
      <th scope="col" class="end">رأس المال بعده</th>
      <th scope="col"><span class="sr-only">تفاصيل</span></th>
    </tr></thead>
    <tbody>${state.history
      .map((c) => {
        const s = c.summary ?? {};
        return `<tr>
          <td>${formatDateTime(c.appliedAt)}</td>
          <td class="end"><span class="num">${s.counted ?? 0}</span></td>
          <td class="end"><span class="num${s.shortValue ? ' loss' : ''}">${formatMoney(s.shortValue)}</span></td>
          <td class="end"><span class="num">${formatMoney(s.overValue)}</span></td>
          <td class="end"><span class="num">${formatMoney(s.capital)}</span></td>
          <td class="row-actions"><button class="btn btn-sm" type="button" data-history="${c._id}">التفاصيل</button></td>
        </tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

function renderOpen() {
  if (els.view.dataset.view !== 'open') {
    els.view.dataset.view = 'open';
    els.view.innerHTML = `<p class="period-title" id="countSince"></p>
      <div class="zreport" id="countSummary"></div>
      <div class="scan count-scan">
        <label for="countScan" class="sr-only">الباركود أو اسم المنتج</label>
        ${SCAN_ICON}
        <input id="countScan" class="scan-input" placeholder="الباركود أو اسم المنتج" autocomplete="off" spellcheck="false">
        <button class="scan-camera" type="button" data-camera title="المسح بكاميرا الجهاز">${CAMERA_ICON}<span class="btn-label">الكاميرا</span></button>
      </div>
      <div class="count-filters">
        <div class="chips" id="countChips" aria-label="الأقسام"></div>
        <div class="segmented segmented-sm" role="group" aria-label="عرض المنتجات">
          <button type="button" data-filter="all" aria-pressed="true">الكل</button>
          <button type="button" data-filter="todo" aria-pressed="false">لم يُعدّ</button>
          <button type="button" data-filter="diff" aria-pressed="false">فيه فرق</button>
        </div>
      </div>
      <div id="countList"></div>`;
    state.category = '';
    state.filter = 'all';
    state.query = '';
    if (finePointer) $('countScan').focus();
  }
  updateOpen();
}

function updateOpen() {
  if (els.view.dataset.view !== 'open') return;
  const lines = [...state.lines.values()];
  const s = summarize(lines);
  els.headActions.innerHTML = `<button class="btn btn-go" type="button" data-apply${lines.length ? '' : ' disabled'}>اعتماد الجرد</button>
    <button class="btn btn-ghost danger" type="button" data-cancel>إلغاء الجرد</button>`;
  $('countSince').textContent = `جرد مفتوح منذ ${formatDateTime(state.count.createdAt)}. كل عدّ يُحفظ فورًا.`;

  const total = state.products.length;
  const done = state.products.filter((p) => state.lines.has(p._id)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('countSummary').innerHTML = `<div>
      <span class="z-label">المعدود</span>
      <div class="z-value num">${done} / ${total}</div>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="نسبة المعدود"><span style="width: ${pct}%"></span></div>
    </div>
    <div>
      <span class="z-label">النقص</span>
      <div class="z-value num${s.shortValue ? ' is-loss' : ''}">${formatMoney(s.shortValue)}</div>
      <span class="z-note">${s.short ? `في ${arCount(s.short, PRODUCTS)}، بسعر الشراء` : 'لا يوجد حتى الآن'}</span>
    </div>
    <div>
      <span class="z-label">الزيادة</span>
      <div class="z-value num${s.overValue ? ' is-profit' : ''}">${formatMoney(s.overValue)}</div>
      <span class="z-note">${s.over ? `في ${arCount(s.over, PRODUCTS)}، بسعر الشراء` : 'لا يوجد حتى الآن'}</span>
    </div>
    <div class="z-net">
      <span class="z-label">تبدأ متابعة كميتها</span>
      <div class="z-value num">${s.fresh}</div>
      <span class="z-note">منتجات لم تكن كميتها مسجّلة</span>
    </div>`;

  renderChips();
  renderList();
}

function renderChips() {
  const groups = new Map();
  for (const p of state.products) {
    const id = p.category?._id ?? '';
    const g = groups.get(id) ?? { name: p.category?.name ?? 'بدون قسم', total: 0, done: 0 };
    g.total++;
    if (state.lines.has(p._id)) g.done++;
    groups.set(id, g);
  }
  const done = state.products.filter((p) => state.lines.has(p._id)).length;
  const chip = (id, name, d, t) =>
    `<button class="chip${t && d === t ? ' is-done' : ''}" type="button" data-category="${id}" aria-pressed="${state.category === id}">
      ${escapeHtml(name)} <span class="num chip-count">${d}/${t}</span>
    </button>`;
  $('countChips').innerHTML =
    chip('', 'الكل', done, state.products.length) +
    [...groups].map(([id, g]) => chip(id, g.name, g.done, g.total)).join('');
}

function visibleProducts() {
  const q = normalizeArabic(state.query);
  return state.products.filter((p) => {
    if (state.category && (p.category?._id ?? '') !== state.category) return false;
    const line = state.lines.get(p._id);
    if (state.filter === 'todo' && line) return false;
    if (state.filter === 'diff' && !(line && diffOf(line))) return false;
    if (q && !normalizeArabic(p.name).includes(q) && !p.barcode.includes(state.query)) return false;
    return true;
  });
}

const dash = '<span class="muted">—</span>';

function countRow(p) {
  const unit = unitOf(p);
  const line = state.lines.get(p._id);
  const recorded = line ? line.expected : recordedOf(p);
  let diff = dash;
  let value = dash;
  if (line) {
    const d = diffOf(line);
    if (d === null) diff = '<span class="diff is-new">تبدأ متابعته</span>';
    else if (d === 0) diff = '<span class="diff is-same">مطابق</span>';
    else {
      diff = `<span class="diff ${d < 0 ? 'is-short' : 'is-over'} num">${d < 0 ? '−' : '+'}${qtyIn(Math.abs(d), unit)}</span>`;
      value = `<span class="num${d < 0 ? ' loss' : ''}">${formatMoney(d * line.purchasePrice)}</span>`;
    }
  }
  return `<tr class="${line ? 'is-counted' : ''}" data-row="${p._id}">
    <td>
      <div class="pname">${escapeHtml(p.name)}</div>
      <div class="pcat"><span class="num">${escapeHtml(p.barcode)}</span></div>
    </td>
    <td>${recorded === null ? '<span class="muted">غير مسجّل</span>' : `<span class="num">${qtyIn(recorded, unit)}</span>`}</td>
    <td>${line ? `<strong class="num">${qtyIn(line.counted, unit)}</strong>` : '<span class="muted">لم يُعدّ</span>'}</td>
    <td>${diff}</td>
    <td class="end">${value}</td>
    <td class="row-actions"><button class="btn btn-sm${line ? '' : ' btn-primary'}" type="button" data-count="${p._id}">${line ? 'تعديل' : 'عدّ'}</button></td>
  </tr>`;
}

function renderList() {
  const list = $('countList');
  const products = visibleProducts();
  if (!products.length) {
    const why = state.query
      ? ['لا توجد نتائج', 'جرّب جزءًا من الاسم أو امسح الباركود.']
      : state.filter === 'todo'
        ? ['عُدّ كل شيء هنا', 'لا يوجد منتج متبقٍ في هذا العرض.']
        : state.filter === 'diff'
          ? ['لا توجد فروقات', 'كل ما عُدّ هنا مطابق للمسجّل.']
          : ['لا توجد منتجات', 'أضف المنتجات من صفحة المنتجات أولًا.'];
    list.innerHTML = `<div class="empty"><h3>${why[0]}</h3><p>${why[1]}</p></div>`;
    return;
  }
  list.innerHTML = `<table class="ptable count-table">
    <thead><tr>
      <th scope="col">المنتج</th>
      <th scope="col">المسجّل</th>
      <th scope="col">المعدود</th>
      <th scope="col">الفرق</th>
      <th scope="col" class="end">قيمة الفرق</th>
      <th scope="col"><span class="sr-only">عدّ</span></th>
    </tr></thead>
    <tbody>${products.map(countRow).join('')}</tbody>
  </table>`;
}

function flashRow(id) {
  const row = els.view.querySelector(`[data-row="${id}"]`);
  if (!row) return;
  row.classList.add('is-flash');
  row.scrollIntoView({ block: 'nearest' });
}

/* Finding products */

async function findByCode(code) {
  const known = state.products.find((p) => p.barcode === code);
  if (known) return known;
  try {
    // Added on the products page after this screen loaded
    const product = await api(`/products/barcode/${encodeURIComponent(code)}`);
    state.products.push(product);
    return product;
  } catch {
    return null;
  }
}

async function handleScanEnter(input) {
  const text = input.value.trim();
  if (!text) return;
  const matches = visibleProducts();
  const product = (await findByCode(text)) ?? (matches.length === 1 ? matches[0] : null);
  if (product) {
    input.value = '';
    state.query = '';
    renderList();
    openCount(product);
    return;
  }
  input.classList.remove('is-error');
  void input.offsetWidth; // restart the shake
  input.classList.add('is-error');
  toast(/^\d+$/.test(text) ? `لا يوجد منتج بالباركود ${text}` : 'اختر المنتج من القائمة', 'error');
}

async function scanWithCamera() {
  const code = await scanBarcode();
  if (!code) return;
  const product = await findByCode(code);
  if (!product) {
    toast(`لا يوجد منتج بالباركود ${code}`, 'error');
    return;
  }
  openCount(product, { viaCamera: true });
}

/* Counting one product */

function openCount(product, { viaCamera = false } = {}) {
  state.current = product;
  const unit = unitOf(product);
  const line = state.lines.get(product._id);
  const recorded = recordedOf(product);
  els.countTitle.textContent = product.name;
  els.countMeta.innerHTML = `<span class="num">${escapeHtml(product.barcode)}</span>${
    product.category ? `<span>${escapeHtml(product.category.name)}</span>` : ''
  }`;
  els.countExpected.textContent = recorded === null ? 'غير مسجّل' : amount(recorded, unit);
  els.countPrevRow.hidden = !line;
  els.countAddRow.hidden = !line;
  els.countAdd.checked = false;
  if (line) els.countPrev.textContent = amount(line.counted, unit);
  els.countLabel.textContent = unit === 'kg' ? 'الوزن الموجود فعلًا (كغم)' : 'العدد الموجود فعلًا (قطعة)';
  els.countInput.step = unit === 'kg' ? 'any' : '1';
  els.countInput.inputMode = unit === 'kg' ? 'decimal' : 'numeric';
  els.countInput.placeholder = unit === 'kg' ? 'مثل 2.5' : '0';
  els.countInput.value = line ? line.counted : '';
  // From the camera, Enter saves and goes straight to the next product
  els.countNext.hidden = !viaCamera;
  const [first, second] = viaCamera ? [els.countNext, els.countSave] : [els.countSave, els.countNext];
  first.className = 'btn btn-primary';
  second.className = 'btn';
  els.countActions.prepend(first, second);
  els.countError.hidden = true;
  updateCountDiff();
  els.countDialog.showModal();
  els.countInput.focus();
  els.countInput.select();
}

// What the field adds up to: the number typed, or added to the earlier count
function typedTotal() {
  const raw = els.countInput.value.trim();
  if (raw === '') return null;
  const n = Number(raw);
  const line = state.lines.get(state.current._id);
  return els.countAdd.checked && line ? roundQty(line.counted + n) : n;
}

function updateCountDiff() {
  const p = state.current;
  const unit = unitOf(p);
  const total = typedTotal();
  const note = els.countDiff;
  note.className = 'margin-note';
  if (total === null || !Number.isFinite(total) || total < 0) {
    note.textContent = '';
    return;
  }
  const lead = els.countAdd.checked ? `المجموع ${amount(total, unit)}. ` : '';
  const recorded = recordedOf(p);
  if (recorded === null) {
    note.textContent = `${lead}ستبدأ متابعة كميته من ${amount(total, unit)}.`;
    return;
  }
  const diff = roundQty(total - recorded);
  if (diff === 0) {
    note.textContent = `${lead}مطابق للمسجّل.`;
    note.classList.add('is-gain');
    return;
  }
  const value = formatMoney(Math.abs(diff) * p.purchasePrice);
  note.textContent =
    diff < 0 ? `${lead}نقص ${amount(-diff, unit)}، قيمته ${value}` : `${lead}زيادة ${amount(diff, unit)}، قيمتها ${value}`;
  note.classList.add(diff < 0 ? 'is-loss' : 'is-gain');
}

function showCountError(message) {
  els.countError.textContent = message;
  els.countError.hidden = false;
  els.countInput.focus();
}

els.countInput.addEventListener('input', () => {
  els.countError.hidden = true;
  updateCountDiff();
});
// Adding starts from an empty field, so the earlier count is not added to itself
els.countAdd.addEventListener('change', () => {
  const line = state.lines.get(state.current._id);
  els.countInput.value = els.countAdd.checked ? '' : (line?.counted ?? '');
  updateCountDiff();
  els.countInput.focus();
});

els.countForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = e.submitter === els.countNext;
  const product = state.current;
  const total = typedTotal();
  if (total === null || !Number.isFinite(total) || total < 0) {
    showCountError('أدخل العدد الموجود، صفر أو أكثر');
    return;
  }
  if (unitOf(product) === 'piece' && !Number.isInteger(total)) {
    showCountError('العدد يجب أن يكون عددًا صحيحًا من القطع');
    return;
  }
  const buttons = els.countForm.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const line = await api(`/stockcounts/${state.count._id}/lines/${product._id}`, {
      method: 'PUT',
      body: { counted: total },
    });
    state.lines.set(product._id, line);
    // The server read the live quantity; keep the list in step with it
    product.stock = line.expected ?? product.stock;
    els.countDialog.close();
    updateOpen();
    flashRow(product._id);
    if (next) scanWithCamera();
  } catch (err) {
    showCountError(err.message);
    if (err.status === 409) load().catch(() => {});
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

els.countRemove.addEventListener('click', async () => {
  const product = state.current;
  try {
    await api(`/stockcounts/${state.count._id}/lines/${product._id}`, { method: 'DELETE' });
    state.lines.delete(product._id);
    els.countDialog.close();
    updateOpen();
    toast(`أُزيل عدّ «${product.name}»`);
  } catch (err) {
    showCountError(err.message);
  }
});

els.countDialog.addEventListener('close', () => {
  if (finePointer && state.count) $('countScan')?.focus();
});

/* Starting, applying and cancelling */

async function startCount() {
  try {
    state.count = await api('/stockcounts', { method: 'POST' });
    state.lines = new Map();
    render();
  } catch (err) {
    toast(err.message, 'error');
    load().catch(() => {});
  }
}

function openApply() {
  const lines = [...state.lines.values()];
  const s = summarize(lines);
  const left = state.products.filter((p) => !state.lines.has(p._id)).length;
  const items = [`عُدّ ${arCount(lines.length, PRODUCTS)} من ${formatMoney(state.products.length)}.`];
  items.push(
    s.short
      ? `<span class="loss">نقص في ${arCount(s.short, PRODUCTS)} بقيمة ${formatMoney(s.shortValue)}</span> بسعر الشراء.`
      : 'لا يوجد نقص.',
  );
  items.push(s.over ? `زيادة في ${arCount(s.over, PRODUCTS)} بقيمة ${formatMoney(s.overValue)}.` : 'لا توجد زيادة.');
  if (s.fresh) items.push(`${arCount(s.fresh, PRODUCTS)} تبدأ متابعة كميتها من العدد الذي كتبته.`);
  if (left) items.push(`المنتجات التي لم تُعدّ (${formatMoney(left)}) تبقى كمياتها كما هي.`);
  els.applySummary.innerHTML = items.map((t) => `<li>${t}</li>`).join('');
  els.applyDialog.showModal();
}

els.applyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.applyConfirm.disabled = true;
  try {
    const applied = await api(`/stockcounts/${state.count._id}/apply`, { method: 'POST' });
    els.applyDialog.close();
    toast(`اعتُمد الجرد. رأس المال في البضاعة الآن ${formatMoney(applied.summary.capital)}`);
    await load();
  } catch (err) {
    els.applyDialog.close();
    toast(err.message, 'error');
    load().catch(() => {});
  } finally {
    els.applyConfirm.disabled = false;
  }
});

async function cancelCount() {
  const n = state.lines.size;
  const message = n
    ? `إلغاء الجرد؟ ستُحذف الأعداد المسجّلة فيه (${formatMoney(n)}) ولن تتغيّر أي كمية.`
    : 'إلغاء الجرد؟';
  if (!confirm(message)) return;
  try {
    await api(`/stockcounts/${state.count._id}`, { method: 'DELETE' });
    toast('أُلغي الجرد');
  } catch (err) {
    toast(err.message, 'error');
  }
  await load();
}

/* Past stocktakes */

async function showHistory(id) {
  let count;
  try {
    count = await api(`/stockcounts/${id}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const s = count.summary ?? {};
  // Biggest shortages first, then surpluses, then newly tracked, matches last
  const weight = (l) => {
    const d = diffOf(l);
    if (d === null) return 1e15;
    if (d === 0) return 2e15;
    return d * l.purchasePrice;
  };
  const lines = [...count.lines].sort((a, b) => weight(a) - weight(b));
  els.historyBody.innerHTML = `<h2 id="historyTitle">جرد ${formatDateTime(count.appliedAt)}</h2>
    <div class="zreport">
      <div><span class="z-label">المعدود</span><div class="z-value num">${s.counted ?? 0}</div></div>
      <div><span class="z-label">النقص</span><div class="z-value num${s.shortValue ? ' is-loss' : ''}">${formatMoney(s.shortValue)}</div>
        <span class="z-note">${s.shortItems ? `في ${arCount(s.shortItems, PRODUCTS)}` : 'لا يوجد'}</span></div>
      <div><span class="z-label">الزيادة</span><div class="z-value num">${formatMoney(s.overValue)}</div>
        <span class="z-note">${s.overItems ? `في ${arCount(s.overItems, PRODUCTS)}` : 'لا يوجد'}</span></div>
      <div class="z-net"><span class="z-label">رأس المال بعده</span><div class="z-value num">${formatMoney(s.capital)}</div>
        <span class="z-note">بسعر الشراء</span></div>
    </div>
    <table class="ptable">
      <thead><tr>
        <th scope="col">المنتج</th>
        <th scope="col">المسجّل</th>
        <th scope="col">المعدود</th>
        <th scope="col">الفرق</th>
        <th scope="col" class="end">قيمة الفرق</th>
      </tr></thead>
      <tbody>${lines
        .map((l) => {
          const d = diffOf(l);
          const diff =
            d === null
              ? '<span class="diff is-new">بدأت متابعته</span>'
              : d === 0
                ? '<span class="diff is-same">مطابق</span>'
                : `<span class="diff ${d < 0 ? 'is-short' : 'is-over'} num">${d < 0 ? '−' : '+'}${qtyIn(Math.abs(d), l.unit)}</span>`;
          return `<tr>
            <td><div class="pname">${escapeHtml(l.name)}</div><div class="pcat"><span class="num">${escapeHtml(l.barcode)}</span></div></td>
            <td>${l.expected === null ? '<span class="muted">غير مسجّل</span>' : `<span class="num">${qtyIn(l.expected, l.unit)}</span>`}</td>
            <td><strong class="num">${qtyIn(l.counted, l.unit)}</strong></td>
            <td>${diff}</td>
            <td class="end">${d ? `<span class="num${d < 0 ? ' loss' : ''}">${formatMoney(d * l.purchasePrice)}</span>` : dash}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;
  els.historyDialog.showModal();
}

/* Events */

els.headActions.addEventListener('click', (e) => {
  if (e.target.closest('[data-apply]')) openApply();
  else if (e.target.closest('[data-cancel]')) cancelCount();
});

els.view.addEventListener('click', (e) => {
  const target = e.target;
  if (target.closest('[data-start]')) startCount();
  else if (target.closest('[data-camera]')) scanWithCamera();
  else if (target.closest('[data-history]')) showHistory(target.closest('[data-history]').dataset.history);
  else if (target.closest('[data-count], [data-row]')) {
    // The whole row counts the product, not only its button
    const id = target.closest('[data-count]')?.dataset.count ?? target.closest('[data-row]').dataset.row;
    openCount(state.products.find((p) => p._id === id));
  } else if (target.closest('[data-category]')) {
    state.category = target.closest('[data-category]').dataset.category;
    renderChips();
    renderList();
  } else if (target.closest('[data-filter]')) {
    state.filter = target.closest('[data-filter]').dataset.filter;
    els.view.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
    renderList();
  }
});

els.view.addEventListener('input', (e) => {
  if (e.target.id !== 'countScan') return;
  state.query = e.target.value.trim();
  renderList();
});

els.view.addEventListener('keydown', (e) => {
  if (e.target.id !== 'countScan') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    handleScanEnter(e.target);
  } else if (e.key === 'Escape' && e.target.value) {
    e.target.value = '';
    state.query = '';
    renderList();
  }
});

document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// A barcode scanned while the focus is elsewhere still lands in the scan box
document.addEventListener('keydown', (e) => {
  if (!state.count || document.querySelector('dialog[open]')) return;
  const t = e.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
  if (typing || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  if (e.key === ' ' && t instanceof HTMLButtonElement) return;
  $('countScan')?.focus();
});

load().catch((err) => {
  els.view.innerHTML = `<div class="empty"><h3>تعذر تحميل الجرد</h3><p>${escapeHtml(err.message)}</p></div>`;
});
