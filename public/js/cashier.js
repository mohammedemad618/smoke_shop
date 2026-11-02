import { api, toast, formatMoney, formatDateTime, escapeHtml, roundMoney, arCount, INVOICES, dayQuery } from './common.js';
import { scanBarcodes } from './scanner.js';

const MAX_QTY = 10000;
// On touch screens, refocusing the scan box would keep popping up the keyboard
const finePointer = matchMedia('(pointer: fine)').matches;

const state = {
  products: [],
  categories: [],
  byBarcode: new Map(),
  byId: new Map(),
  activeCategory: '',
  query: '',
  cart: [],
  lastAdded: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  scan: $('scanInput'),
  camera: $('cameraBtn'),
  chips: $('chips'),
  tiles: $('tiles'),
  cartLines: $('cartLines'),
  cartEmpty: $('cartEmpty'),
  itemCount: $('itemCount'),
  grandTotal: $('grandTotal'),
  paid: $('paidInput'),
  changeRow: $('changeRow'),
  changeLabel: $('changeLabel'),
  changeDue: $('changeDue'),
  checkout: $('checkoutBtn'),
  clear: $('clearBtn'),
  today: $('todayStats'),
  clock: $('clock'),
  saleDialog: $('saleDialog'),
  saleReceipt: $('saleReceipt'),
  newSale: $('newSaleBtn'),
  print: $('printBtn'),
  cancelSale: $('cancelSaleBtn'),
};

const focusScan = () => finePointer && els.scan.focus();

// Treat أ/إ/آ as ا, ة as ه, ى as ي and ignore diacritics when searching names
const normalize = (s) =>
  s.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ً-ْ]/g, '');

/* Catalog */

async function loadCatalog() {
  const [products, categories] = await Promise.all([api('/products'), api('/categories')]);
  state.products = products;
  state.categories = categories.filter((c) => c.productCount > 0);
  state.byBarcode = new Map(products.map((p) => [p.barcode, p]));
  state.byId = new Map(products.map((p) => [p._id, p]));
  if (state.activeCategory && !state.categories.some((c) => c._id === state.activeCategory)) {
    state.activeCategory = '';
  }
  // Pick up price or name changes made on the products page
  for (const line of state.cart) {
    const product = state.byId.get(line.productId);
    if (product) Object.assign(line, { name: product.name, price: product.salePrice });
  }
  renderChips();
  renderTiles();
  renderCart();
}

async function loadToday() {
  try {
    const { summary } = await api(`/sales?${dayQuery(new Date())}`);
    els.today.innerHTML = `مبيعات اليوم <strong class="num">${formatMoney(summary.total)}</strong> (${arCount(summary.count, INVOICES)})`;
  } catch {
    els.today.textContent = '';
  }
}

function parseScan(raw) {
  const text = raw.trim();
  const match = /^(\d{1,4})\s*[*xX×]\s*(.+)$/.exec(text);
  return match ? { qty: Number(match[1]), term: match[2].trim() } : { qty: 1, term: text };
}

function matchProducts(term) {
  const q = normalize(term);
  return state.products.filter((p) => normalize(p.name).includes(q) || p.barcode.includes(term));
}

function visibleProducts() {
  const { term } = parseScan(state.query);
  if (term) return matchProducts(term);
  if (state.activeCategory) return state.products.filter((p) => p.category?._id === state.activeCategory);
  return state.products;
}

function renderChips() {
  const chips = [{ _id: '', name: 'الكل' }, ...state.categories];
  els.chips.innerHTML = chips
    .map(
      (c) =>
        `<button type="button" class="chip" data-category="${c._id}" aria-pressed="${c._id === state.activeCategory}">${escapeHtml(c.name)}</button>`,
    )
    .join('');
}

