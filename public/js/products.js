import { api, toast, formatMoney, escapeHtml, arCount, PRODUCTS } from './common.js';
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
  renamingId: null,
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
  trackStock: $('fTrackStock'),
  stock: $('fStock'),
  lowStockAlert: $('fLowStock'),
  blockWhenOut: $('fBlockWhenOut'),
};
const stockOptions = $('stockOptions');
const DEFAULT_LOW_STOCK = 5;

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
  if (p.stock <= 0) return `<span class="stock is-out num">${p.stock}</span><small class="stock-note">نفدت</small>`;
  if (p.stock <= low) return `<span class="stock is-low num">${p.stock}</span><small class="stock-note">منخفضة</small>`;
  return `<span class="stock num">${p.stock}</span>`;
}

function profitCell(p) {
  const profit = p.salePrice - p.purchasePrice;
  const pct = p.purchasePrice > 0 ? `${Math.round((profit / p.purchasePrice) * 100)}%` : '';
  return `<span class="num${profit < 0 ? ' loss' : ''}">${formatMoney(profit)}</span>${pct ? `<small class="pct num">${pct}</small>` : ''}`;
}

function renderProducts() {
  const { products } = state;
  els.count.textContent = products.length ? arCount(products.length, PRODUCTS) : '';

  if (!state.categories.length) {
    els.area.innerHTML = emptyState('ابدأ بإضافة قسم', 'أنشئ قسمًا من القائمة الجانبية، مثل «مشروبات» أو «منظفات»، ثم أضف منتجاته.');
    return;
  }
  if (!products.length) {
    els.area.innerHTML = state.query
      ? emptyState(`لا توجد نتائج لـ «${escapeHtml(state.query)}»`, 'جرّب جزءًا من الاسم أو آخر أرقام الباركود.')
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
        <td class="end"><span class="tag num">${formatMoney(p.salePrice)}</span></td>
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
    trackStock: fields.trackStock.checked,
  };
  // Untracked products keep whatever stock settings they had
  if (data.trackStock) {
    data.stock = number(fields.stock, 0);
    data.lowStockAlert = number(fields.lowStockAlert, DEFAULT_LOW_STOCK);
    data.blockWhenOut = fields.blockWhenOut.checked;
  }
  return data;
}

function setStockFields(product) {
  fields.trackStock.checked = product ? Boolean(product.trackStock) : true;
  fields.stock.value = product?.trackStock ? product.stock : '';
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
  if (data.trackStock) {
    if (!Number.isInteger(data.stock)) return { field: 'stock', message: 'كمية المخزن يجب أن تكون عددًا صحيحًا' };
    if (!Number.isInteger(data.lowStockAlert) || data.lowStockAlert < 0) {
      return { field: 'lowStockAlert', message: 'حد التنبيه يجب أن يكون عددًا صحيحًا من 0 فأكثر' };
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
  if (diff < 0) {
    els.marginNote.textContent = `سعر البيع أقل من سعر الشراء، ستخسر ${formatMoney(-diff)} في كل قطعة.`;
    els.marginNote.classList.add('is-loss');
  } else {
    const pct = buy > 0 ? ` (${Math.round((diff / buy) * 100)}% من سعر الشراء)` : '';
    els.marginNote.textContent = `الربح في القطعة ${formatMoney(diff)}${pct}`;
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
  setStockFields(product);
  updateMarginNote();
  els.dialog.showModal();
  (product ? fields.name : fields.barcode).focus();
}

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
      setStockFields(null);
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

refresh();
