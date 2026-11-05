import {
  api,
  toast,
  formatMoney,
  formatQty,
  formatDateTime,
  escapeHtml,
  roundMoney,
  roundUpTo,
  lineAmount,
  priceAddsUp,
  parseNumber,
  latinDigits,
  roundQty,
  arCount,
  packName,
  refundMessage,
  INVOICES,
  dayQuery,
  shopInfo,
  refreshShop,
  newClientId,
  withSignIn,
  session,
  can,
} from './common.js';
import { scanBarcodes } from './scanner.js';
import { isSaleOf } from './idempotency.js';
import { receiptHtml, prepareReceipt, printPrepared, clearReceipt } from './receipt.js';

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
  // The shop's settings for the receipt and its printing (GET /api/shop), its logo, and the
  // step sale lines are rounded up to (roundingStep, 0 when the shop does not round)
  shop: { shopName: '', receiptNote: '', phone: '', address: '', currency: '', receiptPaper: '80', receiptShowPhone: true, receiptShowAddress: true, receiptShowCashier: false, autoPrint: false, roundingStep: 0 },
  logo: '',
  logoVersion: '',
  catalogLoaded: false,
  // The id of the sale this cart becomes, made with its first item and sent with every try
  // to complete it, so trying again after a lost answer never records it twice
  clientSaleId: null,
};
// The shop's «أصغر فئة نقدية» as this screen last read it; the server rounds by its own
const step = () => state.shop.roundingStep || 0;

// A step changed by the owner shows at once on the tiles and the cart. The logo is fetched
// on its own (GET /api/shop/logo), and again only when it changed.
async function applyShop(shop) {
  if (!shop) return;
  const stepChanged = (shop.roundingStep || 0) !== step();
  state.shop = shop;
  if (stepChanged) {
    if (state.catalogLoaded) renderTiles();
    renderCart();
  }
  if (shop.logoVersion === state.logoVersion) return;
  try {
    state.logo = shop.logoVersion ? (await api('/shop/logo')).receiptLogo : '';
    state.logoVersion = shop.logoVersion;
  } catch {
    // offline: the receipt shows the logo it had, or none
  }
}
shopInfo.then(applyShop);

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
  saleNote: $('saleNote'),
  newSale: $('newSaleBtn'),
  print: $('printBtn'),
  cancelSale: $('cancelSaleBtn'),
  payButtons: document.querySelectorAll('[data-pay]'),
  paidLabel: $('paidLabel'),
  creditBox: $('creditBox'),
  customerInput: $('customerInput'),
  customerSuggest: $('customerSuggest'),
  creditNote: $('creditNote'),
  cartBar: $('cartBar'),
  cartBarCount: $('cartBarCount'),
  cartBarTotal: $('cartBarTotal'),
  sheetClose: $('sheetClose'),
};

// Phones and tablets show the invoice as a panel over the products (see style.css)
function openInvoiceSheet(open) {
  document.body.classList.toggle('cart-open', open);
  els.cartBar.setAttribute('aria-expanded', String(open));
}
els.cartBar.addEventListener('click', () => openInvoiceSheet(true));
els.sheetClose.addEventListener('click', () => openInvoiceSheet(false));

const focusScan = () => finePointer && els.scan.focus();

// Treat أ/إ/آ as ا, ة as ه, ى as ي and ignore diacritics when searching names
const normalize = (s) =>
  s.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ً-ْ]/g, '');

/* Catalog */

