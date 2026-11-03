import { api, toast, formatMoney, formatQty, escapeHtml, arCount, packName, PRODUCTS } from './common.js';
import { randomStoreBarcode } from './barcode.js';
import { scanBarcode } from './scanner.js';

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
};

const state = {
  categories: [],
  products: [],
  activeCategory: '',
  query: '',
  editingId: null,
  // The stock shown in the edit window, to tell whether it was changed
  editingStock: null,
  renamingId: null,
  // Which part of the stock is shown, and in what order (see STOCK_FILTERS and SORTS)
  stockFilter: '',
  sort: 'name',
};

const $ = (id) => document.getElementById(id);
const els = {
  categoryForm: $('categoryForm'),
  categoryList: $('categoryList'),
  title: $('catalogTitle'),
  count: $('catalogCount'),
  search: $('searchInput'),
  addProduct: $('addProductBtn'),
  area: $('productsArea'),
  stockFilter: $('stockFilter'),
  sort: $('sortSelect'),
  dialog: $('productDialog'),
  form: $('productForm'),
  dialogTitle: $('productDialogTitle'),
  error: $('productError'),
  marginNote: $('marginNote'),
  saveNext: $('saveNextBtn'),
  generate: $('genBarcodeBtn'),
  camera: $('cameraScanBtn'),
  cancel: $('cancelProductBtn'),
};
const fields = {
  barcode: $('fBarcode'),
  name: $('fName'),
  category: $('fCategory'),
  purchasePrice: $('fPurchase'),
  salePrice: $('fSale'),
  hasWholesale: $('fHasWholesale'),
  wholesaleQty: $('fWholesaleQty'),
  wholesalePrice: $('fWholesalePrice'),
  trackStock: $('fTrackStock'),
  stock: $('fStock'),
  lowStockAlert: $('fLowStock'),
  blockWhenOut: $('fBlockWhenOut'),
};
const stockOptions = $('stockOptions');
const unitForm = {
  buttons: document.querySelectorAll('[data-unit]'),
  perLabels: document.querySelectorAll('[data-per]'),
  stockUnit: document.querySelector('[data-stock-unit]'),
  wholesaleOptions: $('wholesaleOptions'),
  wholesaleQtyLabel: $('wholesaleQtyLabel'),
  wholesalePriceLabel: $('wholesalePriceLabel'),
  wholesaleNote: $('wholesaleNote'),
};
const DEFAULT_LOW_STOCK = 5;
const PER_UNIT = { piece: 'للقطعة', kg: 'للكيلو' };
let formUnit = 'piece';

/* Data */

let productsRequest = 0;

async function loadCategories() {
  state.categories = await api('/categories');
  if (state.activeCategory && !state.categories.some((c) => c._id === state.activeCategory)) {
    state.activeCategory = '';
  }
  renderCategories();
}

async function loadProducts() {
  const request = ++productsRequest;
  const params = new URLSearchParams();
  if (state.activeCategory) params.set('category', state.activeCategory);
  if (state.query) params.set('q', state.query);
  const products = await api(`/products?${params}`);
  if (request !== productsRequest) return; // a newer search already replaced this one
  state.products = products;
  renderProducts();
}

