import {
  api,
  toast,
  formatMoney,
  formatQty,
  formatWeight,
  formatDateTime,
  escapeHtml,
  roundMoney,
  roundQty,
  arCount,
  packName,
  refundMessage,
  INVOICES,
  dayQuery,
} from './common.js';
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
  payType: 'cash',
  customers: [],
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
  payButtons: document.querySelectorAll('[data-pay]'),
  paidLabel: $('paidLabel'),
  creditBox: $('creditBox'),
  customerInput: $('customerInput'),
  customerOptions: $('customerOptions'),
  creditNote: $('creditNote'),
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
  // Pick up price, name or box-size changes made on the products page
  for (const line of state.cart) {
    const product = state.byId.get(line.productId);
    if (product) Object.assign(line, lineFields(product, line.mode));
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
  // "3*code" adds 3; "0.5*code" half a kilo; "250غ*code" or "250g*code" 250 grams
  const match = /^(\d{1,5}(?:\.\d{1,3})?)\s*(g|غ|غم|غرام)?\s*[*xX×]\s*(.+)$/i.exec(text);
  if (!match) return { qty: 1, term: text };
  return { qty: match[2] ? Number(match[1]) / 1000 : Number(match[1]), term: match[3].trim() };
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
        ${p.hasWholesale ? `<span class="tile-wholesale">جملة <span class="num">${formatMoney(p.wholesalePrice)}</span></span>` : ''}
        <span class="tag num">${formatMoney(p.salePrice)}${p.unit === 'kg' ? ' / كغم' : ''}</span>
      </button>`,
    )
    .join('');
}

const stockAmount = (p, amount) => `${formatQty(amount)}${p.unit === 'kg' ? ' كغم' : ''}`;

function stockLine(p) {
  if (!p.trackStock) return '';
  const low = p.lowStockAlert ?? 5;
  if (p.stock <= 0) return '<span class="tile-stock is-out">نفدت الكمية</span>';
  return `<span class="tile-stock${p.stock <= low ? ' is-low' : ''}">متوفر <span class="num">${stockAmount(p, p.stock)}</span></span>`;
}

// Products set to block selling when out of stock cannot go past what is on the shelf.
// `base` is the total wanted in pieces or kg, wholesale boxes included.
function stockProblem(product, base) {
  if (!product.trackStock || !product.blockWhenOut || roundQty(base) <= product.stock) return null;
  return product.stock > 0
    ? `المتوفر من «${product.name}» ${stockAmount(product, product.stock)} فقط`
    : `نفدت كمية «${product.name}» من المخزن`;
}

/* Cart */

// A cart line sells one product either retail (per piece or kg) or wholesale (per box
// of pieces, or per bag of kg). qty and price are in the line's own unit.
const lineKey = (productId, mode) => `${productId}:${mode}`;
const isWeighed = (line) => line.unit === 'kg' && line.mode === 'retail';
// Weighed lines are typed in grams or kilograms; qty itself is always kg
const inGrams = (line) => isWeighed(line) && line.weightUnit !== 'kg';
const qtyStep = (line) => (inGrams(line) ? 0.01 : isWeighed(line) ? 0.25 : 1);

// The gram/kilo choice is remembered per product on this device (charcoal by the kilo,
// tobacco by the gram)
const WEIGHT_UNITS_KEY = 'pos.weightUnits';
function preferredWeightUnit(productId) {
  try {
    return JSON.parse(localStorage.getItem(WEIGHT_UNITS_KEY) ?? '{}')[productId] ?? 'g';
  } catch {
    return 'g';
  }
}
function rememberWeightUnit(productId, unit) {
  try {
    const units = JSON.parse(localStorage.getItem(WEIGHT_UNITS_KEY) ?? '{}');
    units[productId] = unit;
    localStorage.setItem(WEIGHT_UNITS_KEY, JSON.stringify(units));
  } catch {
    // Storage blocked: the choice just is not remembered
  }
}

function lineFields(product, mode) {
  const wholesale = mode === 'wholesale';
  return {
    name: product.name,
    unit: product.unit ?? 'piece',
    packSize: wholesale ? product.wholesaleQty : 1,
    price: wholesale ? product.wholesalePrice : product.salePrice,
  };
}

// Pieces or kg of a product already in the cart, leaving one line out
const baseInCart = (productId, exceptKey) =>
  state.cart.reduce((sum, l) => (l.productId === productId && l.key !== exceptKey ? sum + l.qty * l.packSize : sum), 0);

const cartTotal = () => roundMoney(state.cart.reduce((sum, l) => sum + l.price * l.qty, 0));

// Returns an error message instead of adding when the stock does not allow it
function addToCart(product, qty = 1, mode = 'retail') {
  const key = lineKey(product._id, mode);
  const line = state.cart.find((l) => l.key === key);
  const fields = lineFields(product, mode);
  const next = Math.min(roundQty((line?.qty ?? 0) + qty), MAX_QTY);
  const problem = stockProblem(product, baseInCart(product._id, key) + next * fields.packSize);
  if (problem) return problem;
  if (line) line.qty = next;
  else state.cart.push({ key, productId: product._id, mode, qty: next, weightUnit: preferredWeightUnit(product._id), ...fields });
  state.lastAdded = key;
  // A weighed product goes in as 1 kg; its quantity gets selected so the weight can be typed
  if (!line && isWeighed({ ...fields, mode })) state.focusQty = key;
  renderCart();
  return null;
}

function setQty(line, qty) {
  const weighed = isWeighed(line);
  const next = Math.min(Math.max(weighed ? 0.001 : 1, weighed ? roundQty(qty) : Math.round(qty)), MAX_QTY);
  const product = state.byId.get(line.productId);
  const problem = product && stockProblem(product, baseInCart(line.productId, line.key) + next * line.packSize);
  if (problem) toast(problem, 'error');
  else line.qty = next;
  renderCart();
}

// Switches a line between retail and wholesale, keeping its quantity and merging into
// an existing line of that kind
function setMode(line, mode) {
  const product = state.byId.get(line.productId);
  if (!product || line.mode === mode) return;
  const key = lineKey(product._id, mode);
  const other = state.cart.find((l) => l.key === key);
  const fields = lineFields(product, mode);
  const whole = mode === 'wholesale' || fields.unit === 'piece';
  const qty = Math.min(roundQty((other?.qty ?? 0) + (whole ? Math.max(1, Math.round(line.qty)) : line.qty)), MAX_QTY);
  const rest = baseInCart(product._id, key) - line.qty * line.packSize;
  const problem = stockProblem(product, rest + qty * fields.packSize);
  if (problem) {
    toast(problem, 'error');
    return;
  }
  if (other) {
    other.qty = qty;
    state.cart = state.cart.filter((l) => l !== line);
  } else {
    Object.assign(line, { key, mode, qty, weightUnit: line.weightUnit ?? preferredWeightUnit(product._id), ...fields });
  }
  state.lastAdded = key;
  renderCart();
}

function removeLine(line) {
  state.cart = state.cart.filter((l) => l !== line);
  renderCart();
}

// After adding: a weighed product waits for its weight, anything else goes back to scanning
function focusAfterAdd() {
  const key = state.focusQty;
  state.focusQty = null;
  const input = key && els.cartLines.querySelector(`[data-key="${key}"] [data-qty]`);
  if (input && finePointer) {
    input.focus();
    input.select();
  } else {
    focusScan();
  }
}

function lineHtml(l) {
  const name = escapeHtml(l.name);
  const weighed = isWeighed(l);
  const grams = inGrams(l);
  const pack = l.mode === 'wholesale' ? packName(l.unit, l.packSize) : weighed ? 'بالوزن' : '';
  const weightSwitch = weighed
    ? `<div class="mode-switch" role="group" aria-label="وحدة الوزن">
        <button type="button" data-weight-unit="g" aria-pressed="${grams}">غ</button>
        <button type="button" data-weight-unit="kg" aria-pressed="${!grams}">كغم</button>
      </div>`
    : '';
  const modeSwitch = state.byId.get(l.productId)?.hasWholesale
    ? `<div class="mode-switch" role="group" aria-label="نوع البيع">
        <button type="button" data-line-mode="retail" aria-pressed="${l.mode === 'retail'}">مفرد</button>
        <button type="button" data-line-mode="wholesale" aria-pressed="${l.mode === 'wholesale'}">جملة</button>
      </div>`
    : '';
  return `<li class="line${l.key === state.lastAdded ? ' is-new' : ''}" data-key="${l.key}">
    <div class="line-main">
      <span class="line-name">${name}${pack ? ` <small class="line-pack">${pack}</small>` : ''}</span>
      <span class="line-total num">${formatMoney(l.price * l.qty)}</span>
    </div>
    <div class="line-sub">
      <div class="qty" role="group" aria-label="كمية ${name}">
        <button type="button" class="qty-btn" data-inc aria-label="زيادة الكمية">+</button>
        <input class="qty-input num" type="number" min="${weighed && !grams ? 0.001 : 1}" max="${grams ? MAX_QTY * 1000 : MAX_QTY}" step="${weighed && !grams ? 'any' : 1}" value="${grams ? Math.round(l.qty * 1000) : l.qty}" data-qty aria-label="${grams ? 'الوزن بالغرام' : weighed ? 'الوزن بالكيلوغرام' : 'الكمية'}">
        <button type="button" class="qty-btn" data-dec aria-label="إنقاص الكمية"${l.qty <= qtyStep(l) ? ' disabled' : ''}>−</button>
      </div>
      ${weightSwitch}
      <span class="line-unit">× <span class="num">${formatMoney(l.price)}</span>${weighed ? ' للكيلو' : ''}</span>
      ${modeSwitch}
      <button type="button" class="line-remove" data-remove aria-label="حذف ${name} من الفاتورة" title="حذف من الفاتورة">×</button>
    </div>
  </li>`;
}

function renderCart() {
  const hasItems = state.cart.length > 0;
  els.cartLines.hidden = !hasItems;
  els.cartEmpty.hidden = hasItems;
  els.cartLines.innerHTML = state.cart.map(lineHtml).join('');
  // Pieces only (a box counts its pieces); weights are not pieces
  els.itemCount.textContent = formatQty(
    state.cart.reduce((sum, l) => (l.unit === 'kg' ? sum : sum + l.qty * l.packSize), 0),
  );
  els.grandTotal.textContent = formatMoney(cartTotal());
  if (state.lastAdded) {
    els.cartLines.querySelector(`[data-key="${state.lastAdded}"]`)?.scrollIntoView({ block: 'nearest' });
    state.lastAdded = null;
  }
  updatePayment();
}

function updatePayment() {
  const total = cartTotal();
  const raw = els.paid.value.trim();
  els.clear.disabled = !state.cart.length || state.busy;

  // Credit: what is not paid now goes on the customer's account
  if (state.payType === 'credit') {
    const paidNow = raw === '' ? 0 : Number(raw);
    const debt = roundMoney(total - paidNow);
    const invalid = !Number.isFinite(paidNow) || paidNow < 0 || (state.cart.length > 0 && debt <= 0);
    els.changeRow.classList.toggle('is-short', invalid);
    els.changeRow.classList.toggle('is-debt', !invalid);
    els.changeLabel.textContent = invalid ? 'المبلغ كامل، اختر «نقدًا»' : 'يُسجَّل دينًا';
    els.changeDue.textContent = formatMoney(Math.max(debt, 0));
    els.checkout.disabled = !state.cart.length || invalid || !els.customerInput.value.trim() || state.busy;
    updateCreditNote();
    return;
  }

  const paid = raw === '' ? total : Number(raw);
  const change = roundMoney(paid - total);
  const short = raw !== '' && (!Number.isFinite(paid) || change < 0);

  els.changeRow.classList.remove('is-debt');
  els.changeRow.classList.toggle('is-short', short);
  els.changeLabel.textContent = short ? 'المبلغ ناقص' : 'الباقي للزبون';
  els.changeDue.textContent = formatMoney(Number.isFinite(change) ? Math.abs(change) : total);
  els.checkout.disabled = !state.cart.length || short || state.busy;
  els.clear.disabled = !state.cart.length || state.busy;
}

/* Credit */

const customerLabel = (c) => (c.phone ? `${c.name} (${c.phone})` : c.name);

async function loadCustomers() {
  try {
    state.customers = await api('/customers');
    els.customerOptions.innerHTML = state.customers
      .map(
        (c) =>
          `<option value="${escapeHtml(customerLabel(c))}" label="${c.balance > 0 ? `عليه ${formatMoney(c.balance)}` : 'لا دين'}"></option>`,
      )
      .join('');
    updateCreditNote();
  } catch {
    // A name can still be typed; it is checked when the sale is completed
  }
}

// The typed text names a customer by its exact label, or by a name only one customer has
function typedCustomer() {
  const text = els.customerInput.value.trim();
  if (!text) return null;
  const byLabel = state.customers.find((c) => customerLabel(c) === text);
  if (byLabel) return byLabel;
  const sameName = state.customers.filter((c) => normalize(c.name) === normalize(text));
  return sameName.length === 1 ? sameName[0] : null;
}

function updateCreditNote() {
  const text = els.customerInput.value.trim();
  const customer = typedCustomer();
  els.creditNote.classList.toggle('is-new', Boolean(text && !customer));
  if (!text) els.creditNote.textContent = 'اختر زبونًا من القائمة أو اكتب اسمًا جديدًا';
  else if (customer) {
    els.creditNote.textContent = customer.balance > 0 ? `عليه حاليًا ${formatMoney(customer.balance)}` : 'لا دين عليه حاليًا';
  } else els.creditNote.textContent = `«${text}» زبون جديد، يُضاف عند إتمام البيع`;
}

function setPayType(type) {
  state.payType = type;
  const credit = type === 'credit';
  els.payButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pay === type)));
  els.creditBox.hidden = !credit;
  els.paidLabel.textContent = credit ? 'المدفوع الآن' : 'المدفوع';
  els.paid.placeholder = credit ? '0' : 'المبلغ بالضبط';
  els.paid.value = '';
  updatePayment();
  if (credit) els.customerInput.focus();
}

els.payButtons.forEach((b) => b.addEventListener('click', () => setPayType(b.dataset.pay)));
els.customerInput.addEventListener('input', updatePayment);
els.customerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    els.paid.focus();
  }
});

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
  if ((product.unit ?? 'piece') === 'piece' && !Number.isInteger(qty)) {
    scanError(`«${product.name}» يُباع بالقطعة، فاكتب عددًا صحيحًا`);
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
  focusAfterAdd();
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
  focusAfterAdd();
});

/* Cart interactions */

const lineFor = (el) => state.cart.find((l) => l.key === el.closest('.line')?.dataset.key);

els.cartLines.addEventListener('click', (e) => {
  const line = lineFor(e.target);
  if (!line) return;
  const weightButton = e.target.closest('[data-weight-unit]');
  if (weightButton) {
    line.weightUnit = weightButton.dataset.weightUnit;
    rememberWeightUnit(line.productId, line.weightUnit);
    state.focusQty = line.key; // ready to type the weight in the new unit
    renderCart();
    focusAfterAdd();
    return;
  }
  const modeButton = e.target.closest('[data-line-mode]');
  if (e.target.closest('[data-inc]')) setQty(line, line.qty + qtyStep(line));
  else if (e.target.closest('[data-dec]')) setQty(line, line.qty - qtyStep(line));
  else if (e.target.closest('[data-remove]')) removeLine(line);
  else if (modeButton) setMode(line, modeButton.dataset.lineMode);
  else return;
  focusScan();
});

els.cartLines.addEventListener('change', (e) => {
  if (!e.target.matches('[data-qty]')) return;
  const line = lineFor(e.target);
  const value = Number(e.target.value);
  const qty = inGrams(line) ? value / 1000 : value;
  // An empty or invalid entry keeps the previous quantity
  setQty(line, Number.isFinite(qty) && qty > 0 ? qty : line.qty);
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
  const credit = state.payType === 'credit';
  let customer = credit ? typedCustomer() : null;
  // A name typed at the cashier that is not a customer yet is added on the spot
  if (credit && !customer) {
    const name = els.customerInput.value.trim();
    if (!confirm(`«${name}» ليس في قائمة الزبائن. إضافته كزبون جديد وتسجيل الدين عليه؟`)) return;
    try {
      customer = await api('/customers', { method: 'POST', body: { name } });
      state.customers.push(customer);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  state.busy = true;
  updatePayment();
  try {
    const sale = await api('/sales', {
      method: 'POST',
      body: {
        items: state.cart.map((l) => ({ productId: l.productId, quantity: l.qty, mode: l.mode })),
        paid: raw === '' ? undefined : Number(raw),
        ...(credit ? { paymentType: 'credit', customerId: customer._id } : {}),
      },
    });
    state.cart = [];
    els.paid.value = '';
    if (credit) {
      els.customerInput.value = '';
      setPayType('cash');
      loadCustomers();
    }
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

// "9,000 للعلبة (10 قطع)", "1,000 للكيلو", "250 للقطعة"
function receiptPrice(item) {
  const price = `<span class="num">${formatMoney(item.unitPrice)}</span>`;
  if (item.mode === 'wholesale') return `${price} لل${packName(item.unit, item.packSize)}`;
  return `${price} ${item.unit === 'kg' ? 'للكيلو' : 'للقطعة'}`;
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
          <td>${escapeHtml(i.name)}<small>${receiptPrice(i)}</small></td>
          <td class="end num">${i.unit === 'kg' && i.mode !== 'wholesale' ? formatWeight(i.quantity) : formatQty(i.quantity)}</td>
          <td class="end num">${formatMoney(i.lineTotal)}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>
    <dl class="slip-sum">
      <div class="grand"><dt>الإجمالي</dt><dd class="num">${formatMoney(sale.total)}</dd></div>
      ${
        sale.paymentType === 'credit'
          ? `<div><dt>بالدين على</dt><dd>${escapeHtml(sale.customerName)}</dd></div>
            <div><dt>المدفوع الآن</dt><dd class="num">${formatMoney(sale.paid)}</dd></div>
            <div><dt>أُضيف إلى الدين</dt><dd class="num">${formatMoney(sale.debt)}</dd></div>
            <div><dt>مجموع دينه الآن</dt><dd class="num">${formatMoney(sale.customerBalance)}</dd></div>`
          : `<div><dt>المدفوع</dt><dd class="num">${formatMoney(sale.paid)}</dd></div>
            <div><dt>الباقي</dt><dd class="num">${formatMoney(sale.change)}</dd></div>`
      }
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
  const question =
    sale?.paymentType === 'credit'
      ? `إلغاء الفاتورة رقم ${sale.number} وحذف ${formatMoney(sale.debt)} من دين ${sale.customerName}؟`
      : `إلغاء الفاتورة رقم ${sale?.number} وإرجاع ${formatMoney(sale?.total)} للزبون؟`;
  if (!sale || !confirm(question)) return;
  // Close first: toasts cannot show above an open modal
  els.saleDialog.close();
  try {
    const { refunded, toAccount, customerName } = await api(`/sales/${sale._id}/returns`, { method: 'POST', body: {} });
    toast(`أُلغيت الفاتورة رقم ${sale.number}. ${refundMessage(refunded, toAccount, customerName)}`);
    if (toAccount) loadCustomers();
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
loadCustomers();
