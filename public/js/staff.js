// The «الموظفون» card of the settings page, for the owner (routes/staff.js): the staff
// accounts with their permissions, adding one, changing its name or permissions, a new
// first password, disabling and enabling. A password comes once, in its own window, and is
// kept nowhere: the window empties when it closes. Text goes in through escapeHtml or
// textContent only. The names of the permissions and the two quick choices are those of
// public/js/permissions.js, which the server uses too.
import { api, toast, escapeHtml, formatDateTime, withSignIn } from './common.js';
import { PERMISSIONS, PERMISSION_HINTS, PERMISSION_KEYS, PRESETS } from './permissions.js';

const $ = (id) => document.getElementById(id);
const els = {
  add: $('addStaffBtn'),
  list: $('staffList'),
  loadError: $('staffLoadError'),
  dialog: $('staffDialog'),
  form: $('staffForm'),
  title: $('staffDialogTitle'),
  error: $('staffError'),
  name: $('staffName'),
  username: $('staffUsername'),
  usernameHint: $('staffUsernameHint'),
  presets: $('staffPresets'),
  permissions: $('staffPermissionList'),
  submit: $('staffSubmit'),
  cancel: $('staffCancel'),
  credentials: $('credentialsDialog'),
  credentialsTitle: $('credentialsTitle'),
  credentialsLead: $('credentialsLead'),
  credentialsUrl: $('credentialsUrl'),
  credentialsUser: $('credentialsUser'),
  credentialsPassword: $('credentialsPassword'),
  credentialsCopy: $('credentialsCopy'),
  credentialsStatus: $('credentialsStatus'),
};

// afterCredentials: where the focus goes once the password window closes
const state = { staff: [], max: 20, editing: null, afterCredentials: null };
const USERNAME_HINT = els.usernameHint.textContent;

const showError = (el, message) => {
  el.textContent = message;
  el.hidden = !message;
};
// The window scrolls on a small phone: its error, at the top, is brought into view
const showDialogError = (message) => {
  showError(els.error, message);
  if (message) els.error.scrollIntoView({ block: 'nearest' });
};
const byId = (id) => state.staff.find((s) => s.id === id);

// The list is drawn again after each change, and the button that was pressed goes with it:
// the focus goes to the row's button now in its place (the first of `kinds` found), or to
// «إضافة موظف», rather than to the top of the page
function focusRow(id, kinds) {
  const button = kinds.map((kind) => els.list.querySelector(`[data-${kind}="${id}"]`)).find(Boolean);
  (button ?? els.add).focus();
}
const sameSet = (a, b) => a.length === b.length && a.every((key) => b.includes(key));

/* The list */

function permissionChips(keys) {
  if (!keys.length) return '<span class="muted">البيع نقدًا فقط</span>';
  if (keys.length === PERMISSION_KEYS.length) return '<span class="perm-chip is-all">كل الصلاحيات</span>';
  return keys.map((key) => `<span class="perm-chip">${escapeHtml(PERMISSIONS[key])}</span>`).join('');
}

function staffRow(s) {
  const badges = [
    s.disabled ? '<span class="badge is-cancelled">موقوف</span>' : '',
    !s.disabled && s.mustChangePassword ? '<span class="badge is-partial">لم يغيّر كلمة المرور المؤقتة</span>' : '',
  ].join('');
  const name = escapeHtml(s.displayName);
  return `<tr${s.disabled ? ' class="is-disabled"' : ''}>
    <td><div class="pname">${name}${badges}</div><div class="pcat num">${escapeHtml(s.username)}</div></td>
    <td><div class="perm-list">${permissionChips(s.permissions)}</div></td>
    <td>${s.lastLoginAt ? formatDateTime(s.lastLoginAt) : '<span class="muted">لم يدخل بعد</span>'}</td>
    <td class="row-actions">
      ${s.disabled ? '' : `<button class="btn btn-sm" type="button" data-edit="${s.id}" aria-label="تعديل ${name}">تعديل</button>`}
      ${s.disabled ? '' : `<button class="btn btn-sm" type="button" data-reset="${s.id}" aria-label="كلمة مرور جديدة لـ ${name}">كلمة مرور جديدة</button>`}
      ${
        s.disabled
          ? `<button class="btn btn-sm" type="button" data-enable="${s.id}" aria-label="تفعيل ${name}">تفعيل</button>`
          : `<button class="btn btn-sm btn-ghost danger" type="button" data-disable="${s.id}" aria-label="إيقاف ${name}">إيقاف</button>`
      }
    </td>
  </tr>`;
}

