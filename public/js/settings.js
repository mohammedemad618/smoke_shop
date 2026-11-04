import { api, toast, session, rememberShop, withSignIn, isOwnerAccount } from './common.js';
import { PASSWORD_MIN, passwordLength } from './auth.js';
import { initStaffCard } from './staff.js';
import { initReceiptCard, fillReceipt, renderPreview } from './receipt-settings.js';
import { initStockCard, fillStock } from './stock-settings.js';

const $ = (id) => document.getElementById(id);
const els = {
  shopForm: $('shopForm'),
  shopError: $('shopError'),
  shopName: $('shopName'),
  phone: $('phone'),
  address: $('address'),
  timeZone: $('timeZone'),
  passwordForm: $('passwordForm'),
  passwordError: $('passwordError'),
  currentPassword: $('currentPassword'),
  newPassword: $('newPassword'),
  confirmPassword: $('confirmPassword'),
  logoutAll: $('logoutAll'),
};

// The zones of the region first; a shop set to another one keeps it in the list
const ZONES = [
  ['Asia/Baghdad', 'بغداد'],
  ['Asia/Riyadh', 'الرياض'],
  ['Asia/Kuwait', 'الكويت'],
  ['Asia/Qatar', 'الدوحة'],
  ['Asia/Bahrain', 'المنامة'],
  ['Asia/Dubai', 'دبي'],
  ['Asia/Muscat', 'مسقط'],
  ['Asia/Aden', 'عدن'],
  ['Asia/Amman', 'عمّان'],
  ['Asia/Damascus', 'دمشق'],
  ['Asia/Beirut', 'بيروت'],
  ['Asia/Jerusalem', 'القدس'],
  ['Africa/Cairo', 'القاهرة'],
  ['Africa/Khartoum', 'الخرطوم'],
  ['Africa/Tripoli', 'طرابلس'],
  ['Africa/Tunis', 'تونس'],
  ['Africa/Algiers', 'الجزائر'],
  ['Africa/Casablanca', 'الدار البيضاء'],
  ['Europe/Istanbul', 'إسطنبول'],
  ['Asia/Tehran', 'طهران'],
  ['Europe/London', 'لندن'],
  ['UTC', 'التوقيت العالمي'],
];

const showError = (el, message) => {
  el.textContent = message;
  el.hidden = !message;
};

function fillZones(current) {
  const zones = ZONES.some(([zone]) => zone === current) ? ZONES : [[current, current], ...ZONES];
  els.timeZone.replaceChildren(
    ...zones.map(([zone, label]) => {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = label === zone ? zone : `${label} (${zone})`;
      option.selected = zone === current;
      return option;
    }),
  );
}

function fillShop(settings) {
  els.shopName.value = settings.shopName;
  els.phone.value = settings.phone;
  els.address.value = settings.address;
  fillZones(settings.timeZone || 'Asia/Baghdad');
}

// The owner's cards, from one read of the settings; each card saves its own fields
async function load() {
  initReceiptCard();
  initStockCard();
  try {
    const settings = await api('/settings');
    fillShop(settings);
    fillStock(settings);
    // Last: its preview reads the other two cards
    fillReceipt(settings);
  } catch (err) {
    showError(els.shopError, err.message);
  }
}

els.shopForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.shopError, '');
  const body = {
    shopName: els.shopName.value.trim(),
    phone: els.phone.value.trim(),
    address: els.address.value.trim(),
    timeZone: els.timeZone.value,
  };
  if (!body.shopName) {
    showError(els.shopError, 'اكتب اسم المتجر');
    els.shopName.focus();
    return;
  }
  const button = els.shopForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const saved = await withSignIn(() => api('/settings', { method: 'PUT', body }));
    fillShop(saved);
    rememberShop(saved);
    renderPreview();
    toast('حُفظت إعدادات المتجر');
  } catch (err) {
    showError(els.shopError, err.message);
  } finally {
    button.disabled = false;
  }
});

els.passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = els.currentPassword.value;
  const password = els.newPassword.value;
  let problem = '';
  if (!current) problem = 'اكتب كلمة المرور الحالية';
  else if (passwordLength(password) < PASSWORD_MIN) problem = `كلمة المرور الجديدة يجب أن تكون ${PASSWORD_MIN} أحرف على الأقل`;
  else if (password !== els.confirmPassword.value) problem = 'كلمتا المرور الجديدتان غير متطابقتين';
  showError(els.passwordError, problem);
  if (problem) return;
  const button = els.passwordForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await withSignIn(() => api('/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: password } }));
    els.passwordForm.reset();
    toast('تغيّرت كلمة المرور، وخرجت الأجهزة الأخرى');
  } catch (err) {
    showError(els.passwordError, err.message);
  } finally {
    button.disabled = false;
  }
});

els.logoutAll.addEventListener('click', async () => {
  if (!confirm('الخروج من كل الأجهزة، وهذا الجهاز معها؟ ستحتاج الدخول من جديد في كل جهاز.')) return;
  try {
    await api('/auth/logout-all', { method: 'POST' });
  } catch (err) {
    if (err.code !== 'AUTH_EXPIRED') {
      toast(err.message, 'error');
      return;
    }
  }
  // The shift on this tab ends too, as with «تسجيل الخروج»: its cart and the rest it kept
  try {
    sessionStorage.clear();
  } catch {
    // storage blocked: nothing was kept
  }
  location.assign('/login.html');
});

// The sales file covers the chosen month of this browser's calendar, cut at its own
// midnight like the sales page, so its total line is that month on the sales page
const exportMonth = $('exportMonth');
const exportSales = $('exportSales');
const pad = (n) => String(n).padStart(2, '0');
function salesLink() {
  const [year, month] = (exportMonth.value || '').split('-').map(Number);
  if (!year || !month) return;
  const query = new URLSearchParams({
    from: new Date(year, month - 1, 1).toISOString(),
    to: new Date(year, month, 1).toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    label: `${year}-${pad(month)}`,
  });
  exportSales.href = `/api/export/sales.csv?${query}`;
}
const today = new Date();
exportMonth.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
exportMonth.addEventListener('change', salesLink);
salesLink();

// For password managers: the account the new password belongs to. The shop's settings and
// its staff are the owner's: a staff account has «حسابك» only, and asks for nothing else.
session.then((me) => {
  const field = document.querySelector('[data-username-field]');
  if (field && me) field.value = me.user.username;
  if (!isOwnerAccount()) return;
  load();
  initStaffCard();
});