function renderTiles() {
  if (!state.products.length) {
    els.tiles.innerHTML = `<div class="empty">
      <h3>لا توجد منتجات بعد</h3>
      <p>أضف الأقسام والمنتجات من صفحة المنتجات، ثم عد إلى هنا للبيع.</p>
      <a class="btn btn-primary" href="/">الذهاب إلى المنتجات</a>
    </div>`;
    return;
  }
  const list = visibleProducts();
  if (!list.length) {
    els.tiles.innerHTML = `<div class="empty"><p>لا يوجد منتج يطابق «${escapeHtml(state.query.trim())}».</p></div>`;
    return;
  }
  els.tiles.innerHTML = list
    .map(
      (p) => `<button type="button" class="tile" data-id="${p._id}">
        <span class="tile-name">${escapeHtml(p.name)}</span>
        <span class="tile-code num">${escapeHtml(p.barcode)}</span>
        ${stockLine(p)}
        <span class="tag num">${formatMoney(p.salePrice)}</span>
      </button>`,
    )
    .join('');
}

function stockLine(p) {
  if (!p.trackStock) return '';
  const low = p.lowStockAlert ?? 5;
  if (p.stock <= 0) return '<span class="tile-stock is-out">نفدت الكمية</span>';
  return `<span class="tile-stock${p.stock <= low ? ' is-low' : ''}">متوفر <span class="num">${p.stock}</span></span>`;
}

// Products set to block selling when out of stock cannot go past what is on the shelf
function stockProblem(product, qty) {
  if (!product.trackStock || !product.blockWhenOut || qty <= product.stock) return null;
  return product.stock > 0
    ? `المتوفر من «${product.name}» ${product.stock} فقط`
    : `نفدت كمية «${product.name}» من المخزن`;
}

/* Cart */

const cartTotal = () => roundMoney(state.cart.reduce((sum, l) => sum + l.price * l.qty, 0));

// Returns an error message instead of adding when the stock does not allow it
function addToCart(product, qty = 1) {
  const line = state.cart.find((l) => l.productId === product._id);
  const next = Math.min((line?.qty ?? 0) + qty, MAX_QTY);
  const problem = stockProblem(product, next);
  if (problem) return problem;
  if (line) line.qty = next;
  else state.cart.push({ productId: product._id, name: product.name, price: product.salePrice, qty: next });
  state.lastAdded = product._id;
  renderCart();
  return null;
}

function setQty(line, qty) {
  const next = Math.min(Math.max(1, qty), MAX_QTY);
  const product = state.byId.get(line.productId);
  const problem = product && stockProblem(product, next);
  if (problem) toast(problem, 'error');
  else line.qty = next;
  renderCart();
}

function removeLine(line) {
  state.cart = state.cart.filter((l) => l !== line);
  renderCart();
}

function lineHtml(l) {
  const name = escapeHtml(l.name);
  return `<li class="line${l.productId === state.lastAdded ? ' is-new' : ''}" data-id="${l.productId}">
    <div class="line-main">
      <span class="line-name">${name}</span>
      <span class="line-total num">${formatMoney(l.price * l.qty)}</span>
    </div>
    <div class="line-sub">
      <div class="qty" role="group" aria-label="كمية ${name}">
        <button type="button" class="qty-btn" data-inc aria-label="زيادة الكمية">+</button>
        <input class="qty-input num" type="number" min="1" max="${MAX_QTY}" step="1" value="${l.qty}" data-qty aria-label="الكمية">
        <button type="button" class="qty-btn" data-dec aria-label="إنقاص الكمية"${l.qty <= 1 ? ' disabled' : ''}>−</button>
      </div>
      <span class="line-unit">× <span class="num">${formatMoney(l.price)}</span></span>
      <button type="button" class="line-remove" data-remove aria-label="حذف ${name} من الفاتورة" title="حذف من الفاتورة">×</button>
    </div>
  </li>`;
}

function renderCart() {
  const hasItems = state.cart.length > 0;
  els.cartLines.hidden = !hasItems;
  els.cartEmpty.hidden = hasItems;
  els.cartLines.innerHTML = state.cart.map(lineHtml).join('');
  els.itemCount.textContent = formatMoney(state.cart.reduce((sum, l) => sum + l.qty, 0));
  els.grandTotal.textContent = formatMoney(cartTotal());
  if (state.lastAdded) {
    els.cartLines.querySelector(`[data-id="${state.lastAdded}"]`)?.scrollIntoView({ block: 'nearest' });
    state.lastAdded = null;
  }
  updatePayment();
}

