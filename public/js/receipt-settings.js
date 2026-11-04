// The «الإيصال والطباعة» card of the settings page, for the owner (PUT /api/settings): the
// paper, the logo, what shows on the receipt, its note and printing by itself after a sale,
// with the receipt beside it as it will print, redrawn at each change. The preview takes
// the shop's name, phone and address from the «المتجر» card and the currency from «البيع
// والمخزون» as they are typed, saved or not. A picture chosen for the logo is shrunk here
// to LOGO_SIDE pixels at most and kept as a data: URL under LOGO_MAX_BYTES (lib/logo.js
// checks it again); it is saved with the rest of the card.
import { api, toast, withSignIn, rememberShop, session } from './common.js';
import { paperOf, receiptHtml, printReceipt, clearReceipt } from './receipt.js';

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_SIDE = 384;
const LOGO_MAX_BYTES = 64 * 1024;

const $ = (id) => document.getElementById(id);
const els = {
  form: $('receiptForm'),
  error: $('receiptError'),
  paperButtons: document.querySelectorAll('#paperButtons [data-paper]'),
  logoImage: $('logoImage'),
  logoEmpty: $('logoEmpty'),
  logoPick: $('logoPick'),
  logoRemove: $('logoRemove'),
  logoInput: $('logoInput'),
  logoHint: $('logoHint'),
  showAddress: $('receiptShowAddress'),
  showPhone: $('receiptShowPhone'),
  showCashier: $('receiptShowCashier'),
  note: $('receiptNote'),
  autoPrint: $('autoPrint'),
  preview: $('receiptPreview'),
  testPrint: $('testPrint'),
  // From the other cards, for the preview
  shopName: $('shopName'),
  phone: $('phone'),
  address: $('address'),
  currency: $('currency'),
};

const state = { paper: '80', logo: '', savedLogo: '', seller: '' };
const LOGO_HINT = els.logoHint.textContent;

// At the top of a long card: brought into view, or a phone shows nothing happening
const showError = (message) => {
  els.error.textContent = message;
  els.error.hidden = !message;
  if (message) els.error.scrollIntoView({ block: 'center' });
};

/* The preview */

// An invoice to show what the receipt looks like: by the piece, by weight and a whole box
function sampleSale() {
  return {
    number: 1024,
    createdAt: new Date(),
    items: [
      { name: 'شاي 500 غ', unit: 'piece', mode: 'retail', packSize: 1, quantity: 2, unitPrice: 3500, lineTotal: 7000 },
      { name: 'سكر', unit: 'kg', mode: 'retail', packSize: 1, quantity: 1.5, unitPrice: 1500, lineTotal: 2250 },
      { name: 'ماء معدني', unit: 'piece', mode: 'wholesale', packSize: 12, quantity: 1, unitPrice: 3000, lineTotal: 3000 },
    ],
    total: 12250,
    paid: 15000,
    change: 2750,
    paymentType: 'cash',
    madeBy: { name: state.seller || 'البائع' },
  };
}

// The card as it stands, with the shop's details from the other cards
function shopFromForm() {
  return {
    shopName: els.shopName.value.trim(),
    phone: els.phone.value.trim(),
    address: els.address.value.trim(),
    currency: els.currency.value.trim(),
    receiptNote: els.note.value.trim(),
    receiptShowAddress: els.showAddress.checked,
    receiptShowPhone: els.showPhone.checked,
    receiptShowCashier: els.showCashier.checked,
  };
}

const previewHtml = () => receiptHtml(sampleSale(), shopFromForm(), state.logo);

// Also for settings.js, once the «المتجر» card saved (its fields set without an input event)
export function renderPreview() {
  els.preview.dataset.paper = state.paper;
  els.preview.innerHTML = previewHtml();
}

function setPaper(paper) {
  state.paper = paperOf(paper);
  els.paperButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.paper === state.paper)));
  renderPreview();
}

function showLogo() {
  els.logoImage.hidden = !state.logo;
  if (state.logo) els.logoImage.src = state.logo;
  else els.logoImage.removeAttribute('src');
  els.logoEmpty.hidden = Boolean(state.logo);
  els.logoRemove.hidden = !state.logo;
  els.logoHint.textContent = state.logo === state.savedLogo ? LOGO_HINT : 'لم يُحفظ بعد: اضغط «حفظ إعدادات الإيصال» ليظهر التغيير على الإيصالات.';
  renderPreview();
}

