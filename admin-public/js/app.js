// The admin panel: one page whose screens follow the address's hash (#/, #/new, #/shop/<id>,
// #/job/<id>, #/audit). Signing in (password, then the authenticator code or a recovery
// code), the shops list, a new shop with its progress, a shop's details and lifecycle, and
// the audit log. Every element is built with h() (dom.js), text as text only. The first
// password of a new shop or of a reset is made here (password.js), shown once and kept in
// this page's memory only.
import { h, fill, formatDate, formatDateTime, formatNumber, formatBytes, formatAgo, monthRange } from './dom.js';
import { request, download, setCsrf, setHandlers, ApiError } from './api.js';
import { generatePassword, newRequestId } from './password.js';
import {
  ACTION_LABELS,
  JOB_LABELS,
  JOB_STATUS,
  STATUS_LABELS,
  auditRow,
  backupRow,
  certBadge,
  facts,
  sessionRow,
  shopHref,
  shopRow,
  statusBadge,
  stepList,
  userRow,
} from './views.js';

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');
const adminName = document.getElementById('adminName');

let me = null;
let overview = null;
// tenant id -> { username, password, url } for shops made or reset from this page
const secrets = new Map();
// Stops the screen's timers (a job's progress) when another screen opens
let leaveScreen = () => {};

const ZONES = [
  ['Asia/Baghdad', 'بغداد'], ['Asia/Riyadh', 'الرياض'], ['Asia/Kuwait', 'الكويت'], ['Asia/Qatar', 'الدوحة'],
  ['Asia/Bahrain', 'المنامة'], ['Asia/Dubai', 'دبي'], ['Asia/Muscat', 'مسقط'], ['Asia/Amman', 'عمّان'],
  ['Asia/Damascus', 'دمشق'], ['Asia/Beirut', 'بيروت'], ['Africa/Cairo', 'القاهرة'], ['Europe/Istanbul', 'إسطنبول'],
  ['Asia/Tehran', 'طهران'], ['Europe/London', 'لندن'], ['UTC', 'التوقيت العالمي'],
];

/* Small helpers */

function toast(message, type = 'info') {
  const el = h('div', { className: type === 'error' ? 'toast is-error' : 'toast', text: message, attrs: { role: type === 'error' ? 'alert' : 'status' } });
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2800);
}

const errorBox = () => h('p', { className: 'form-error', hidden: true, attrs: { role: 'alert' } });
function showError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

const field = (label, input, hint) => {
  if (!input.id) input.id = `f${Math.random().toString(36).slice(2, 9)}`;
  return h('div', { className: 'field' }, h('label', { htmlFor: input.id, text: label }), input, hint ? h('p', { className: 'hint', text: hint }) : null);
};
const input = (props = {}) => h('input', { className: 'input', ...props });

// Returns whether it was copied
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('نُسخ');
    return true;
  } catch {
    toast('تعذّر النسخ. انسخه يدويًا', 'error');
    return false;
  }
}

// Disables a form's buttons while `work` runs
async function busy(form, work) {
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    return await work();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// A modal dialog built from parts, named by its title; resolves with what onSubmit returned,
// or null if closed. The button that closes it says «رجوع», not «إلغاء»: many actions here
// are called «إلغاء ...» themselves (إلغاء الحذف، إلغاء العمل، إلغاء الجلسات).
function dialog({ title, lead, body = [], submitText = 'تأكيد', cancelText = 'رجوع', danger = false, onSubmit }) {
  return new Promise((resolve) => {
    const error = errorBox();
    const submit = h('button', { className: danger ? 'btn btn-primary danger-fill' : 'btn btn-primary', type: 'submit', text: submitText });
    const cancel = h('button', { className: 'btn btn-ghost', type: 'button', text: cancelText });
    const heading = h('h2', { id: `d${Math.random().toString(36).slice(2, 9)}`, text: title });
    const form = h('form', { noValidate: true }, heading, lead ? h('p', { className: 'dialog-lead', text: lead }) : null, error, body, h('div', { className: 'dialog-actions' }, submit, cancel));
    const box = h('dialog', { className: 'dialog', attrs: { 'aria-labelledby': heading.id } }, form);
    let result = null;
    box.addEventListener('close', () => {
      box.remove();
      resolve(result);
    });
    cancel.addEventListener('click', () => box.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(error, '');
      await busy(form, async () => {
        try {
          result = (await onSubmit?.()) ?? true;
          box.close();
        } catch (err) {
          if (err instanceof ApiError && (err.code === 'AUTH_EXPIRED' || err.code === 'SESSION_ENDED')) {
            box.close();
            return;
          }
          showError(error, err.message);
        }
      });
    });
    document.body.append(box);
    box.showModal();
    form.querySelector('input:not([type=hidden]):not([readonly]), textarea')?.focus();
  });
}

/* Signing in */

function signedOut(message = '') {
  // A dialog left open (the action whose step-up ended the session) would sit, modal, over
  // the sign-in form: each one closes, which removes it
  for (const box of document.querySelectorAll('dialog[open]')) box.close();
  leaveScreen();
  me = null;
  setCsrf(null);
  topbar.hidden = true;
  showLogin(message);
}

function authCard(...children) {
  document.body.classList.add('auth-page');
  return h('div', { className: 'auth' }, h('div', { className: 'auth-card' }, h('div', { className: 'auth-brand' }, h('span', { className: 'brand-mark', attrs: { 'aria-hidden': 'true' } }), 'لوحة الإدارة'), ...children));
}

function showLogin(message = '') {
  const error = errorBox();
  const username = input({ autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 64, attrs: { dir: 'ltr' } });
  const password = input({ type: 'password', autocomplete: 'current-password', maxLength: 128 });
  const form = h('form', { className: 'auth-form', noValidate: true }, h('h1', { text: 'تسجيل الدخول' }), error, field('اسم المستخدم', username), field('كلمة المرور', password), h('button', { className: 'btn btn-primary btn-xl auth-submit', type: 'submit', text: 'دخول' }));
  fill(view, authCard(form));
  showError(error, message);
  username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!username.value.trim() || !password.value) return showError(error, 'اكتب اسم المستخدم وكلمة المرور');
    await busy(form, async () => {
      try {
        const answer = await request('/auth/login', { method: 'POST', body: { username: username.value.trim(), password: password.value } });
        showCode(answer);
      } catch (err) {
        showError(error, err.message);
        password.select();
      }
    });
  });
}