function updatePayment() {
  const total = cartTotal();
  const raw = els.paid.value.trim();
  const paid = raw === '' ? total : Number(raw);
  const change = roundMoney(paid - total);
  const short = raw !== '' && (!Number.isFinite(paid) || change < 0);

  els.changeRow.classList.toggle('is-short', short);
  els.changeLabel.textContent = short ? 'المبلغ ناقص' : 'الباقي للزبون';
  els.changeDue.textContent = formatMoney(Number.isFinite(change) ? Math.abs(change) : total);
  els.checkout.disabled = !state.cart.length || short || state.busy;
  els.clear.disabled = !state.cart.length || state.busy;
}

/* Scanning */

async function fetchByBarcode(code) {
  try {
    const product = await api(`/products/barcode/${encodeURIComponent(code)}`);
    // Added on the products page after this screen loaded
    state.products.push(product);
    state.byBarcode.set(product.barcode, product);
    state.byId.set(product._id, product);
    return product;
  } catch {
    return null;
  }
}

async function findByBarcode(code) {
  return state.byBarcode.get(code) ?? (/\s/.test(code) ? null : fetchByBarcode(code));
}

function scanError(message) {
  toast(message, 'error');
  els.scan.classList.remove('is-error');
  void els.scan.offsetWidth; // restart the shake animation
  els.scan.classList.add('is-error');
  els.scan.select();
}

async function handleScan() {
  const { qty, term } = parseScan(els.scan.value);
  if (!term) return;

  let product = await findByBarcode(term);
  if (!product) {
    const matches = matchProducts(term);
    if (matches.length === 1) [product] = matches;
    else if (matches.length > 1) {
      scanError('أكثر من منتج يطابق البحث، اختر المنتج من القائمة');
      return;
    }
  }
  if (!product) {
    scanError(`لا يوجد منتج بالباركود أو الاسم «${term}»`);
    return;
  }

  const problem = addToCart(product, qty);
  if (problem) {
    scanError(problem);
    return;
  }
  els.scan.value = '';
  els.scan.classList.remove('is-error');
  state.query = '';
  renderTiles();
}

els.scan.addEventListener('input', () => {
  state.query = els.scan.value;
  els.scan.classList.remove('is-error');
  renderTiles();
});

els.scan.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleScan();
  } else if (e.key === 'Escape' && els.scan.value) {
    els.scan.value = '';
    state.query = '';
    renderTiles();
  }
});

els.camera.addEventListener('click', async () => {
  await scanBarcodes(async (code) => {
    const product = await findByBarcode(code);
    if (!product) return { ok: false, message: `لا يوجد منتج بالباركود ${code}` };
    const problem = addToCart(product);
    if (problem) return { ok: false, message: problem };
    return { ok: true, message: `أُضيف «${product.name}». الإجمالي ${formatMoney(cartTotal())}` };
  });
  focusScan();
});

els.chips.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-category]');
  if (!chip) return;
  state.activeCategory = chip.dataset.category;
  state.query = '';
  els.scan.value = '';
  renderChips();
  renderTiles();
  focusScan();
});

els.tiles.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const problem = addToCart(state.byId.get(tile.dataset.id));
  if (problem) {
    toast(problem, 'error');
    focusScan();
    return;
  }
  tile.classList.remove('is-added');
  void tile.offsetWidth;
  tile.classList.add('is-added');
  if (state.query) {
    state.query = '';
    els.scan.value = '';
    renderTiles();
  }
  focusScan();
});

/* Cart interactions */

const lineFor = (el) => state.cart.find((l) => l.productId === el.closest('.line')?.dataset.id);

els.cartLines.addEventListener('click', (e) => {
  const line = lineFor(e.target);
  if (!line) return;
  if (e.target.closest('[data-inc]')) setQty(line, line.qty + 1);
  else if (e.target.closest('[data-dec]')) setQty(line, line.qty - 1);
  else if (e.target.closest('[data-remove]')) removeLine(line);
  else return;
  focusScan();
});

els.cartLines.addEventListener('change', (e) => {
  if (!e.target.matches('[data-qty]')) return;
  const qty = Math.floor(Number(e.target.value));
  setQty(lineFor(e.target), Number.isFinite(qty) ? qty : 1);
  focusScan();
});