async function refresh() {
  try {
    await loadCategories();
    await loadProducts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* Rendering */

function renderCategories() {
  const total = state.categories.reduce((sum, c) => sum + c.productCount, 0);
  const items = [{ _id: '', name: 'كل المنتجات', productCount: total }, ...state.categories];

  els.categoryList.innerHTML = items
    .map((c) => {
      const name = escapeHtml(c.name);
      if (c._id && c._id === state.renamingId) {
        return `<li class="rail-item">
          <form class="rail-rename" data-id="${c._id}">
            <input class="input" name="name" value="${name}" maxlength="60" aria-label="اسم القسم">
            <button class="btn btn-primary btn-sm" type="submit">حفظ</button>
          </form>
        </li>`;
      }
      const active = c._id === state.activeCategory;
      const actions = c._id
        ? `<span class="rail-actions">
            <button class="icon-btn" type="button" data-rename="${c._id}" title="تعديل الاسم" aria-label="تعديل اسم ${name}">${ICONS.edit}</button>
            <button class="icon-btn danger" type="button" data-delete-category="${c._id}" title="حذف القسم" aria-label="حذف قسم ${name}">${ICONS.trash}</button>
          </span>`
        : '';
      return `<li class="rail-item${active ? ' is-active' : ''}">
        <button class="rail-link" type="button" data-select="${c._id}"${active ? ' aria-current="true"' : ''}>
          <span class="rail-name">${name}</span>
          <span class="rail-count num">${c.productCount}</span>
        </button>${actions}
      </li>`;
    })
    .join('');

  const renameInput = els.categoryList.querySelector('.rail-rename input');
  if (renameInput) {
    renameInput.focus();
    renameInput.select();
  }

  const current = state.categories.find((c) => c._id === state.activeCategory);
  els.title.textContent = current ? current.name : 'كل المنتجات';
  els.addProduct.disabled = state.categories.length === 0;
  renderCategorySelect();
}

function renderCategorySelect() {
  const selected = fields.category.value;
  fields.category.innerHTML =
    '<option value="">اختر القسم</option>' +
    state.categories.map((c) => `<option value="${c._id}">${escapeHtml(c.name)}</option>`).join('');
  fields.category.value = selected;
}

function emptyState(title, text, withButton = false) {
  return `<div class="empty">
    <h3>${title}</h3>
    <p>${text}</p>
    ${withButton ? '<button class="btn btn-primary" type="button" data-add-product>إضافة منتج</button>' : ''}
  </div>`;
}

function stockCell(p) {
  if (!p.trackStock) return '<span class="stock is-untracked" title="الكمية غير متتبعة">—</span>';
  const low = p.lowStockAlert ?? DEFAULT_LOW_STOCK;
  const amount = `${formatQty(p.stock)}${p.unit === 'kg' ? ' كغم' : ''}`;
  if (p.stock <= 0) return `<span class="stock is-out num">${amount}</span><small class="stock-note">نفدت</small>`;
  if (p.stock <= low) return `<span class="stock is-low num">${amount}</span><small class="stock-note">منخفضة</small>`;
  return `<span class="stock num">${amount}</span>`;
}

function salePriceCell(p) {
  const unit = p.unit ?? 'piece';
  const retail = `<span class="tag num">${formatMoney(p.salePrice)}</span>${unit === 'kg' ? '<small class="per-unit">للكيلو</small>' : ''}`;
  if (!p.hasWholesale) return retail;
  return `${retail}<small class="wholesale-price">جملة <span class="num">${formatMoney(p.wholesalePrice)}</span> / ${packName(unit, p.wholesaleQty)}</small>`;
}

function profitCell(p) {
  const profit = p.salePrice - p.purchasePrice;
  const pct = p.purchasePrice > 0 ? `${Math.round((profit / p.purchasePrice) * 100)}%` : '';
  return `<span class="num${profit < 0 ? ' loss' : ''}">${formatMoney(profit)}</span>${pct ? `<small class="pct num">${pct}</small>` : ''}`;
}

/* Filtering and sorting */

// Part of the stock; the summary page links here with ?stock=out | low | untracked
const STOCK_FILTERS = {
  '': { label: 'كل المنتجات', test: () => true },
  out: { label: 'نفدت كميتها', test: (p) => p.trackStock && p.stock <= 0 },
  low: {
    label: 'قاربت على النفاد',
    test: (p) => p.trackStock && p.stock > 0 && p.stock <= (p.lowStockAlert ?? DEFAULT_LOW_STOCK),
  },
  available: { label: 'متوفرة', test: (p) => p.trackStock && p.stock > 0 },
  untracked: { label: 'بلا كمية مسجّلة', test: (p) => !p.trackStock },
};

// Products without a recorded quantity have nothing to compare, so they go last
const byStock = (direction) => (a, b) => {
  if (a.trackStock !== b.trackStock) return a.trackStock ? -1 : 1;
  return a.trackStock ? direction * (a.stock - b.stock) : 0;
};
// The server sends products by name; the other orders keep it among equals
const SORTS = {
  name: null,
  low: byStock(1),
  high: byStock(-1),
  new: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
};
const SORT_KEY = 'productsSort';

function readSavedSort() {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    return Object.hasOwn(SORTS, saved ?? '') ? saved : 'name';
  } catch {
    return 'name';
  }
}

// How many products each choice would show, within the current section and search
function renderFilterControls() {
  for (const option of els.stockFilter.options) {
    const filter = STOCK_FILTERS[option.value];
    const count = state.products.filter(filter.test).length;
    option.textContent = option.value ? `${filter.label} (${count})` : filter.label;
  }
  els.stockFilter.value = state.stockFilter;
  els.stockFilter.classList.toggle('is-active', state.stockFilter !== '');
  els.sort.value = state.sort;
}

els.stockFilter.addEventListener('change', () => {
  state.stockFilter = els.stockFilter.value;
  // Kept in the address, so a refresh or a shared link shows the same list
  const query = state.stockFilter ? `?stock=${state.stockFilter}` : '';
  history.replaceState(null, '', location.pathname + query);
  renderProducts();
});

els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  try {
    localStorage.setItem(SORT_KEY, state.sort);
  } catch {
    // Only remembering the choice fails; the list is still sorted
  }
  renderProducts();
});