function showCode(session, message = '') {
  setCsrf(session.csrf);
  const error = errorBox();
  let recovery = false;
  const code = input({ inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, attrs: { dir: 'ltr' }, className: 'input code-input' });
  const codeLabel = h('label', { htmlFor: 'codeInput', text: 'رمز التحقق' });
  code.id = 'codeInput';
  const hint = h('p', { className: 'hint', text: 'افتح تطبيق المصادقة على هاتفك واكتب الرمز المكوّن من 6 أرقام.' });
  const toggle = h('button', { className: 'link-btn', type: 'button', text: 'استخدم رمزًا احتياطيًا' });
  const other = h('button', { className: 'link-btn auth-other', type: 'button', text: 'الدخول بحساب آخر' });
  const form = h(
    'form',
    { className: 'auth-form', noValidate: true },
    h('h1', { text: 'رمز التحقق' }),
    error,
    h('div', { className: 'field' }, codeLabel, code, hint),
    toggle,
    h('button', { className: 'btn btn-primary btn-xl auth-submit', type: 'submit', text: 'تأكيد' }),
    other,
  );
  fill(view, authCard(form));
  showError(error, message);
  code.focus();
  toggle.addEventListener('click', () => {
    recovery = !recovery;
    codeLabel.textContent = recovery ? 'رمز احتياطي' : 'رمز التحقق';
    hint.textContent = recovery ? 'أحد الرموز العشرة التي طُبعت عند إنشاء الحساب، مثل k7m2p-x9q4r. كل رمز يعمل مرة واحدة.' : 'افتح تطبيق المصادقة على هاتفك واكتب الرمز المكوّن من 6 أرقام.';
    toggle.textContent = recovery ? 'استخدم رمز التطبيق' : 'استخدم رمزًا احتياطيًا';
    Object.assign(code, { value: '', maxLength: recovery ? 20 : 7, inputMode: recovery ? 'text' : 'numeric', autocomplete: recovery ? 'off' : 'one-time-code' });
    code.focus();
  });
  other.addEventListener('click', signOut);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = code.value.trim();
    if (!value) return showError(error, recovery ? 'اكتب الرمز الاحتياطي' : 'اكتب رمز التحقق');
    await busy(form, async () => {
      try {
        const answer = await request('/auth/code', { method: 'POST', body: recovery ? { recoveryCode: value } : { code: value } });
        if (typeof answer.recoveryCodesLeft === 'number') toast(`بقيت ${answer.recoveryCodesLeft} من الرموز الاحتياطية`);
        signedIn(answer);
      } catch (err) {
        if (err.code === 'SESSION_ENDED' || err.code === 'AUTH_EXPIRED') return signedOut(err.message);
        showError(error, err.message);
        code.select();
      }
    });
  });
}

function signedIn(answer) {
  me = answer;
  setCsrf(answer.csrf);
  adminName.textContent = answer.admin.username;
  topbar.hidden = false;
  document.body.classList.remove('auth-page');
  route();
}

// The code again, for the riskiest actions (valid 5 minutes): from the authenticator, or a
// recovery code when the phone is not at hand, as at sign-in
function stepUp() {
  let recovery = false;
  const code = input({ inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, attrs: { dir: 'ltr' }, className: 'input code-input' });
  const codeField = field('رمز التحقق', code);
  const toggle = h('button', { className: 'link-btn', type: 'button', text: 'استخدم رمزًا احتياطيًا' });
  toggle.addEventListener('click', () => {
    recovery = !recovery;
    codeField.querySelector('label').textContent = recovery ? 'رمز احتياطي' : 'رمز التحقق';
    toggle.textContent = recovery ? 'استخدم رمز التطبيق' : 'استخدم رمزًا احتياطيًا';
    Object.assign(code, { value: '', maxLength: recovery ? 20 : 7, inputMode: recovery ? 'text' : 'numeric', autocomplete: recovery ? 'off' : 'one-time-code' });
    code.focus();
  });
  return dialog({
    title: 'تأكيد بهويتك',
    lead: 'هذا الإجراء يحتاج رمز التحقق من تطبيق المصادقة، أو أحد رموزك الاحتياطية. يبقى التأكيد صالحًا 5 دقائق.',
    body: [codeField, toggle],
    onSubmit: async () => {
      const value = code.value.trim();
      if (!value) throw new Error(recovery ? 'اكتب الرمز الاحتياطي' : 'اكتب رمز التحقق');
      await request('/step-up', { method: 'POST', body: recovery ? { recoveryCode: value } : { code: value } });
      return true;
    },
  }).then(Boolean);
}

setHandlers({ stepUp, signedOut: (err) => signedOut(err.message) });

// Ends this session (at either stage), then shows the sign-in form. A token made stale by
// signing in again in another tab is fetched again once; a sign-out that did not get through
// leaves the panel as it is and says so, never a sign-in form over a session still alive.
async function signOut() {
  const send = () => request('/auth/logout', { method: 'POST' });
  try {
    await send().catch(async (err) => {
      if (err.code !== 'CSRF_FAILED') throw err;
      await request('/me');
      return send();
    });
  } catch (err) {
    if (err.code !== 'AUTH_EXPIRED' && err.code !== 'SESSION_ENDED') {
      toast('تعذّر تسجيل الخروج، أعد المحاولة', 'error');
      return;
    }
  }
  signedOut();
}

document.getElementById('logout').addEventListener('click', signOut);

/* Screens */

function page(title, { back, actions = [] } = {}, ...children) {
  return h(
    'section',
    { className: 'admin-page' },
    h('div', { className: 'sales-head' }, h('div', {}, back ? h('a', { className: 'back-link', href: back[0], text: back[1] }) : null, h('h1', { text: title })), actions.length ? h('div', { className: 'head-actions' }, actions) : null),
    ...children,
  );
}