els.clear.addEventListener('click', () => {
  if (!state.cart.length || !confirm('إلغاء الفاتورة الحالية وحذف كل أصنافها؟')) return;
  state.cart = [];
  els.paid.value = '';
  renderCart();
  focusScan();
});

/* Payment */

els.paid.addEventListener('input', updatePayment);
els.paid.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    checkout();
  } else if (e.key === 'Escape') {
    els.scan.focus();
  }
});
els.checkout.addEventListener('click', checkout);

async function checkout() {
  if (els.checkout.disabled) return;
  const raw = els.paid.value.trim();
  state.busy = true;
  updatePayment();
  try {
    const sale = await api('/sales', {
      method: 'POST',
      body: {
        items: state.cart.map((l) => ({ productId: l.productId, quantity: l.qty })),
        paid: raw === '' ? undefined : Number(raw),
      },
    });
    state.cart = [];
    els.paid.value = '';
    renderCart();
    showReceipt(sale);
    loadToday();
    loadCatalog().catch(() => {}); // stock went down
  } catch (err) {
    toast(err.message, 'error');
    loadCatalog().catch(() => {});
  } finally {
    state.busy = false;
    updatePayment();
  }
}

function showReceipt(sale) {
  state.lastSale = sale;
  els.saleReceipt.innerHTML = `<div class="slip">
    <div class="slip-head">
      <strong>نقطة البيع</strong>
      <span>فاتورة رقم <span class="num">${sale.number}</span></span>
      <span>${formatDateTime(sale.createdAt)}</span>
    </div>
    <table class="slip-items">
      <thead><tr><th>الصنف</th><th class="end">الكمية</th><th class="end">المبلغ</th></tr></thead>
      <tbody>${sale.items
        .map(
          (i) => `<tr>
          <td>${escapeHtml(i.name)}<small><span class="num">${formatMoney(i.unitPrice)}</span> للقطعة</small></td>
          <td class="end num">${i.quantity}</td>
          <td class="end num">${formatMoney(i.lineTotal)}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>
    <dl class="slip-sum">
      <div class="grand"><dt>الإجمالي</dt><dd class="num">${formatMoney(sale.total)}</dd></div>
      <div><dt>المدفوع</dt><dd class="num">${formatMoney(sale.paid)}</dd></div>
      <div><dt>الباقي</dt><dd class="num">${formatMoney(sale.change)}</dd></div>
    </dl>
    <p class="slip-foot">شكرًا لزيارتكم</p>
  </div>`;
  els.saleDialog.showModal();
  els.newSale.focus();
}

els.newSale.addEventListener('click', () => els.saleDialog.close());
els.print.addEventListener('click', () => window.print());
els.cancelSale.addEventListener('click', async () => {
  const sale = state.lastSale;
  if (!sale || !confirm(`إلغاء الفاتورة رقم ${sale.number} وإرجاع ${formatMoney(sale.total)} للزبون؟`)) return;
  // Close first: toasts cannot show above an open modal
  els.saleDialog.close();
  try {
    const { refunded } = await api(`/sales/${sale._id}/returns`, { method: 'POST', body: {} });
    toast(`أُلغيت الفاتورة رقم ${sale.number}. أعد للزبون ${formatMoney(refunded)}`);
    loadToday();
    loadCatalog().catch(() => {}); // stock came back
  } catch (err) {
    toast(err.message, 'error');
  }
});
els.saleDialog.addEventListener('close', focusScan);

/* Keyboard */

document.addEventListener('keydown', (e) => {
  // The receipt or camera window is open: leave keys to it
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'F2') {
    e.preventDefault();
    if (state.cart.length) {
      els.paid.focus();
      els.paid.select();
    }
    return;
  }
  // Send stray typing (e.g. a scan after clicking a button) to the scan box
  const t = e.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
  if (typing || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  if (e.key === ' ' && t instanceof HTMLButtonElement) return;
  els.scan.focus();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadCatalog().catch(() => {});
    loadToday();
  }
});

const tick = () => (els.clock.textContent = formatDateTime(new Date()));
tick();
setInterval(tick, 30_000);

loadCatalog().catch((err) => toast(err.message, 'error'));
loadToday();
