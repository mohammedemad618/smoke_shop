// The «البيع والمخزون» card of the settings page, for the owner: the currency shown next to
// totals, the «أصغر فئة نقدية» each sale line is rounded up to, and what a new product
// starts with in the product form (PUT /api/settings).
// Products already made keep their own values until the owner applies a saved default to
// them with «تطبيق على كل المنتجات الحالية» (routes/settings.js): first how many tracked
// products it changes, in the confirmation, then one update of that field alone.
import { api, toast, withSignIn, rememberShop, parseNumber, arCount, formatMoney, lineAmount, PRODUCTS } from './common.js';

const LOW_STOCK_MAX = 100000;

const $ = (id) => document.getElementById(id);
const els = {
  form: $('salesForm'),
  error: $('salesError'),
  currency: $('currency'),
  roundingStep: $('roundingStep'),
  roundingHint: $('roundingHint'),
  trackStock: $('defaultTrackStock'),
  lowStock: $('defaultLowStockAlert'),
  blockWhenOut: $('defaultBlockWhenOut'),
  apply: document.querySelectorAll('[data-apply]'),
};

// The defaults as saved: the ones «تطبيق على كل المنتجات الحالية» applies
const saved = { lowStockAlert: 5, blockWhenOut: false };

// At the top of the card: brought into view, or a phone shows nothing happening
const showError = (message) => {
  els.error.textContent = message;
  els.error.hidden = !message;
  if (message) els.error.scrollIntoView({ block: 'center' });
};

// The stock alert typed: a whole number from 0 (Arabic digits read too), or NaN
function typedLowStock() {
  const value = parseNumber(els.lowStock.value);
  return Number.isInteger(value) && value >= 0 && value <= LOW_STOCK_MAX ? value : NaN;
}

/* «أصغر فئة نقدية» */

// Each step with the currency as it is typed («250 د.ع»), and what the one chosen does, on
// a price of its own that it rounds (600 at 250, 1,200 at 500)
function showRounding() {
  const currency = els.currency.value.trim();
  for (const option of els.roundingStep.options) {
    const step = Number(option.value);
    if (step) option.textContent = currency ? `${formatMoney(step)} ${currency}` : formatMoney(step);
  }
  const step = Number(els.roundingStep.value) || 0;
  if (!step) {
    els.roundingHint.textContent = 'كل سطر في الفاتورة بسعره كما هو، بلا تقريب. اختر فئة ليُقرَّب مبلغ كل سطر للأعلى إليها.';
    return;
  }
  const price = step * 2.4;
  const [one, two, three] = [1, 2, 3].map((quantity) => formatMoney(lineAmount(price, quantity, step)));
  els.roundingHint.textContent = `يُقرَّب مبلغ كل سطر في الفاتورة للأعلى إلى أقرب ${formatMoney(step)}: صنف بـ${formatMoney(price)} يُباع بـ${one}، واثنان بـ${two}، وثلاثة بـ${three}. الفواتير السابقة لا تتغير.`;
}

// The card from the saved settings (GET or PUT /api/settings)
export function fillStock(settings) {
  els.currency.value = settings.currency;
  els.roundingStep.value = String(settings.roundingStep ?? 0);
  showRounding();
  els.trackStock.checked = settings.defaultTrackStock;
  els.lowStock.value = settings.defaultLowStockAlert;
  els.blockWhenOut.checked = settings.defaultBlockWhenOut;
  saved.lowStockAlert = settings.defaultLowStockAlert;
  saved.blockWhenOut = settings.defaultBlockWhenOut;
}

// What a default means, in the words of the product form
const WORDING = {
  lowStockAlert: (value) => `«نبّهني عندما تصل الكمية إلى ${value}»`,
  blockWhenOut: (value) => (value ? '«منع البيع عند نفاد الكمية»' : 'السماح بالبيع عند نفاد الكمية'),
};

async function applyToProducts(field, button) {
  showError('');
  const typed = field === 'lowStockAlert' ? typedLowStock() : els.blockWhenOut.checked;
  if (typed !== saved[field]) {
    showError('احفظ القيمة الجديدة أولًا بزر «حفظ إعدادات البيع والمخزون»، ثم طبّقها على كل المنتجات الحالية');
    return;
  }
  button.disabled = true;
  try {
    const counts = await api('/settings/product-defaults');
    const { value, toChange } = counts[field];
    if (value !== saved[field]) {
      showError('تغيّرت القيمة المحفوظة من مكان آخر. حدّث الصفحة لتراها');
      return;
    }
    if (!counts.tracked) {
      toast('لا توجد منتجات تُتتبَّع كميتها بعد');
      return;
    }
    if (!toChange) {
      toast(`كل المنتجات التي تُتتبَّع كميتها عليها ${WORDING[field](value)} من قبل`);
      return;
    }
    const question = `تطبيق ${WORDING[field](value)} على كل المنتجات الحالية؟ سيتغيّر ${arCount(toChange, PRODUCTS)} من المنتجات التي تُتتبَّع كميتها، ولا تتغير الكميات ولا الأسعار.`;
    if (!confirm(question)) return;
    const { changed } = await withSignIn(() => api('/settings/product-defaults/apply', { method: 'POST', body: { field, value } }));
    toast(changed ? `طُبّق ${WORDING[field](value)} على المنتجات الحالية: تغيّر ${arCount(changed, PRODUCTS)}` : 'لم يتغيّر أي منتج');
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
}

export function initStockCard() {
  els.apply.forEach((button) => button.addEventListener('click', () => applyToProducts(button.dataset.apply, button)));
  els.roundingStep.addEventListener('change', showRounding);
  els.currency.addEventListener('input', showRounding);
  showRounding();

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const currency = els.currency.value.trim();
    const lowStock = typedLowStock();
    if (!currency) {
      showError('اكتب العملة، مثل: د.ع');
      els.currency.focus();
      return;
    }
    if (!Number.isFinite(lowStock)) {
      showError(`حد التنبيه يجب أن يكون عددًا صحيحًا من 0 إلى ${LOW_STOCK_MAX}`);
      els.lowStock.focus();
      return;
    }
    const body = {
      currency,
      roundingStep: Number(els.roundingStep.value) || 0,
      defaultTrackStock: els.trackStock.checked,
      defaultLowStockAlert: lowStock,
      defaultBlockWhenOut: els.blockWhenOut.checked,
    };
    const button = els.form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const settings = await withSignIn(() => api('/settings', { method: 'PUT', body }));
      fillStock(settings);
      rememberShop(settings);
      toast('حُفظت إعدادات البيع والمخزون');
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  });
}