const loading = () => h('p', { className: 'muted', text: 'جارٍ التحميل…' });

async function loadOverview() {
  overview = await request('/overview').catch(() => overview);
  return overview;
}

function notices(o) {
  if (!o) return null;
  const items = [];
  if (o.mode === 'local') items.push(h('p', { className: 'admin-notice', text: 'وضع التطوير: الشهادات تُعدّ صادرة فورًا، والنسخ الاحتياطية تُحفظ داخل مجلد التطبيق (.pos-local).' }));
  for (const p of o.monitor?.problems ?? []) items.push(h('p', { className: `admin-notice is-${p.level === 'error' ? 'stop' : 'warn'}`, text: p.message }));
  return items;
}

const FILTERS = [['', 'الكل'], ['active', 'نشط'], ['provisioning', 'قيد التجهيز'], ['suspended', 'موقوف'], ['pending_deletion', 'بانتظار الحذف'], ['deleted', 'محذوف']];

async function showShops(current) {
  const count = h('span', { className: 'catalog-count' });
  const search = input({ type: 'search', placeholder: 'بحث بالاسم أو العنوان', className: 'input search', attrs: { 'aria-label': 'بحث' } });
  let filter = '';
  const chips = h(
    'div',
    { className: 'chips', attrs: { role: 'group', 'aria-label': 'تصفية حسب الحالة' } },
    FILTERS.map(([value, label]) => h('button', { className: 'chip', type: 'button', text: label, dataset: { value }, attrs: { 'aria-pressed': String(value === '') } })),
  );
  const tbody = h('tbody');
  const empty = h('div', { className: 'empty', hidden: true }, h('h3', { text: 'لا توجد متاجر' }), h('p', { text: 'أنشئ أول متجر بزر «متجر جديد».' }));
  const table = h('table', { className: 'ptable shops-table' }, h('thead', {}, h('tr', {}, ['الاسم', 'العنوان', 'الحالة', 'الفواتير', 'حجم البيانات', 'آخر نشاط', 'الشهادة'].map((t, i) => h('th', { className: i === 3 || i === 4 ? 'end' : '', text: t })))), tbody);
  const notes = h('div');
  fill(view, page('المتاجر', { actions: [h('a', { className: 'btn btn-primary', href: '#/new', text: 'متجر جديد' })] }, count, notes, h('div', { className: 'admin-tools' }, search, chips), h('div', { className: 'table-scroll' }, table), empty));

  const [tenants, o] = await Promise.all([request('/tenants'), loadOverview()]);
  if (!current()) return;
  fill(notes, notices(o));
  if (o) count.textContent = `${o.limits.tenants} من ${o.limits.maxTenants} متجرًا كحد أقصى، وأُنشئ خلال 24 ساعة ${o.limits.newToday} من ${o.limits.maxNewPerDay}`;
  const open = (t) => {
    location.hash = shopHref(t);
  };
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const shown = tenants.filter((t) => (!filter || t.status === filter) && (!q || [t.slug, t.label, t.shopName, t.host].some((v) => String(v).toLowerCase().includes(q))));
    fill(tbody, shown.map((t) => shopRow(t, { onOpen: open })));
    table.hidden = !shown.length;
    empty.hidden = Boolean(shown.length);
    if (tenants.length && !shown.length) fill(empty, h('h3', { text: 'لا نتائج' }), h('p', { text: 'غيّر البحث أو التصفية.' }));
  };
  search.addEventListener('input', render);
  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.value;
    for (const c of chips.children) c.setAttribute('aria-pressed', String(c === chip));
    render();
  });
  render();
}

// The address as it is typed: lower case, checked 300 ms after the last key
function slugField({ tenantId, onState }) {
  const slug = input({ maxLength: 30, autocomplete: 'off', autocapitalize: 'none', spellcheck: false, attrs: { dir: 'ltr', 'aria-describedby': 'slugStatus' } });
  const suffix = h('span', { className: 'slug-suffix', text: `.${overview?.baseDomain ?? ''}` });
  const status = h('p', { className: 'slug-status', id: 'slugStatus', attrs: { 'aria-live': 'polite' } });
  let timer = null;
  let seq = 0;
  const set = (state, message) => {
    status.className = `slug-status ${state ? `is-${state}` : ''}`;
    status.textContent = message;
    onState?.(state === 'ok');
  };
  slug.addEventListener('input', () => {
    const value = slug.value.toLowerCase().replace(/\s/g, '');
    if (value !== slug.value) slug.value = value;
    clearTimeout(timer);
    if (!value) return set('', '');
    set('wait', 'جارٍ الفحص…');
    const mine = ++seq;
    timer = setTimeout(async () => {
      try {
        const query = new URLSearchParams({ slug: value, ...(tenantId ? { tenant: tenantId } : {}) });
        const answer = await request(`/slug-check?${query}`);
        if (mine !== seq) return;
        set(answer.status === 'available' ? 'ok' : 'bad', answer.status === 'invalid' ? `غير صالح: ${answer.message.replace(/^غير صالح: /, '')}` : answer.message);
      } catch (err) {
        if (mine === seq) set('bad', err.message);
      }
    }, 300);
  });
  return { input: slug, element: h('div', { className: 'field' }, h('label', { htmlFor: slug.id || (slug.id = 'slugInput'), text: 'العنوان' }), h('div', { className: 'slug-field' }, slug, suffix), status) };
}

function zoneSelect(current = 'Asia/Baghdad') {
  const zones = ZONES.some(([z]) => z === current) ? ZONES : [[current, current], ...ZONES];
  return h('select', { className: 'input' }, zones.map(([zone, label]) => h('option', { value: zone, selected: zone === current, text: label === zone ? zone : `${label} (${zone})` })));
}

// label: the name it is shown under, which screen readers read too
function passwordField(initial, { username, slug, label = 'كلمة المرور الأولى' }) {
  const value = input({ readOnly: true, value: initial, className: 'input num password-out', attrs: { dir: 'ltr', 'aria-label': label } });
  const copyBtn = h('button', { className: 'btn', type: 'button', text: 'نسخ', on: { click: () => copy(value.value) } });
  const again = h('button', { className: 'btn btn-ghost', type: 'button', text: 'توليد غيرها', on: { click: () => (value.value = generatePassword({ avoid: [username(), slug()] })) } });
  return { input: value, element: h('div', { className: 'input-group' }, value, copyBtn, again) };
}

