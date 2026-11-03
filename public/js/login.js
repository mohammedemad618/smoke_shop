// The sign-in page, then the change of the first password when the account still has the
// one the admin gave it. Afterwards the browser goes back to the page it came from (?next=,
// a path on this address only) or to the cashier. Uses auth.js only: common.js would send
// a signed-out browser straight back here.
import { request, fetchMe, signIn, signOut, changePassword, safeNext, PASSWORD_MIN, passwordLength } from './auth.js';

const next = safeNext(new URLSearchParams(location.search).get('next'));
const $ = (id) => document.getElementById(id);
const els = {
  shopName: $('shopName'),
  loginForm: $('loginForm'),
  loginError: $('loginError'),
  username: $('username'),
  password: $('password'),
  showPassword: $('showPassword'),
  changeForm: $('changeForm'),
  changeError: $('changeError'),
  changeUser: $('changeUser'),
  currentField: $('currentField'),
  currentPassword: $('currentPassword'),
  newPassword: $('newPassword'),
  confirmPassword: $('confirmPassword'),
  otherAccount: $('otherAccount'),
};
// The temporary password just typed, so the change step does not ask for it again
let typedPassword = null;

const showError = (el, message) => {
  el.textContent = message;
  el.hidden = !message;
};
const busy = (form, on) => {
  for (const button of form.querySelectorAll('button')) button.disabled = on;
};

// The shop's name, so the owner knows which shop this is
request('/auth/shop')
  .then(({ shopName }) => {
    if (!shopName) return;
    els.shopName.textContent = shopName;
    document.title = `تسجيل الدخول | ${shopName}`;
  })
  .catch(() => {});

function showLogin(message = '') {
  typedPassword = null;
  els.changeForm.hidden = true;
  els.loginForm.hidden = false;
  showError(els.loginError, message);
  els.password.value = '';
  (els.username.value ? els.password : els.username).focus();
}

function showChange(username, knownPassword) {
  typedPassword = knownPassword;
  els.loginForm.hidden = true;
  els.changeForm.hidden = false;
  els.changeUser.value = username;
  els.currentField.hidden = Boolean(knownPassword);
  showError(els.changeError, '');
  (knownPassword ? els.newPassword : els.currentPassword).focus();
}

// Signed in already: straight on, or to the change of the first password
fetchMe().then(
  (me) => (me.mustChangePassword ? showChange(me.user.username, null) : location.replace(next)),
  (err) => showLogin(err.code === 'TENANT_SUSPENDED' ? err.message : ''),
);

els.showPassword.addEventListener('change', () => {
  els.password.type = els.showPassword.checked ? 'text' : 'password';
});

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = els.username.value.trim();
  const password = els.password.value;
  if (!username || !password) {
    showError(els.loginError, 'اكتب اسم المستخدم وكلمة المرور');
    (username ? els.password : els.username).focus();
    return;
  }
  busy(els.loginForm, true);
  try {
    const me = await signIn(username, password);
    if (me.mustChangePassword) showChange(me.user.username, password);
    else location.replace(next);
  } catch (err) {
    showError(els.loginError, err.message);
    els.password.select();
  } finally {
    busy(els.loginForm, false);
  }
});

els.changeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = typedPassword ?? els.currentPassword.value;
  const password = els.newPassword.value;
  let problem = '';
  if (!current) problem = 'اكتب كلمة المرور المؤقتة';
  else if (passwordLength(password) < PASSWORD_MIN) problem = `كلمة المرور الجديدة يجب أن تكون ${PASSWORD_MIN} أحرف على الأقل`;
  else if (password !== els.confirmPassword.value) problem = 'كلمتا المرور الجديدتان غير متطابقتين';
  if (problem) {
    showError(els.changeError, problem);
    return;
  }
  busy(els.changeForm, true);
  try {
    await changePassword(current, password);
    location.replace(next);
  } catch (err) {
    if (err.code === 'AUTH_EXPIRED') {
      showLogin('انتهت الجلسة. سجّل الدخول من جديد');
      return;
    }
    // A wrong temporary password: ask for it rather than reuse what was typed
    if (err.code === 'WRONG_PASSWORD') {
      typedPassword = null;
      els.currentField.hidden = false;
      els.currentPassword.value = '';
    }
    showError(els.changeError, err.message);
  } finally {
    busy(els.changeForm, false);
  }
});

els.otherAccount.addEventListener('click', async () => {
  await signOut().catch(() => {});
  els.username.value = '';
  showLogin();
});