async function loadCatalog() {
  // With the shop's settings, so the tiles show their prices rounded from the start
  const [products, categories] = await Promise.all([api('/products'), api('/categories'), shopInfo]);
  state.catalogLoaded = true;
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

// Today's sales in the top bar, for an account that sees the sales figures (`reports`)
async function loadToday() {
  await session;
  if (!can('reports')) {
    els.today.textContent = '';
    return;
  }
  try {
    const { summary } = await api(`/sales?${dayQuery(new Date())}`);
    els.today.innerHTML = `مبيعات اليوم <strong class="num">${formatMoney(summary.total)}</strong> (${arCount(summary.count, INVOICES)})`;
  } catch {
    els.today.textContent = '';
  }
}

function parseScan(raw) {
  // Arabic-Indic digits count too: "٣*code" adds 3
  const text = latinDigits(raw).trim();
  // "3*code" adds 3; "0.5*code" half a kilo; "250غ*code" or "250g*code" 250 grams
  const match = /^(\d{1,5}(?:\.\d{1,3})?)\s*(g|غ|غم|غرام)?\s*[*xX×]\s*(.+)$/i.exec(text);
  if (!match) return { qty: 1, term: text };
  return { qty: roundQty(match[2] ? Number(match[1]) / 1000 : Number(match[1])), term: match[3].trim() };
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
      <a class="btn btn-primary" href="/" data-need="products">الذهاب إلى المنتجات</a>
    </div>`;
    return;
  }
  const list = visibleProducts();
  if (!list.length) {
    els.tiles.innerHTML = `<div class="empty"><p>لا يوجد منتج يطابق «${escapeHtml(state.query.trim())}».</p></div>`;
    return;
  }
  // What one piece or one box sells for, rounded up as a line of one is; a weight keeps its
  // price per kg (the line it makes is rounded)
  els.tiles.innerHTML = list
    .map(
      (p) => `<button type="button" class="tile" data-id="${p._id}">
        <span class="tile-name">${escapeHtml(p.name)}</span>
        <span class="tile-code num">${escapeHtml(p.barcode)}</span>
        ${stockLine(p)}
        ${p.hasWholesale ? `<span class="tile-wholesale">جملة <span class="num">${formatMoney(roundUpTo(p.wholesalePrice, step()))}</span></span>` : ''}
        <span class="tag num">${p.unit === 'kg' ? `${formatMoney(p.salePrice)} / كغم` : formatMoney(roundUpTo(p.salePrice, step()))}</span>
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

// Line by line, like the server: each line is rounded to the cent, and up to the shop's
// «أصغر فئة نقدية» when it rounds, before adding up
const lineTotal = (l) => lineAmount(l.price, l.qty, step());
const cartTotal = () => roundMoney(state.cart.reduce((sum, l) => sum + lineTotal(l), 0));

// Returns an error message instead of adding when the stock does not allow it
function addToCart(product, qty = 1, mode = 'retail') {
  if (!(qty > 0)) return 'الكمية يجب أن تكون أكبر من صفر';
  const key = lineKey(product._id, mode);
  const line = state.cart.find((l) => l.key === key);
  const fields = lineFields(product, mode);
  const next = Math.min(roundQty((line?.qty ?? 0) + qty), MAX_QTY);
  const problem = stockProblem(product, baseInCart(product._id, key) + next * fields.packSize);
  if (problem) return problem;
  // A new cart is a new sale, priced with the rounding as the owner set it now
  if (!state.cart.length) {
    state.clientSaleId = newClientId();
    refreshShop().then(applyShop);
  }
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
      <span class="line-total num">${formatMoney(lineTotal(l))}</span>
    </div>
    <div class="line-sub">
      <div class="qty" role="group" aria-label="كمية ${name}">
        <button type="button" class="qty-btn" data-inc aria-label="زيادة الكمية">+</button>
        <input class="qty-input num" type="number" min="${weighed && !grams ? 0.001 : 1}" max="${grams ? MAX_QTY * 1000 : MAX_QTY}" step="${weighed && !grams ? 'any' : 1}" value="${grams ? Math.round(l.qty * 1000) : l.qty}" data-qty aria-label="${grams ? 'الوزن بالغرام' : weighed ? 'الوزن بالكيلوغرام' : 'الكمية'}">
        <button type="button" class="qty-btn" data-dec aria-label="إنقاص الكمية"${l.qty <= qtyStep(l) ? ' disabled' : ''}>−</button>
      </div>
      ${weightSwitch}
      ${priceAddsUp(l.price, l.qty, lineTotal(l)) ? `<span class="line-unit">× <span class="num">${formatMoney(l.price)}</span>${weighed ? ' للكيلو' : ''}</span>` : ''}
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
  els.cartBarCount.textContent = state.cart.length;
  els.cartBarTotal.textContent = formatMoney(cartTotal());
  els.cartBar.classList.toggle('is-empty', !hasItems);
  if (state.lastAdded) {
    els.cartLines.querySelector(`[data-key="${state.lastAdded}"]`)?.scrollIntoView({ block: 'nearest' });
    state.lastAdded = null;
  }
  updatePayment();
}

function updatePayment() {
  const total = cartTotal();
  const raw = els.paid.value.trim();
  // Arabic digits and separators ("١٬٠٠٠", "1,000") still read; anything else is invalid, never 0
  const typed = raw === '' ? null : roundMoney(parseNumber(raw));
  els.clear.disabled = !state.cart.length || state.busy;

  // Credit: what is not paid now goes on the customer's account
  if (state.payType === 'credit') {
    const paidNow = typed ?? 0;
    const debt = roundMoney(total - paidNow);
    const invalid = !Number.isFinite(paidNow) || paidNow < 0 || (state.cart.length > 0 && debt <= 0);
    els.changeRow.classList.toggle('is-short', invalid);
    els.changeRow.classList.toggle('is-debt', !invalid);
    els.changeLabel.textContent = !Number.isFinite(paidNow)
      ? 'اكتب المبلغ بالأرقام'
      : invalid
        ? 'المبلغ كامل، اختر «نقدًا»'
        : 'يُسجَّل دينًا';
    els.changeDue.textContent = formatMoney(Number.isFinite(debt) ? Math.max(debt, 0) : total);
    els.checkout.disabled = !state.cart.length || invalid || !els.customerInput.value.trim() || state.busy;
    updateCreditNote();
    return;
  }

  const paid = typed ?? total;
  const change = roundMoney(paid - total);
  const short = raw !== '' && (!Number.isFinite(paid) || change < 0);

  els.changeRow.classList.remove('is-debt');
  els.changeRow.classList.toggle('is-short', short);
  els.changeLabel.textContent = !Number.isFinite(paid) ? 'اكتب المبلغ بالأرقام' : short ? 'المبلغ ناقص' : 'الباقي للزبون';
  els.changeDue.textContent = formatMoney(Number.isFinite(change) ? Math.abs(change) : total);
  els.checkout.disabled = !state.cart.length || short || state.busy;
  els.clear.disabled = !state.cart.length || state.busy;
  saveCart();
}

/* The cart kept in this tab */

// In sessionStorage with its sale id, so a reload, a session that ended or the shop being
// paused loses nothing; it goes once the sale is completed or the invoice cancelled
const CART_KEY = 'pos.cart';

function saveCart() {
  try {
    if (!state.cart.length) {
      sessionStorage.removeItem(CART_KEY);
      return;
    }
    sessionStorage.setItem(
      CART_KEY,
      JSON.stringify({ cart: state.cart, clientSaleId: state.clientSaleId, payType: state.payType, customer: els.customerInput.value, paid: els.paid.value }),
    );
  } catch {
    // Storage blocked: the cart lives as long as the page
  }
}

function restoreCart() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(CART_KEY));
  } catch {
    return;
  }
  const lines = Array.isArray(saved?.cart) ? saved.cart.filter((l) => typeof l?.productId === 'string' && typeof l.key === 'string' && Number(l.qty) > 0) : [];
  if (!lines.length) return;
  state.cart = lines;
  state.clientSaleId = typeof saved.clientSaleId === 'string' ? saved.clientSaleId : newClientId();
  if (saved.payType === 'credit' && can('credit')) {
    setPayType('credit');
    els.customerInput.value = String(saved.customer ?? '');
  }
  els.paid.value = String(saved.paid ?? '');
  renderCart();
}