async function showNewShop(current) {
  await loadOverview();
  if (!current()) return;
  const requestId = newRequestId();
  const error = errorBox();
  const label = input({ maxLength: 80 });
  const shopName = input({ maxLength: 60 });
  const slug = slugField({});
  const zone = zoneSelect();
  const currency = input({ maxLength: 10, value: 'د.ع' });
  const owner = input({ maxLength: 32, value: 'owner', autocomplete: 'off', autocapitalize: 'none', spellcheck: false, attrs: { dir: 'ltr' } });
  const password = passwordField(generatePassword({ avoid: ['owner'] }), { username: () => owner.value, slug: () => slug.input.value });
  const phone = input({ type: 'tel', maxLength: 30, attrs: { dir: 'ltr', inputmode: 'tel' } });
  const first = input({ inputMode: 'numeric', placeholder: '1', maxLength: 10, attrs: { dir: 'ltr' } });
  const notes = h('textarea', { className: 'input', rows: 3, maxLength: 1000 });
  const submit = h('button', { className: 'btn btn-primary', type: 'submit', text: 'إنشاء المتجر' });
  const form = h(
    'form',
    { className: 'settings-card', noValidate: true },
    error,
    h('div', { className: 'field-row' }, field('التسمية', label, 'اسم المتجر عندك، لا يراه صاحبه'), field('اسم المتجر على الإيصال', shopName, 'يظهر في أعلى صفحات المتجر وعلى الإيصال')),
    slug.element,
    h('div', { className: 'field-row' }, field('المنطقة الزمنية', zone), field('العملة', currency, 'تسمية للعرض فقط')),
    h('div', { className: 'field-row' }, field('اسم مستخدم المالك', owner), h('div', { className: 'field' }, h('span', { className: 'field-label', text: 'كلمة المرور الأولى' }), password.element, h('p', { className: 'hint', text: 'تُعرض الآن فقط: انسخها وأرسلها لصاحب المتجر. الخادم يحفظ الهاش فقط، ويُطلب تغييرها عند أول دخول.' }))),
    h('div', { className: 'field-row' }, field('الهاتف', phone), field('رقم أول فاتورة', first, 'اختياري، والافتراضي 1')),
    field('ملاحظات', notes),
    h('div', { className: 'dialog-actions' }, submit),
  );
  fill(view, page('متجر جديد', { back: ['#/', 'المتاجر'] }, h('div', { className: 'settings' }, form)));
  label.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(error, '');
    if (!shopName.value.trim()) return showError(error, 'اكتب اسم المتجر');
    if (!slug.input.value) return showError(error, 'اكتب العنوان');
    await busy(form, async () => {
      try {
        const answer = await request('/tenants', {
          method: 'POST',
          body: {
            requestId,
            label: label.value,
            shopName: shopName.value,
            slug: slug.input.value,
            timeZone: zone.value,
            currency: currency.value,
            ownerUsername: owner.value.trim().toLowerCase(),
            ownerPassword: password.input.value,
            phone: phone.value,
            notes: notes.value,
            firstInvoiceNumber: first.value.trim(),
          },
        });
        // passwordSet false: this form was sent before (its answer lost) and the account was
        // made then, with the password shown at the time, not this one: none is kept to show
        const kept = answer.passwordSet !== false;
        secrets.set(answer.tenant.id, { username: owner.value.trim().toLowerCase(), password: kept ? password.input.value : null, url: answer.tenant.url });
        location.hash = answer.job ? `#/job/${answer.job.id}` : `#/shop/${answer.tenant.id}`;
      } catch (err) {
        showError(error, err.message);
        error.scrollIntoView({ block: 'center' });
      }
    });
  });
}

// A job's progress, looked at every 2 seconds while it runs
async function showJob(id) {
  const body = h('div', { className: 'settings' }, loading());
  const title = h('h1', { text: 'العمل' });
  const back = h('a', { className: 'back-link', href: '#/', text: 'المتاجر' });
  fill(view, h('section', { className: 'admin-page' }, h('div', { className: 'sales-head' }, h('div', {}, back, title)), body));
  let timer = null;
  let stopped = false;
  leaveScreen = () => {
    stopped = true;
    clearTimeout(timer);
  };

  // poll: a look taken by the timer, not by the admin (it does not keep the session alive)
  async function refresh(poll = false) {
    let job;
    try {
      job = await request(`/jobs/${id}`, { poll });
    } catch (err) {
      if (!stopped) fill(body, h('p', { className: 'form-error', text: err.message }));
      return;
    }
    if (stopped) return;
    const t = job.tenant;
    const running = ['queued', 'running'].includes(job.status);
    title.textContent = job.type === 'provision' && running ? 'جارٍ تجهيز المتجر…' : `${JOB_LABELS[job.type] ?? job.type}: ${JOB_STATUS[job.status] ?? job.status}`;
    if (t) {
      back.href = `#/shop/${t.id}`;
      back.textContent = t.label || t.slug;
    }
    const parts = [h('div', { className: 'settings-card' }, t ? h('p', { className: 'job-shop' }, h('strong', { text: t.label || t.slug }), ' ', h('span', { className: 'host-name', text: t.host })) : null, stepList(job))];
    if (job.status === 'failed') {
      const error = errorBox();
      const retry = h('button', { className: 'btn btn-primary', type: 'button', text: 'إعادة المحاولة' });
      // Offered only for the jobs that can be given up (the server says which)
      const cancel = job.cancellable ? h('button', { className: 'btn danger', type: 'button', text: 'إلغاء العمل' }) : null;
      const box = h('div', { className: 'settings-card is-failed' }, h('p', { className: 'form-error', text: job.error || 'فشلت خطوة' }), error, h('div', { className: 'dialog-actions' }, retry, cancel));
      retry.addEventListener('click', () =>
        busy(box, async () => {
          try {
            await request(`/jobs/${id}/retry`, { method: 'POST' });
            await refresh();
          } catch (err) {
            showError(error, err.message);
          }
        }),
      );
      cancel?.addEventListener('click', async () => {
        const lead = CANCEL_LEADS[job.type] ?? 'يتوقف العمل حيث هو، ويعود المتجر كما كان قدر الإمكان.';
        const ok = await dialog({ title: 'إلغاء العمل', lead, submitText: 'إلغاء العمل', danger: true, onSubmit: () => request(`/jobs/${id}/cancel`, { method: 'POST' }) });
        if (ok) refresh();
      });
      parts.push(box);
    }
    if (job.status === 'done' && job.type === 'provision' && t) parts.push(readyCard(t, job));
    else if (job.status === 'done' && t) parts.push(h('p', {}, h('a', { className: 'btn', href: `#/shop/${t.id}`, text: 'صفحة المتجر' })));
    fill(body, parts);
    if (running) timer = setTimeout(() => refresh(true), 2000);
  }
  await refresh();
}