/* The logo */

// The bytes a base64 data: URL holds
function bytesOf(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

// The picture redrawn to fit LOGO_SIDE x LOGO_SIDE: as PNG, which keeps a logo's sharp edges
// and its transparency; a photo too heavy for PNG as WebP, or as JPEG on white where the
// browser cannot make WebP
async function shrinkLogo(file) {
  if (!LOGO_TYPES.includes(file.type)) throw new Error('اختر صورة PNG أو JPEG أو WebP');
  const url = URL.createObjectURL(file);
  try {
    // Loaded is enough to draw it (decode() can wait for a frame that a hidden tab never paints)
    const img = new Image();
    const opened = await new Promise((resolve) => {
      img.addEventListener('load', () => resolve(true), { once: true });
      img.addEventListener('error', () => resolve(false), { once: true });
      img.src = url;
    });
    if (!opened || !img.naturalWidth) throw new Error('تعذّر فتح هذه الصورة. اختر صورة أخرى');
    const scale = Math.min(1, LOGO_SIDE / img.naturalWidth, LOGO_SIDE / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const [type, quality] of [['image/png'], ['image/webp', 0.92], ['image/webp', 0.8], ['image/webp', 0.65]]) {
      const data = canvas.toDataURL(type, quality);
      if (data.startsWith(`data:${type};base64,`) && bytesOf(data) <= LOGO_MAX_BYTES) return data;
    }
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.75, 0.6, 0.45]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      if (bytesOf(data) <= LOGO_MAX_BYTES) return data;
    }
    throw new Error('الصورة كبيرة حتى بعد تصغيرها. اختر صورة أبسط');
  } finally {
    URL.revokeObjectURL(url);
  }
}

els.logoPick.addEventListener('click', () => els.logoInput.click());
els.logoInput.addEventListener('change', async () => {
  const file = els.logoInput.files?.[0];
  els.logoInput.value = '';
  if (!file) return;
  showError('');
  try {
    state.logo = await shrinkLogo(file);
    showLogo();
  } catch (err) {
    showError(err.message);
  }
});
els.logoRemove.addEventListener('click', () => {
  state.logo = '';
  showLogo();
  els.logoPick.focus();
});

/* Filling and saving */

// The card from the saved settings (GET or PUT /api/settings)
export function fillReceipt(settings) {
  els.showAddress.checked = settings.receiptShowAddress;
  els.showPhone.checked = settings.receiptShowPhone;
  els.showCashier.checked = settings.receiptShowCashier;
  els.note.value = settings.receiptNote;
  els.autoPrint.checked = settings.autoPrint;
  state.logo = settings.receiptLogo;
  state.savedLogo = settings.receiptLogo;
  state.paper = paperOf(settings.receiptPaper);
  setPaper(state.paper);
  showLogo();
}

export function initReceiptCard() {
  els.paperButtons.forEach((b) => b.addEventListener('click', () => setPaper(b.dataset.paper)));
  els.form.addEventListener('input', renderPreview);
  els.form.addEventListener('change', renderPreview);
  for (const input of [els.shopName, els.phone, els.address, els.currency]) input.addEventListener('input', renderPreview);
  session.then((me) => {
    state.seller = me?.user?.displayName ?? '';
    renderPreview();
  });

  // Once the print window closes the page prints as itself again (Ctrl+P), not this receipt
  els.testPrint.addEventListener('click', () => {
    addEventListener('afterprint', clearReceipt, { once: true });
    printReceipt(previewHtml(), state.paper);
  });

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const body = {
      receiptPaper: state.paper,
      receiptShowAddress: els.showAddress.checked,
      receiptShowPhone: els.showPhone.checked,
      receiptShowCashier: els.showCashier.checked,
      receiptNote: els.note.value.trim(),
      autoPrint: els.autoPrint.checked,
    };
    // The picture goes only when it changed (up to 64 KB)
    if (state.logo !== state.savedLogo) body.receiptLogo = state.logo;
    const button = els.form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const saved = await withSignIn(() => api('/settings', { method: 'PUT', body }));
      fillReceipt(saved);
      rememberShop(saved);
      toast('حُفظت إعدادات الإيصال');
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  });
}