/* Credit */

const customerLabel = (c) => (c.phone ? `${c.name} (${c.phone})` : c.name);

// Only for selling on credit (`credit`). A cart restored on credit before the account was
// known (or after the owner took `credit` away) goes back to cash, or the hidden «نقدًا»
// could not be pressed and the sale would only be refused.
async function loadCustomers() {
  await session;
  if (!can('credit')) {
    if (state.payType === 'credit') setPayType('cash');
    return;
  }
  try {
    state.customers = await api('/customers');
    if (document.activeElement === els.customerInput) renderSuggestions();
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
// Our own suggestion list: a <datalist> barely works on Android, where names did not
// show while typing
const suggest = { matches: [], active: -1 };

function renderSuggestions() {
  const text = els.customerInput.value.trim();
  // Coming back to an already picked customer shows everyone again, to switch easily
  const q = state.customers.some((c) => customerLabel(c) === text) ? '' : normalize(text);
  const pool = [...state.customers].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, 'ar'));
  suggest.matches = (q ? pool.filter((c) => normalize(c.name).includes(q) || (c.phone ?? '').includes(q)) : pool).slice(0, 8);
  suggest.active = -1;
  const open = suggest.matches.length > 0;
  els.customerSuggest.hidden = !open;
  els.customerInput.setAttribute('aria-expanded', String(open));
  els.customerInput.removeAttribute('aria-activedescendant');
  els.customerSuggest.innerHTML = suggest.matches
    .map(
      (c, i) => `<li role="option" id="customer-option-${i}">
        <button type="button" class="combo-option" data-index="${i}" tabindex="-1">
          <span>${escapeHtml(c.name)}${c.phone ? `<small class="num">${escapeHtml(c.phone)}</small>` : ''}</span>
          <span class="debt-chip ${c.balance > 0 ? 'owes' : 'clear'} num">${c.balance > 0 ? formatMoney(c.balance) : 'لا دين'}</span>
        </button>
      </li>`,
    )
    .join('');
}