// What giving up a failed job does, said before it is done
const CANCEL_LEADS = Object.freeze({
  provision: 'يُلغى تجهيز المتجر نهائيًا: يتوقف عنوانه ولا يُعطى لمتجر آخر، وتُحذف قاعدة بياناته إن أُنشئت، ولا يُحسب بعدها ضمن الحد الأقصى للمتاجر.',
  rename: 'العنوان الجديد المحجوز لن يُستخدم بعد الآن.',
  purge: 'يُلغى الحذف النهائي ويعود المتجر موقوفًا كما كان، ثم يمكنك استئنافه أو حذفه من جديد.',
});

// The new shop's address and sign-in, the password from this page's memory only
function readyCard(t, job) {
  const secret = secrets.get(t.id);
  const username = secret?.username ?? job.owner?.username ?? 'owner';
  const password = secret?.password ?? null;
  // No password to show: the page was loaded again, or the account was made by an earlier
  // send of the form with the password shown then
  const missing = secret ? 'غير متاحة هنا: أُنشئ الحساب بكلمة المرور التي ظهرت عند الإرسال الأول. أعد تعيينها من صفحة المتجر.' : 'غير متاحة هنا (أُعيد تحميل الصفحة). أعد تعيينها من صفحة المتجر.';
  const lines = [`المتجر: ${t.shopName || t.label}`, `العنوان: ${t.url}`, `اسم المستخدم: ${username}`, password ? `كلمة المرور المؤقتة: ${password}` : null].filter(Boolean);
  return h(
    'div',
    { className: 'settings-card ready-card' },
    h('h2', { text: 'المتجر جاهز' }),
    facts([
      ['العنوان', h('a', { className: 'host-name', href: t.url, text: t.url, target: '_blank', rel: 'noopener' })],
      ['اسم المستخدم', h('span', { className: 'num', text: username })],
      ['كلمة المرور المؤقتة', password ? h('span', { className: 'num password-out', text: password }) : h('span', { className: 'muted', text: missing })],
    ]),
    h('p', { className: 'hint', text: 'أرسلها لصاحب المتجر، وسيُطلب منه تغيير كلمة المرور عند أول دخول.' }),
    h('div', { className: 'dialog-actions' }, h('button', { className: 'btn btn-go', type: 'button', text: 'نسخ الكل', on: { click: () => copy(lines.join('\n')) } }), h('a', { className: 'btn', href: `#/shop/${t.id}`, text: 'صفحة المتجر' })),
  );
}

/* A shop */

function card(title, ...children) {
  return h('section', { className: 'settings-card' }, h('h2', { text: title }), ...children);
}

function table(heads, rows, emptyText) {
  if (!rows.length) return h('p', { className: 'muted', text: emptyText });
  return h('div', { className: 'table-scroll' }, h('table', { className: 'ptable' }, h('thead', {}, h('tr', {}, heads.map((t) => h('th', { text: t })))), h('tbody', {}, rows)));
}