function renderProducts() {
  renderFilterControls();
  const filtered = state.products.filter(STOCK_FILTERS[state.stockFilter].test);
  const products = SORTS[state.sort] ? [...filtered].sort(SORTS[state.sort]) : filtered;
  els.count.textContent = products.length ? arCount(products.length, PRODUCTS) : '';

  if (!state.categories.length) {
    els.area.innerHTML = emptyState('ابدأ بإضافة قسم', 'أنشئ قسمًا من القائمة الجانبية، مثل «مشروبات» أو «منظفات»، ثم أضف منتجاته.');
    return;
  }
  if (!products.length) {
    els.area.innerHTML = state.query
      ? emptyState(`لا توجد نتائج لـ «${escapeHtml(state.query)}»`, 'جرّب جزءًا من الاسم أو آخر أرقام الباركود.')
      : state.stockFilter
        ? emptyState('لا شيء هنا', `لا توجد منتجات «${STOCK_FILTERS[state.stockFilter].label}» في هذا القسم.`)
        : emptyState('لا توجد منتجات هنا بعد', 'أضف أول منتج، ويمكنك مسح الباركود مباشرة بالقارئ.', true);
    return;
  }

  const showCategory = !state.activeCategory;
  els.area.innerHTML = `<table class="ptable">
    <thead><tr>
      <th scope="col">المنتج</th>
      <th scope="col">الباركود</th>
      <th scope="col">المخزن</th>
      <th scope="col" class="end">سعر الشراء</th>
      <th scope="col" class="end">سعر البيع</th>
      <th scope="col" class="end">الربح</th>
      <th scope="col"><span class="sr-only">إجراءات</span></th>
    </tr></thead>
    <tbody>${products
      .map(
        (p) => `<tr>
        <td>
          <div class="pname">${escapeHtml(p.name)}</div>
          ${showCategory ? `<div class="pcat">${escapeHtml(p.category?.name ?? 'بدون قسم')}</div>` : ''}
        </td>
        <td><span class="num barcode">${escapeHtml(p.barcode)}</span></td>
        <td>${stockCell(p)}</td>
        <td class="end num">${formatMoney(p.purchasePrice)}</td>
        <td class="end">${salePriceCell(p)}</td>
        <td class="end">${profitCell(p)}</td>
        <td class="row-actions">
          <button class="btn btn-sm" type="button" data-edit="${p._id}">تعديل</button>
          <button class="btn btn-sm btn-ghost danger" type="button" data-delete="${p._id}">حذف</button>
        </td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

/* Categories */

els.categoryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = els.categoryForm.elements.name;
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  try {
    const category = await api('/categories', { method: 'POST', body: { name } });
    input.value = '';
    state.activeCategory = category._id;
    state.query = '';
    els.search.value = '';
    toast(`تمت إضافة قسم «${category.name}»`);
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
});

els.categoryList.addEventListener('click', async (e) => {
  const select = e.target.closest('[data-select]');
  const rename = e.target.closest('[data-rename]');
  const remove = e.target.closest('[data-delete-category]');

  if (select) {
    state.activeCategory = select.dataset.select;
    state.renamingId = null;
    renderCategories();
    loadProducts().catch((err) => toast(err.message, 'error'));
  } else if (rename) {
    state.renamingId = rename.dataset.rename;
    renderCategories();
  } else if (remove) {
    const category = state.categories.find((c) => c._id === remove.dataset.deleteCategory);
    if (category.productCount > 0) {
      toast('لا يمكن حذف قسم يحتوي على منتجات. انقل منتجاته أو احذفها أولًا', 'error');
      return;
    }
    if (!confirm(`حذف قسم «${category.name}»؟`)) return;
    try {
      await api(`/categories/${category._id}`, { method: 'DELETE' });
      if (state.activeCategory === category._id) state.activeCategory = '';
      toast(`تم حذف قسم «${category.name}»`);
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

els.categoryList.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = form.elements.name.value.trim();
  if (!name) return;
  try {
    await api(`/categories/${form.dataset.id}`, { method: 'PUT', body: { name } });
    state.renamingId = null;
    toast('تم حفظ اسم القسم');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
});

els.categoryList.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.renamingId) {
    state.renamingId = null;
    renderCategories();
  }
});