function render() {
  const active = state.staff.filter((s) => !s.disabled).length;
  const full = active >= state.max;
  const limit = `الحد الأقصى ${state.max} موظفًا مفعّلًا. أوقف حساب موظف لا يعمل لتضيف غيره`;
  els.add.disabled = full;
  els.add.title = full ? limit : '';
  // Said beside the list too: a disabled button's title never shows on a touch screen
  if (full) els.add.setAttribute('aria-describedby', 'staffCount');
  else els.add.removeAttribute('aria-describedby');
  if (!state.staff.length) {
    els.list.innerHTML = `<div class="staff-empty">
      <p>لا يوجد موظفون بعد. أضف موظفًا فيدخل باسمه وكلمة مروره، وتظهر الفواتير التي يبيعها باسمه.</p>
    </div>`;
    return;
  }
  els.list.innerHTML = `<p class="staff-count" id="staffCount"><span class="num">${active}</span> من <span class="num">${state.max}</span> موظفًا مفعّلًا${
    full ? `<span class="staff-full">. ${escapeHtml(limit)}</span>` : ''
  }</p>
    <table class="ptable staff-table">
      <thead><tr>
        <th scope="col">الموظف</th>
        <th scope="col">الصلاحيات</th>
        <th scope="col">آخر دخول</th>
        <th scope="col"><span class="sr-only">إجراءات</span></th>
      </tr></thead>
      <tbody>${state.staff.map(staffRow).join('')}</tbody>
    </table>`;
}

async function load() {
  try {
    const data = await api('/staff');
    state.staff = data.staff;
    state.max = data.max;
    showError(els.loadError, '');
    render();
  } catch (err) {
    showError(els.loadError, err.message);
  }
}

/* Adding and editing */

function buildForm() {
  els.permissions.innerHTML = PERMISSION_KEYS.map(
    (key) => `<label class="check perm-check">
      <input type="checkbox" value="${key}">
      <span><span class="perm-name">${escapeHtml(PERMISSIONS[key])}</span><span class="perm-hint">${escapeHtml(PERMISSION_HINTS[key])}</span></span>
    </label>`,
  ).join('');
  els.presets.innerHTML = Object.entries(PRESETS)
    .map(([id, preset]) => `<button class="btn btn-sm" type="button" data-preset="${id}" aria-pressed="false">${escapeHtml(preset.label)}</button>`)
    .join('');
}

const boxes = () => [...els.permissions.querySelectorAll('input[type="checkbox"]')];
const chosen = () => boxes().filter((b) => b.checked).map((b) => b.value);

// A quick choice shows as pressed while the boxes are exactly its permissions
function syncPresets() {
  const keys = chosen();
  for (const button of els.presets.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(sameSet(keys, PRESETS[button.dataset.preset].permissions)));
  }
}

function openForm(staff = null) {
  state.editing = staff;
  els.form.reset();
  showDialogError('');
  els.title.textContent = staff ? `تعديل «${staff.displayName}»` : 'إضافة موظف';
  els.submit.textContent = staff ? 'حفظ التعديل' : 'إضافة الموظف';
  els.name.value = staff?.displayName ?? '';
  els.username.value = staff?.username ?? '';
  els.username.disabled = Boolean(staff);
  els.usernameHint.textContent = staff ? 'اسم المستخدم لا يتغيّر' : USERNAME_HINT;
  // A new account starts as a cashier, the usual choice
  const keys = staff ? staff.permissions : PRESETS.cashier.permissions;
  for (const box of boxes()) box.checked = keys.includes(box.value);
  syncPresets();
  els.dialog.showModal();
  els.name.focus();
}

els.presets.addEventListener('click', (e) => {
  const button = e.target.closest('[data-preset]');
  if (!button) return;
  const keys = PRESETS[button.dataset.preset].permissions;
  for (const box of boxes()) box.checked = keys.includes(box.value);
  syncPresets();
});
els.permissions.addEventListener('change', syncPresets);
els.cancel.addEventListener('click', () => els.dialog.close());
els.add.addEventListener('click', () => openForm());

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const editing = state.editing;
  const displayName = els.name.value.trim();
  const username = els.username.value.trim().toLowerCase();
  let problem = '';
  if (!displayName) problem = 'اكتب اسم الموظف';
  else if (!editing && !username) problem = 'اكتب اسم المستخدم';
  showDialogError(problem);
  if (problem) {
    (displayName ? els.username : els.name).focus();
    return;
  }
  const permissions = chosen();
  els.submit.disabled = true;
  try {
    if (editing) {
      await withSignIn(() => api(`/staff/${editing.id}`, { method: 'PUT', body: { displayName, permissions } }));
      els.dialog.close();
      toast(`حُفظ التعديل على «${displayName}»`);
    } else {
      const { staff, password } = await withSignIn(() => api('/staff', { method: 'POST', body: { username, displayName, permissions } }));
      els.dialog.close();
      // Said in the password's window: a toast cannot show above it
      showCredentials(staff, password, 'first');
    }
    await load();
    // The window gave the focus back to the row's «تعديل», which the list just replaced
    if (editing) focusRow(editing.id, ['edit']);
  } catch (err) {
    showDialogError(err.message);
  } finally {
    els.submit.disabled = false;
  }
});