function closeSuggestions() {
  els.customerSuggest.hidden = true;
  els.customerInput.setAttribute('aria-expanded', 'false');
}

function highlightSuggestion(index) {
  suggest.active = index;
  els.customerSuggest.querySelectorAll('.combo-option').forEach((b, i) => b.classList.toggle('is-active', i === index));
  els.customerInput.setAttribute('aria-activedescendant', `customer-option-${index}`);
  els.customerSuggest.children[index]?.scrollIntoView({ block: 'nearest' });
}

function chooseCustomer(customer) {
  els.customerInput.value = customerLabel(customer);
  closeSuggestions();
  updatePayment();
  // On phones drop the keyboard instead, so the sale button is in sight
  if (finePointer) els.paid.focus();
  else els.customerInput.blur();
}

els.customerInput.addEventListener('focus', renderSuggestions);
els.customerInput.addEventListener('input', () => {
  renderSuggestions();
  updatePayment();
});
// Let a tap on a suggestion land before the list closes
els.customerInput.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
els.customerSuggest.addEventListener('pointerdown', (e) => e.preventDefault());
els.customerSuggest.addEventListener('click', (e) => {
  const option = e.target.closest('[data-index]');
  if (option) chooseCustomer(suggest.matches[Number(option.dataset.index)]);
});
els.customerInput.addEventListener('keydown', (e) => {
  const open = !els.customerSuggest.hidden;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    highlightSuggestion((suggest.active + step + suggest.matches.length) % suggest.matches.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && suggest.active >= 0) chooseCustomer(suggest.matches[suggest.active]);
    else els.paid.focus();
  } else if (e.key === 'Escape' && open) {
    e.stopPropagation(); // close the list, not the invoice panel
    closeSuggestions();
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
  state.clientSaleId = null;
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
      customer = await withSignIn(() => api('/customers', { method: 'POST', body: { name } }));
      state.customers.push(customer);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  state.busy = true;
  state.clientSaleId ??= newClientId();
  const sentId = state.clientSaleId;
  const shownTotal = cartTotal();
  const shownStep = step();
  updatePayment();
  const body = {
    items: state.cart.map((l) => ({ productId: l.productId, quantity: l.qty, mode: l.mode })),
    paid: raw === '' ? undefined : roundMoney(parseNumber(raw)),
    ...(credit ? { paymentType: 'credit', customerId: customer._id } : {}),
    clientId: state.clientSaleId,
  };
  try {
    // A session that ended asks to sign in here, then the same sale is sent again: with the
    // same id it is recorded once, whatever happened to the first try
    const sale = await withSignIn(() => api('/sales', { method: 'POST', body }));
    if (!isSaleOf(body, sale)) {
      // Another cart under the same id was sold before (a try whose answer was lost, then a
      // change; or a tab duplicated with its cart): this one is not sold. It stays, with an
      // id of its own, for the cashier to check against that invoice.
      state.clientSaleId = newClientId();
      saveCart();
      loadToday();
      alert(`سُجّلت الفاتورة رقم ${sale.number} من قبل بأصناف غير أصناف السلة الحالية، ولم تُبَع هذه السلة بعد. راجع الفاتورة رقم ${sale.number} في صفحة المبيعات، واحذف من السلة ما بيع فيها، ثم أتمم البيع.`);
      return;
    }
    state.cart = [];
    state.clientSaleId = null;
    els.paid.value = '';
    if (credit) {
      els.customerInput.value = '';
      setPayType('cash');
      loadCustomers();
    }
    renderCart();
    openInvoiceSheet(false);
    // The receipt has the server's figures. Rounded otherwise than the cart was (the owner
    // changed the rounding while it was open), its total is said beside it, to collect.
    const reRounded = sale.total !== shownTotal && (sale.roundingStep ?? 0) !== shownStep;
    els.saleNote.textContent = reRounded ? `سُجّلت الفاتورة بإجمالي ${formatMoney(sale.total)} لا ${formatMoney(shownTotal)}، لأن تقريب الأسعار تغيّر من الإعدادات.` : '';
    els.saleNote.hidden = !reRounded;
    showReceipt(sale, sentId);
    loadToday();
    loadCatalog().catch(() => {}); // stock went down
    // and the rounding, so the next cart shows what the server charges
    if (reRounded) refreshShop().then(applyShop);
  } catch (err) {
    // The cart stays as it is, its id too, ready to be sent again
    let message = err.code === 'TENANT_SUSPENDED' ? 'المتجر موقوف مؤقتًا، ولم يُسجَّل البيع. الفاتورة باقية كما هي' : err.message;
    if (err.code !== 'TENANT_SUSPENDED' && err.code !== 'NETWORK') loadCatalog().catch(() => {});
    // A paid amount refused against a total this screen did not show: the owner changed the
    // rounding meanwhile. The cart then shows the new total, to check the amount by.
    if (err.status === 400) {
      const before = step();
      await applyShop(await refreshShop());
      if (step() !== before) message = `تغيّر تقريب الأسعار من الإعدادات، فصار إجمالي الفاتورة ${formatMoney(cartTotal())}. راجع المبلغ ثم أتمم البيع`;
    }
    toast(message, 'error');
  } finally {
    state.busy = false;
    updatePayment();
  }
}

/*
 * The sales whose receipt this tab printed by itself, by their id (clientId), in
 * sessionStorage so that a reload or a duplicated tab knows them too. The server marks the
 * answer to a sale sent again `repeated`, but that is also the answer to a sale whose first
 * answer was lost on the way (the network dropped after the sale was recorded, and the
 * cashier pressed «إتمام البيع» again): its receipt never showed, so it is printed then.
 */
const PRINTED_KEY = 'pos.printed';
const PRINTED_KEEP = 20;
// And in memory, for where storage is blocked
const printedHere = new Set();

function printedBefore(id) {
  try {
    return JSON.parse(sessionStorage.getItem(PRINTED_KEY) ?? '[]').includes(id);
  } catch {
    return false;
  }
}

function markPrinted(id) {
  try {
    const ids = JSON.parse(sessionStorage.getItem(PRINTED_KEY) ?? '[]');
    sessionStorage.setItem(PRINTED_KEY, JSON.stringify([...(Array.isArray(ids) ? ids : []), id].slice(-PRINTED_KEEP)));
  } catch {
    // Storage blocked: printedHere has it
  }
}

/*
 * The receipt of a completed sale (receipt.js), ready to print as soon as it shows: by the
 * button, by the keyboard, or by itself once per sale when the owner turned «طباعة تلقائية»
 * on: never again for a sale this tab printed already (sent twice, `sentId` the id it was
 * sent with). A failed sale or a return shows no receipt at all.
 */
function showReceipt(sale, sentId) {
  state.lastSale = sale;
  const html = receiptHtml(sale, state.shop, state.logo);
  els.saleReceipt.innerHTML = html;
  els.saleDialog.showModal();
  els.newSale.focus();
  prepareReceipt(html, state.shop.receiptPaper);
  if (!state.shop.autoPrint || printedHere.has(sentId) || printedBefore(sentId)) return;
  printedHere.add(sentId);
  markPrinted(sentId);
  printPrepared();
}

els.newSale.addEventListener('click', () => els.saleDialog.close());
els.print.addEventListener('click', () => printPrepared());
els.cancelSale.addEventListener('click', async () => {
  const sale = state.lastSale;
  const question =
    sale?.paymentType === 'credit'
      ? `إلغاء الفاتورة رقم ${sale.number}؟ يُخصم حتى ${formatMoney(sale.debt)} مما على ${sale.customerName}${
          sale.paid > 0 ? `، ويُعاد الباقي من ${formatMoney(sale.total)} نقدًا` : ''
        }، بحسب ما عليه الآن.`
      : `إلغاء الفاتورة رقم ${sale?.number} وإرجاع ${formatMoney(sale?.total)} للزبون؟`;
  if (!sale || !confirm(question)) return;
  // Close first: toasts cannot show above an open modal
  els.saleDialog.close();
  // One id for this cancellation: sent again, it gives back the money once
  const clientId = newClientId();
  try {
    const { refunded, toAccount, customerName } = await withSignIn(() => api(`/sales/${sale._id}/returns`, { method: 'POST', body: { clientId } }));
    toast(`أُلغيت الفاتورة رقم ${sale.number}. ${refundMessage(refunded, toAccount, customerName)}`);
    if (toAccount) loadCustomers();
    loadToday();
    loadCatalog().catch(() => {}); // stock came back
  } catch (err) {
    toast(err.message, 'error');
  }
});
els.saleDialog.addEventListener('close', () => {
  clearReceipt();
  focusScan();
});

/* Keyboard */

document.addEventListener('keydown', (e) => {
  // The receipt or camera window is open: leave keys to it
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape' && document.body.classList.contains('cart-open')) {
    openInvoiceSheet(false);
    return;
  }
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
    refreshShop().then(applyShop); // the receipt as the owner set it since
  }
});

const tick = () => (els.clock.textContent = formatDateTime(new Date()));
tick();
setInterval(tick, 30_000);

restoreCart();
loadCatalog().catch((err) => toast(err.message, 'error'));
loadToday();
loadCustomers();