/* Search */

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = els.search.value.trim();
    loadProducts().catch((err) => toast(err.message, 'error'));
  }, 200);
});

/* Product dialog */

function readForm() {
  const number = (input, empty = NaN) => (input.value.trim() === '' ? empty : Number(input.value));
  const data = {
    barcode: fields.barcode.value.trim(),
    name: fields.name.value.trim(),
    category: fields.category.value,
    purchasePrice: number(fields.purchasePrice),
    salePrice: number(fields.salePrice),
    unit: formUnit,
    hasWholesale: fields.hasWholesale.checked,
    trackStock: fields.trackStock.checked,
  };
  // Without wholesale, the old box size and price are kept for when it is turned back on
  if (data.hasWholesale) {
    data.wholesaleQty = number(fields.wholesaleQty);
    data.wholesalePrice = number(fields.wholesalePrice);
  }
  // Untracked products keep whatever stock settings they had
  if (data.trackStock) {
    // A new product left blank starts at 0; on an edit a blank field is a mistake
    data.stock = number(fields.stock, state.editingId ? NaN : 0);
    data.lowStockAlert = number(fields.lowStockAlert, DEFAULT_LOW_STOCK);
    data.blockWhenOut = fields.blockWhenOut.checked;
    // Stock left as it was shown is not sent: sales and purchases made since the window
    // opened would otherwise be overwritten by the old figure
    if (state.editingId && state.editingStock !== null && data.stock === state.editingStock) delete data.stock;
  }
  return data;
}

function setUnit(unit) {
  formUnit = unit;
  const byPiece = unit === 'piece';
  unitForm.buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === unit)));
  unitForm.perLabels.forEach((el) => (el.textContent = PER_UNIT[unit]));
  unitForm.stockUnit.textContent = byPiece ? '(قطعة)' : '(كغم)';
  unitForm.wholesaleQtyLabel.textContent = byPiece ? 'عدد القطع في العلبة' : 'وزن الجملة (كغم)';
  unitForm.wholesalePriceLabel.textContent = byPiece ? 'سعر بيع العلبة' : 'سعر بيع هذا الوزن';
  // Pieces are counted whole; kilograms take grams
  const step = byPiece ? '1' : 'any';
  fields.wholesaleQty.step = step;
  fields.stock.step = step;
  fields.lowStockAlert.step = step;
  updateMarginNote();
  updateWholesaleNote();
}

function setWholesaleFields(product) {
  fields.hasWholesale.checked = Boolean(product?.hasWholesale);
  fields.wholesaleQty.value = product?.wholesaleQty ?? '';
  fields.wholesalePrice.value = product?.wholesalePrice ?? '';
  unitForm.wholesaleOptions.hidden = !fields.hasWholesale.checked;
}

// e.g. "أي 900 للقطعة بدل 1,000، وربح العلبة 2,000"
function updateWholesaleNote() {
  const note = unitForm.wholesaleNote;
  const size = parseFloat(fields.wholesaleQty.value);
  const price = parseFloat(fields.wholesalePrice.value);
  const sell = parseFloat(fields.salePrice.value);
  const buy = parseFloat(fields.purchasePrice.value);
  note.className = 'margin-note';
  if (!(size > 0) || !Number.isFinite(price)) {
    note.textContent = '';
    return;
  }
  const per = PER_UNIT[formUnit];
  const parts = [`أي ${formatMoney(price / size)} ${per}${Number.isFinite(sell) ? ` بدل ${formatMoney(sell)}` : ''}`];
  if (Number.isFinite(buy)) {
    const profit = price - buy * size;
    parts.push(profit < 0 ? `وخسارة ${formatMoney(-profit)} في كل جملة` : `وربح الجملة ${formatMoney(profit)}`);
    note.classList.add(profit < 0 ? 'is-loss' : 'is-gain');
  }
  note.textContent = parts.join('، ');
}