async function showShop(id, current) {
  // Drawn again after an action (reload): not over a screen opened since
  if (!current()) return;
  fill(view, page('المتجر', { back: ['#/', 'المتاجر'] }, loading()));
  const t = await request(`/tenants/${id}`);
  // Another screen opened while this one loaded: its answer must not replace that screen
  if (!current()) return;
  const reload = () => showShop(id, current);
  const open = ['active', 'suspended', 'pending_deletion'].includes(t.status);
  const parts = [];

  if (t.activeJob) {
    parts.push(h('p', { className: `admin-notice ${t.activeJob.status === 'failed' ? 'is-stop' : ''}` }, `${JOB_LABELS[t.activeJob.type] ?? t.activeJob.type}: ${JOB_STATUS[t.activeJob.status] ?? t.activeJob.status}. `, h('a', { href: `#/job/${t.activeJob.id}`, text: 'متابعة' })));
  }
  if (t.deletion) parts.push(h('p', { className: 'admin-notice is-stop', text: `بانتظار الحذف: يُحذف نهائيًا بعد ${formatDate(t.deletion.purgeAfter)}، ويمكن إلغاء الحذف قبل ذلك.` }));

  // Information
  const usage = t.usage ?? {};
  parts.push(
    card(
      'المعلومات',
      facts([
        ['العنوان', h('a', { className: 'host-name', href: t.url, text: t.url, target: '_blank', rel: 'noopener' })],
        ['اسم المتجر', t.shopName || '—'],
        ['الحالة', h('span', {}, statusBadge(t.status), t.statusReason ? h('span', { className: 'pcat', text: t.statusReason }) : null)],
        ['الشهادة', h('span', {}, certBadge(t.cert), t.cert?.lastError ? h('span', { className: 'pcat', text: t.cert.lastError }) : null, t.cert?.expiresAt ? h('span', { className: 'pcat', text: `صالحة حتى ${formatDate(t.cert.expiresAt)}` }) : null)],
        ['الفواتير', formatNumber(usage.salesCount)],
        ['المنتجات', formatNumber(usage.productsCount)],
        ['حجم البيانات', formatBytes(usage.dataBytes)],
        ['آخر بيع', formatDateTime(usage.lastSaleAt)],
        ['آخر نشاط', formatAgo(t.lastActivityAt)],
        ['أُنشئ', formatDateTime(t.createdAt)],
        ['قاعدة البيانات', h('span', { className: 'num', text: t.dbName })],
        t.hosts.length > 1 ? ['العناوين', h('ul', { className: 'plain-list' }, t.hosts.map((x) => h('li', {}, h('span', { className: 'host-name', text: x.host }), ` (${{ primary: 'أساسي', reserved: 'محجوز', redirect: `يحوّل حتى ${formatDate(x.redirectUntil)}`, retired: 'متوقف' }[x.kind] ?? x.kind})`)))] : null,
      ]),
      notesForm(t),
    ),
  );

  if (open && t.settings) parts.push(settingsForm(t));
  if (open) {
    parts.push(card('حسابات الدخول', table(['اسم المستخدم', 'الدور', 'الحالة', 'آخر دخول', ''], t.users.map((u) => userRow(u, { onReset: (user) => resetPassword(t, user, reload) })), 'لا توجد حسابات')));
    const revoke = h('button', { className: 'btn danger', type: 'button', text: 'إلغاء كل الجلسات', disabled: !t.sessions.length });
    revoke.addEventListener('click', async () => {
      const ok = await dialog({ title: 'إلغاء كل الجلسات', lead: `يخرج كل من دخل إلى ${t.slug} من كل الأجهزة، ويحتاج الدخول من جديد.`, submitText: 'إلغاء الجلسات', danger: true, onSubmit: () => request(`/tenants/${t.id}/sessions/revoke`, { method: 'POST' }) });
      if (ok) reload();
    });
    parts.push(card('الجلسات النشطة', table(['المستخدم', 'الجهاز', 'IP', 'آخر استخدام', 'تنتهي'], t.sessions.map(sessionRow), 'لا توجد جلسات نشطة'), h('div', { className: 'dialog-actions' }, revoke)));

    const backupNow = h('button', { className: 'btn', type: 'button', text: 'نسخة الآن', disabled: Boolean(t.activeJob) });
    backupNow.addEventListener('click', async () => {
      try {
        const { job } = await request(`/tenants/${t.id}/backups`, { method: 'POST' });
        location.hash = `#/job/${job.id}`;
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    const canRestore = ['active', 'suspended'].includes(t.status) && !t.activeJob;
    parts.push(card('النسخ الاحتياطية', table(['التاريخ', 'النوع', 'الحجم', ''], t.backups.map((b) => backupRow(b, { onRestore: canRestore ? (x) => restore(t, x) : null })), 'لا توجد نسخ بعد'), h('div', { className: 'dialog-actions' }, backupNow)));
    parts.push(exportCard(t));
  }
  parts.push(dangerZone(t, reload));

  fill(view, page(t.label || t.slug, { back: ['#/', 'المتاجر'] }, h('div', { className: 'shop-detail' }, parts)));
}

function notesForm(t) {
  const label = input({ maxLength: 80, value: t.label });
  const phone = input({ type: 'tel', maxLength: 30, value: t.phone, attrs: { dir: 'ltr' } });
  const notes = h('textarea', { className: 'input', rows: 2, maxLength: 1000, value: t.notes });
  const error = errorBox();
  const form = h('form', { className: 'notes-form', noValidate: true }, h('h3', { text: 'ملاحظاتك' }), error, h('div', { className: 'field-row' }, field('التسمية', label), field('الهاتف', phone)), field('ملاحظات', notes), h('div', { className: 'dialog-actions' }, h('button', { className: 'btn', type: 'submit', text: 'حفظ' })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy(form, async () => {
      try {
        await request(`/tenants/${t.id}`, { method: 'PUT', body: { label: label.value, phone: phone.value, notes: notes.value } });
        toast('حُفظت');
      } catch (err) {
        showError(error, err.message);
      }
    });
  });
  return form;
}

function settingsForm(t) {
  const s = t.settings;
  const shopName = input({ maxLength: 60, value: s.shopName });
  const phone = input({ type: 'tel', maxLength: 30, value: s.phone, attrs: { dir: 'ltr' } });
  const address = input({ maxLength: 120, value: s.address });
  const receiptNote = input({ maxLength: 120, value: s.receiptNote });
  const zone = zoneSelect(s.timeZone || 'Asia/Baghdad');
  const currency = input({ maxLength: 10, value: s.currency });
  const error = errorBox();
  const form = h(
    'form',
    { noValidate: true },
    error,
    h('div', { className: 'field-row' }, field('اسم المتجر', shopName), field('الهاتف', phone)),
    field('عنوان المحل', address),
    field('ملاحظة الإيصال', receiptNote),
    h('div', { className: 'field-row' }, field('المنطقة الزمنية', zone), field('العملة', currency)),
    h('div', { className: 'dialog-actions' }, h('button', { className: 'btn btn-primary', type: 'submit', text: 'حفظ الإعدادات' })),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy(form, async () => {
      try {
        await request(`/tenants/${t.id}/settings`, { method: 'PUT', body: { shopName: shopName.value, phone: phone.value, address: address.value, receiptNote: receiptNote.value, timeZone: zone.value, currency: currency.value } });
        toast('حُفظت إعدادات المتجر');
        showError(error, '');
      } catch (err) {
        showError(error, err.message);
      }
    });
  });
  return card('إعدادات المتجر', h('p', { className: 'hint', text: 'نفس إعدادات صفحة «الإعدادات» عند صاحب المتجر: الاسم والهاتف والعنوان تظهر على الإيصال.' }), form);
}

async function resetPassword(t, user, reload) {
  const password = passwordField(generatePassword({ avoid: [user.username, t.slug] }), { username: () => user.username, slug: () => t.slug, label: 'كلمة المرور المؤقتة' });
  const done = await dialog({
    title: `كلمة مرور جديدة لـ ${user.username}`,
    lead: 'تنتهي كل جلسات هذا الحساب فورًا، ويُطلب من صاحبه تغيير هذه الكلمة عند الدخول التالي. تظهر مرة أخرى بعد التأكيد لتنسخها، ثم لا تظهر أبدًا.',
    body: [h('div', { className: 'field' }, h('span', { className: 'field-label', text: 'كلمة المرور المؤقتة' }), password.element)],
    submitText: 'تعيين كلمة المرور',
    danger: true,
    onSubmit: async () => {
      await request(`/tenants/${t.id}/users/${user.id}/password`, { method: 'POST', body: { password: password.input.value } });
      return password.input.value;
    },
  });
  if (done) {
    // Set already: closing only hides it, so the button says «إغلاق». A copy that failed
    // keeps it open, the password selected to copy by hand.
    const shown = h('span', { className: 'num password-out', text: done });
    await dialog({
      title: 'تم تعيين كلمة المرور',
      lead: 'أرسلها لصاحب المتجر مع العنوان واسم المستخدم. لن تظهر بعد إغلاق هذه النافذة.',
      body: [facts([['العنوان', t.url], ['اسم المستخدم', user.username], ['كلمة المرور المؤقتة', shown]])],
      submitText: 'نسخ الكل وإغلاق',
      cancelText: 'إغلاق',
      onSubmit: async () => {
        if (await copy(`العنوان: ${t.url}\nاسم المستخدم: ${user.username}\nكلمة المرور المؤقتة: ${done}`)) return true;
        getSelection()?.selectAllChildren(shown);
        throw new Error('تعذّر النسخ. انسخ كلمة المرور المحددة يدويًا، ثم أغلق النافذة');
      },
    });
    reload();
  }
}

async function restore(t, backup) {
  const ok = await dialog({
    title: 'استعادة نسخة احتياطية',
    lead: `نسخة ${formatDateTime(backup.createdAt)}.`,
    body: [
      h(
        'ul',
        { className: 'warn-list' },
        h('li', { text: 'يُوقف المتجر أثناء الاستعادة ويخرج الجميع، ثم يُستأنف إن كان نشطًا.' }),
        h('li', { text: 'تحل بيانات النسخة (المنتجات والمبيعات وكل شيء) محل البيانات الحالية. تؤخذ نسخة من البيانات الحالية أولًا وتُحفظ القاعدة الحالية 7 أيام.' }),
        h('li', { text: 'حسابات الدخول وكلمات مرورها تبقى كما هي الآن.' }),
      ),
    ],
    submitText: 'استعادة',
    danger: true,
    onSubmit: () => request(`/tenants/${t.id}/restore`, { method: 'POST', body: { archive: backup.path } }),
  });
  if (ok?.job) location.hash = `#/job/${ok.job.id}`;
}

function exportCard(t) {
  const now = new Date();
  const month = input({ type: 'month', value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, className: 'input month-input' });
  // The month and its days on the shop's clock, not this computer's: the same figures as
  // the owner's sales page and export
  const zone = t.settings?.timeZone || 'Asia/Baghdad';
  const run = async (kind) => {
    let query = '';
    if (kind === 'sales') {
      const range = monthRange(month.value, zone);
      if (!range) return toast('اختر الشهر', 'error');
      query = `?${new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString(), tz: zone })}`;
    }
    try {
      await download(`/tenants/${t.id}/export/${kind}${query}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return card(
    'تصدير البيانات',
    h('p', { className: 'hint', text: 'ملفات CSV تفتح في Excel بالعربية. يحتاج التصدير رمز التحقق.' }),
    h(
      'div',
      { className: 'export-row' },
      h('button', { className: 'btn', type: 'button', text: 'المنتجات', on: { click: () => run('products') } }),
      h('label', { className: 'export-month' }, 'مبيعات شهر', month),
      h('button', { className: 'btn', type: 'button', text: 'المبيعات حسب اليوم', on: { click: () => run('sales') } }),
      h('button', { className: 'btn', type: 'button', text: 'الديون', on: { click: () => run('debts') } }),
    ),
  );
}

function dangerZone(t, reload) {
  const actions = [];
  const go = (answer) => {
    if (answer?.job) location.hash = `#/job/${answer.job.id}`;
    else if (answer) reload();
  };
  if (t.status === 'active') {
    const reason = input({ maxLength: 200, placeholder: 'مثل: لم يُدفع الاشتراك' });
    actions.push([
      'إيقاف المتجر',
      'يُغلق المتجر فورًا ويخرج الجميع. الصفحات المفتوحة تعرض «هذا المتجر موقوف مؤقتًا» دون أن تضيع السلة.',
      () => dialog({ title: `إيقاف ${t.slug}`, body: [field('السبب (يراه المسؤول فقط)', reason)], submitText: 'إيقاف', danger: true, onSubmit: () => request(`/tenants/${t.id}/suspend`, { method: 'POST', body: { reason: reason.value } }) }).then(go),
    ]);
  }
  if (t.status === 'suspended') {
    actions.push(['استئناف المتجر', 'يعود المتجر للعمل، ويدخل الجميع من جديد.', () => dialog({ title: `استئناف ${t.slug}`, submitText: 'استئناف', onSubmit: () => request(`/tenants/${t.id}/resume`, { method: 'POST' }) }).then(go)]);
  }
  if (['active', 'suspended'].includes(t.status) && !t.activeJob) {
    actions.push([
      'تغيير العنوان',
      'عنوان جديد بشهادته، والقديم يحوّل إليه 90 يومًا.',
      async () => {
        let ok = false;
        const slug = slugField({ tenantId: t.id, onState: (state) => (ok = state) });
        const answer = await dialog({
          title: `تغيير عنوان ${t.slug}`,
          body: [
            slug.element,
            h(
              'ul',
              { className: 'warn-list' },
              h('li', { text: 'الجميع سيحتاج تسجيل الدخول من جديد على العنوان الجديد.' }),
              h('li', { text: 'مسودة الشراء وترتيب المنتجات المحفوظان في المتصفح سيضيعان.' }),
              h('li', { text: 'الإشارات المرجعية للعنوان القديم تعمل خلال مهلة التوجيه (90 يومًا) فقط.' }),
            ),
          ],
          submitText: 'تغيير العنوان',
          danger: true,
          onSubmit: () => {
            if (!ok) throw new Error('اختر عنوانًا متاحًا');
            return request(`/tenants/${t.id}/rename`, { method: 'POST', body: { slug: slug.input.value } });
          },
        });
        go(answer);
      },
    ]);
    const confirm = input({ autocomplete: 'off', autocapitalize: 'none', spellcheck: false, attrs: { dir: 'ltr' } });
    actions.push([
      'حذف المتجر',
      'نسخة احتياطية مُتحقَّق منها أولًا، ثم يُغلق المتجر 30 يومًا يمكن خلالها إلغاء الحذف، ثم تُحذف بياناته نهائيًا. العنوان لا يُعطى لمتجر آخر أبدًا.',
      () => dialog({ title: `حذف ${t.slug}`, body: [field(`اكتب عنوان المتجر (${t.slug}) للتأكيد`, confirm)], submitText: 'حذف المتجر', danger: true, onSubmit: () => request(`/tenants/${t.id}/delete`, { method: 'POST', body: { confirm: confirm.value } }) }).then(go),
    ]);
  }
  if (t.status === 'pending_deletion') {
    actions.push(['إلغاء الحذف', 'يعود المتجر موقوفًا كما كان، ثم يمكنك استئنافه.', () => dialog({ title: 'إلغاء الحذف', submitText: 'إلغاء الحذف', onSubmit: () => request(`/tenants/${t.id}/cancel-deletion`, { method: 'POST' }) }).then(go)]);
  }
  if (!actions.length) return null;
  return h(
    'section',
    { className: 'settings-card danger-zone' },
    h('h2', { text: 'منطقة الخطر' }),
    actions.map(([label, text, run]) => h('div', { className: 'danger-row' }, h('p', { text }), h('button', { className: 'btn danger', type: 'button', text: label, on: { click: run } }))),
  );
}

/* The audit log */

async function showAudit(params, current) {
  const tenantSelect = h('select', { className: 'input', attrs: { 'aria-label': 'المتجر' } }, h('option', { value: '', text: 'كل المتاجر' }));
  const actionSelect = h('select', { className: 'input', attrs: { 'aria-label': 'العملية' } }, h('option', { value: '', text: 'كل العمليات' }), Object.entries(ACTION_LABELS).map(([value, label]) => h('option', { value, text: label })));
  const tbody = h('tbody');
  const pager = h('div', { className: 'pager' });
  fill(view, page('سجل العمليات', {}, h('div', { className: 'admin-tools audit-filters' }, tenantSelect, actionSelect), h('div', { className: 'table-scroll' }, h('table', { className: 'ptable audit-table' }, h('thead', {}, h('tr', {}, ['العملية', 'الوقت', 'المتجر', 'التفاصيل', 'IP'].map((x) => h('th', { text: x })))), tbody)), pager));
  const tenants = await request('/tenants').catch(() => []);
  if (!current()) return;
  tenantSelect.append(...tenants.map((t) => h('option', { value: t.id, text: `${t.label || t.slug} (${t.slug})` })));
  tenantSelect.value = params.get('tenant') ?? '';
  actionSelect.value = params.get('action') ?? '';
  const go = (page) => {
    const q = new URLSearchParams();
    if (tenantSelect.value) q.set('tenant', tenantSelect.value);
    if (actionSelect.value) q.set('action', actionSelect.value);
    if (page > 1) q.set('page', String(page));
    location.hash = `#/audit${q.size ? `?${q}` : ''}`;
  };
  tenantSelect.addEventListener('change', () => go(1));
  actionSelect.addEventListener('change', () => go(1));
  const q = new URLSearchParams({ page: params.get('page') ?? '1' });
  if (tenantSelect.value) q.set('tenant', tenantSelect.value);
  if (actionSelect.value) q.set('action', actionSelect.value);
  const data = await request(`/audit?${q}`);
  if (!current()) return;
  fill(tbody, data.entries.map(auditRow));
  if (!data.entries.length) fill(tbody, h('tr', {}, h('td', { attrs: { colspan: '5' }, className: 'muted', text: 'لا توجد عمليات' })));
  fill(
    pager,
    h('button', { className: 'btn', type: 'button', text: 'السابق', disabled: data.page <= 1, on: { click: () => go(data.page - 1) } }),
    h('span', { className: 'muted', text: `صفحة ${data.page} من ${data.pages} (${data.total} عملية)` }),
    h('button', { className: 'btn', type: 'button', text: 'التالي', disabled: data.page >= data.pages, on: { click: () => go(data.page + 1) } }),
  );
}

/* The router */

// Each opening of a screen has its number: a screen whose answer comes back after another
// one was opened (a slow link) draws nothing, so the page never shows one shop at
// another's address, its buttons acting on the wrong one
let navSeq = 0;

async function route() {
  if (!me) return;
  leaveScreen();
  leaveScreen = () => {};
  const nav = ++navSeq;
  const current = () => nav === navSeq && Boolean(me);
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  for (const a of topbar.querySelectorAll('[data-nav]')) a.setAttribute('aria-current', String((parts[0] ?? 'shops') === a.dataset.nav || (a.dataset.nav === 'shops' && ['new', 'shop', 'job'].includes(parts[0]))));
  try {
    if (parts[0] === 'new') await showNewShop(current);
    else if (parts[0] === 'shop' && parts[1]) await showShop(parts[1], current);
    else if (parts[0] === 'job' && parts[1]) await showJob(parts[1]);
    else if (parts[0] === 'audit') await showAudit(new URLSearchParams(query), current);
    else await showShops(current);
    if (current()) window.scrollTo(0, 0);
  } catch (err) {
    if (!current()) return;
    if (err instanceof ApiError && (err.code === 'AUTH_EXPIRED' || err.code === 'SESSION_ENDED')) return;
    fill(view, page('تعذّر فتح الصفحة', { back: ['#/', 'المتاجر'] }, h('p', { className: 'form-error', text: err.message })));
  }
}
window.addEventListener('hashchange', route);

/* Start */

(async () => {
  try {
    const session = await request('/me');
    if (session.stage === 'code') showCode(session);
    else signedIn(session);
  } catch (err) {
    showLogin(err.code === 'AUTH_EXPIRED' || err.code === 'SESSION_ENDED' ? '' : err.message);
  }
})();