/* The password, once */

function showCredentials(staff, password, kind) {
  els.credentialsTitle.textContent = kind === 'first' ? `كلمة المرور الأولى لـ «${staff.displayName}»` : `كلمة المرور الجديدة لـ «${staff.displayName}»`;
  els.credentialsLead.textContent =
    kind === 'first'
      ? `أُضيف «${staff.displayName}». أعطه هذه البيانات ليدخل بها.`
      : 'كلمة مروره السابقة لم تعد تعمل، وخرج من كل الأجهزة. أعطه هذه البيانات ليدخل بها.';
  els.credentialsStatus.textContent = '';
  els.credentialsUrl.textContent = location.host;
  els.credentialsUser.textContent = staff.username;
  els.credentialsPassword.textContent = password;
  els.credentials.showModal();
  els.credentialsCopy.focus();
}

els.credentialsCopy.addEventListener('click', async () => {
  const text = [
    `عنوان المتجر: ${location.origin}`,
    `اسم المستخدم: ${els.credentialsUser.textContent}`,
    `كلمة المرور: ${els.credentialsPassword.textContent}`,
  ].join('\n');
  // Said in the window itself: a toast cannot show above it
  try {
    await navigator.clipboard.writeText(text);
    els.credentialsStatus.textContent = 'نُسخت البيانات. ألصقها في رسالة للموظف.';
    els.credentialsStatus.classList.remove('is-error');
  } catch {
    // No clipboard here (or refused): the password is selected for copying by hand
    getSelection().selectAllChildren(els.credentialsPassword);
    els.credentialsStatus.textContent = 'تعذّر النسخ. كلمة المرور محدّدة، انسخها يدويًا.';
    els.credentialsStatus.classList.add('is-error');
  }
});

// Kept nowhere: the window forgets it as it closes
els.credentials.addEventListener('close', () => {
  els.credentialsPassword.textContent = '';
  state.afterCredentials?.();
  state.afterCredentials = null;
});

/* The list's buttons */

els.list.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-edit], [data-reset], [data-disable], [data-enable]');
  if (!button) return;
  const { edit, reset, disable, enable } = button.dataset;
  const staff = byId(edit ?? reset ?? disable ?? enable);
  if (!staff) return;
  if (edit) {
    openForm(staff);
    return;
  }
  const name = staff.displayName;
  if (reset && !confirm(`كلمة مرور جديدة لـ «${name}»؟ تتوقف كلمة مروره الحالية ويخرج من كل الأجهزة الآن.`)) return;
  if (disable && !confirm(`إيقاف حساب «${name}»؟ يخرج من كل الأجهزة الآن ولا يستطيع الدخول حتى تفعّله. فواتيره تبقى باسمه.`)) return;
  button.disabled = true;
  // Back on this row afterwards: a reset's once its password window closes
  const refocus = () => focusRow(staff.id, reset ? ['reset'] : ['enable', 'disable']);
  try {
    if (reset) {
      const { staff: updated, password } = await withSignIn(() => api(`/staff/${staff.id}/password`, { method: 'POST' }));
      state.afterCredentials = refocus;
      showCredentials(updated, password, 'reset');
    } else if (disable) {
      await withSignIn(() => api(`/staff/${staff.id}/disable`, { method: 'POST' }));
      toast(`أُوقف حساب «${name}»`);
    } else {
      await withSignIn(() => api(`/staff/${staff.id}/enable`, { method: 'POST' }));
      toast(`فُعّل حساب «${name}». يدخل بكلمة مروره الحالية`);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
  await load();
  if (!els.credentials.open) refocus();
});

// Called by the settings page once it knows the account is the owner's
export function initStaffCard() {
  buildForm();
  load();
}