function setStockFields(product) {
  fields.trackStock.checked = product ? Boolean(product.trackStock) : true;
  fields.stock.value = product?.trackStock ? product.stock : '';
  state.editingStock = product?.trackStock ? product.stock : null;
  fields.lowStockAlert.value = product?.lowStockAlert ?? DEFAULT_LOW_STOCK;
  fields.blockWhenOut.checked = Boolean(product?.blockWhenOut);
  stockOptions.hidden = !fields.trackStock.checked;
}

function validate(data) {
  if (!data.barcode) return { field: 'barcode', message: 'أدخل رمز الباركود أو اضغط «توليد رمز»' };
  if (!data.name) return { field: 'name', message: 'أدخل اسم المنتج' };
  if (!data.category) return { field: 'category', message: 'اختر القسم' };
  if (!Number.isFinite(data.purchasePrice) || data.purchasePrice < 0) {
    return { field: 'purchasePrice', message: 'أدخل سعر شراء صحيحًا' };
  }
  if (!Number.isFinite(data.salePrice) || data.salePrice < 0) {
    return { field: 'salePrice', message: 'أدخل سعر بيع صحيحًا' };
  }
  const byPiece = data.unit === 'piece';
  if (data.hasWholesale) {
    if (byPiece && !(Number.isInteger(data.wholesaleQty) && data.wholesaleQty >= 2)) {
      return { field: 'wholesaleQty', message: 'عدد القطع في العلبة يجب أن يكون 2 أو أكثر' };
    }
    if (!byPiece && !(data.wholesaleQty > 0)) return { field: 'wholesaleQty', message: 'أدخل وزن الجملة بالكيلوغرام' };
    if (!Number.isFinite(data.wholesalePrice) || data.wholesalePrice < 0) {
      return { field: 'wholesalePrice', message: 'أدخل سعر بيع الجملة' };
    }
  }
  if (data.trackStock) {
    const valid = (n) => Number.isFinite(n) && (!byPiece || Number.isInteger(n));
    if (data.stock !== undefined && !valid(data.stock)) {
      return { field: 'stock', message: byPiece ? 'كمية المخزن يجب أن تكون عددًا صحيحًا من القطع' : 'أدخل كمية المخزن بالكيلوغرام' };
    }
    if (!valid(data.lowStockAlert) || data.lowStockAlert < 0) {
      return { field: 'lowStockAlert', message: 'أدخل حد تنبيه صحيحًا من 0 فأكثر' };
    }
  }
  return null;
}

function showError(message, field) {
  els.error.textContent = message;
  els.error.hidden = false;
  if (field) {
    fields[field].classList.add('is-invalid');
    fields[field].focus();
  }
}

function clearError() {
  els.error.hidden = true;
  Object.values(fields).forEach((f) => f.classList.remove('is-invalid'));
}

function updateMarginNote() {
  const buy = parseFloat(fields.purchasePrice.value);
  const sell = parseFloat(fields.salePrice.value);
  els.marginNote.className = 'margin-note';
  if (!Number.isFinite(buy) || !Number.isFinite(sell)) {
    els.marginNote.textContent = '';
    return;
  }
  const diff = sell - buy;
  const per = formUnit === 'kg' ? 'الكيلو' : 'القطعة';
  if (diff < 0) {
    els.marginNote.textContent = `سعر البيع أقل من سعر الشراء، ستخسر ${formatMoney(-diff)} في ${per}.`;
    els.marginNote.classList.add('is-loss');
  } else {
    const pct = buy > 0 ? ` (${Math.round((diff / buy) * 100)}% من سعر الشراء)` : '';
    els.marginNote.textContent = `الربح في ${per} ${formatMoney(diff)}${pct}`;
    els.marginNote.classList.add('is-gain');
  }
}

function openProductDialog(product = null) {
  state.editingId = product?._id ?? null;
  els.form.reset();
  clearError();
  renderCategorySelect();
  els.dialogTitle.textContent = product ? 'تعديل المنتج' : 'منتج جديد';
  els.saveNext.hidden = Boolean(product);
  if (product) {
    fields.barcode.value = product.barcode;
    fields.name.value = product.name;
    fields.category.value = product.category?._id ?? '';
    fields.purchasePrice.value = product.purchasePrice;
    fields.salePrice.value = product.salePrice;
  } else {
    fields.category.value = state.activeCategory;
  }
  setWholesaleFields(product);
  setStockFields(product);
  setUnit(product?.unit ?? 'piece');
  updateMarginNote();
  els.dialog.showModal();
  (product ? fields.name : fields.barcode).focus();
  if (product) refreshStock(product);
}

// The list may have been loaded a while ago: the window shows the stock as it is now,
// unless the field was already changed
async function refreshStock(product) {
  try {
    const fresh = await api(`/products/barcode/${encodeURIComponent(product.barcode)}`);
    if (state.editingId !== product._id || !fresh.trackStock || !product.trackStock) return;
    if (fields.stock.value === String(state.editingStock ?? '')) fields.stock.value = fresh.stock;
    state.editingStock = fresh.stock;
  } catch {
    // The figure from the list stays
  }
}

// Sales on other devices change the stock: coming back to the page shows it fresh
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !els.dialog.open) loadProducts().catch(() => {});
});

els.addProduct.addEventListener('click', () => openProductDialog());
els.cancel.addEventListener('click', () => els.dialog.close());
els.generate.addEventListener('click', () => {
  fields.barcode.value = randomStoreBarcode();
  fields.barcode.classList.remove('is-invalid');
  fields.name.focus();
});
els.camera.addEventListener('click', async () => {
  const code = await scanBarcode();
  if (!code) {
    fields.barcode.focus();
    return;
  }
  fields.barcode.value = code;
  fields.barcode.classList.remove('is-invalid');
  fields.name.focus();
});

// Barcode scanners type the code then press Enter: move on instead of submitting
fields.barcode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    fields.name.focus();
  }
});

unitForm.buttons.forEach((b) => b.addEventListener('click', () => setUnit(b.dataset.unit)));
fields.hasWholesale.addEventListener('change', () => {
  unitForm.wholesaleOptions.hidden = !fields.hasWholesale.checked;
  if (fields.hasWholesale.checked) fields.wholesaleQty.focus();
});
[fields.wholesaleQty, fields.wholesalePrice, fields.salePrice, fields.purchasePrice].forEach((input) =>
  input.addEventListener('input', updateWholesaleNote),
);
fields.trackStock.addEventListener('change', () => {
  stockOptions.hidden = !fields.trackStock.checked;
  if (fields.trackStock.checked) fields.stock.focus();
});
fields.purchasePrice.addEventListener('input', updateMarginNote);
fields.salePrice.addEventListener('input', updateMarginNote);
els.form.addEventListener('input', (e) => e.target.classList?.remove('is-invalid'));

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const addAnother = e.submitter?.value === 'next';
  clearError();
  const data = readForm();
  const problem = validate(data);
  if (problem) {
    showError(problem.message, problem.field);
    return;
  }

  const buttons = els.form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    if (state.editingId) {
      await api(`/products/${state.editingId}`, { method: 'PUT', body: data });
    } else {
      await api('/products', { method: 'POST', body: data });
    }
    toast(`تم حفظ «${data.name}»`);
    await refresh();
    if (addAnother) {
      els.form.reset();
      fields.category.value = data.category;
      setWholesaleFields(null);
      setStockFields(null);
      setUnit(data.unit);
      updateMarginNote();
      fields.barcode.focus();
    } else {
      els.dialog.close();
    }
  } catch (err) {
    showError(err.message, err.status === 409 ? 'barcode' : undefined);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

/* Table actions */

els.area.addEventListener('click', async (e) => {
  if (e.target.closest('[data-add-product]')) {
    openProductDialog();
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    openProductDialog(state.products.find((p) => p._id === edit.dataset.edit));
    return;
  }
  const remove = e.target.closest('[data-delete]');
  if (remove) {
    const product = state.products.find((p) => p._id === remove.dataset.delete);
    if (!confirm(`حذف «${product.name}»؟ الفواتير السابقة لن تتأثر.`)) return;
    try {
      await api(`/products/${product._id}`, { method: 'DELETE' });
      toast(`تم حذف «${product.name}»`);
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

// No ?stock= in the address means all products
const requestedFilter = new URLSearchParams(location.search).get('stock') ?? '';
state.stockFilter = Object.hasOwn(STOCK_FILTERS, requestedFilter) ? requestedFilter : '';
state.sort = readSavedSort();
refresh();
