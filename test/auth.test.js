// A shop's accounts and sessions (lib/auth.js, lib/sessions.js, lib/csrf.js, routes/auth.js):
// nothing of a shop but its files, its name and signing in is open without a session, every
// page sends the browser to sign in, a session works only on its own shop, the first password
// must be changed before anything else, a new password ends the other sessions, signing in
// takes no operators, every write needs the session's token from the same address, the
// security headers are on every answer, and suspending a shop ends its sessions.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createTenantRouter } from '../app.js';
import { hashToken, createSessionStore } from '../lib/sessions.js';
import { transition, setOwnerPassword } from '../services/tenants.js';
import { startTestEnv, startApp, browser, testConfig, BASE_DOMAIN, FIRST_PASSWORD } from './support/harness.js';

let env;
let a;
let b;
before(async () => {
  env = await startTestEnv();
  a = await env.createShop('auth-a');
  b = await env.createShop('auth-b');
});
after(async () => {
  await env?.close();
});

const PUBLIC = ['GET /api/auth/shop', 'POST /api/auth/login', 'POST /api/csp-report'];
// The routes the first-password gate leaves open
const ACCOUNT = ['GET /api/auth/me', 'POST /api/auth/logout', 'POST /api/auth/logout-all', 'POST /api/auth/password'];

// Every route of a shop's router, with its full path, from the router stacks themselves
// (app.js notes where each router is mounted)
function routesOf(router, prefix = '') {
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const path = prefix + (layer.route.path === '/' ? '' : layer.route.path);
    for (const method of Object.keys(layer.route.methods)) if (method !== '_all') routes.push(`${method.toUpperCase()} ${path}`);
  }
  for (const { path, router: child } of router.mounts ?? []) if (child?.stack) routes.push(...routesOf(child, prefix + path));
  return routes;
}
const apiRoutes = () => routesOf(createTenantRouter(env.ctx)).filter((r) => r.split(' ')[1].startsWith('/api/'));
// A route as a request: any :param becomes an id that names nothing
const asRequest = (route) => {
  const [method, path] = route.split(' ');
  return [method, path.replace(/:\w+/g, '0123456789abcdef01234567')];
};

// A browser signed out on shop `shop`'s address
const stranger = (shop) => env.client(shop.host);
const sessionCount = (tenant) => env.db.controlModels.Session.countDocuments({ tenantId: tenant._id });

test('every /api route of a shop answers 401 without a session, but its name, signing in and CSP reports', async () => {
  const routes = apiRoutes();
  assert.ok(routes.length >= 45, `only ${routes.length} routes found`);
  for (const route of PUBLIC) assert.ok(routes.includes(route), route);
  const open = [];
  for (const route of routes) {
    const [method, path] = asRequest(route);
    const res = await stranger(a).request(method, path, method === 'GET' ? undefined : {}, { origin: undefined });
    if (PUBLIC.includes(route)) {
      open.push(route);
      continue;
    }
    assert.deepStrictEqual([res.status, res.data?.code], [401, 'AUTH_EXPIRED'], route);
    assert.strictEqual(res.headers['cache-control'], 'no-store', route);
  }
  assert.deepStrictEqual(open.sort(), [...PUBLIC].sort());
  // A path that is not a route is no different
  assert.strictEqual((await stranger(a).request('GET', '/api/nothing-here')).status, 401);
});

test('every page but the sign-in page sends the browser to sign in, and back afterwards', async () => {
  const pages = (await readdir(new URL('../public/', import.meta.url))).filter((name) => name.endsWith('.html'));
  assert.ok(pages.includes('settings.html') && pages.length >= 10, pages.join());
  for (const page of pages.filter((p) => p !== 'login.html')) {
    const res = await stranger(a).request('GET', `/${page}`);
    assert.deepStrictEqual([res.status, res.headers.location], [302, `/login.html?next=${encodeURIComponent(`/${page}`)}`], page);
  }
  const home = await stranger(a).request('GET', '/?stock=out');
  assert.deepStrictEqual([home.status, home.headers.location], [302, `/login.html?next=${encodeURIComponent('/?stock=out')}`]);
  // The sign-in page, the styles and the scripts are open
  for (const path of ['/login.html', '/css/style.css', '/js/login.js', '/js/auth.js']) {
    assert.strictEqual((await stranger(a).request('GET', path)).status, 200, path);
  }
  // Signed in, the pages are served
  assert.strictEqual((await a.client.request('GET', '/cashier.html')).status, 200);
  assert.strictEqual((await a.client.request('GET', '/settings.html')).status, 200);
});

test("shop A's cookie on shop B's address gives 401, and still works on A", async () => {
  const thief = stranger(b);
  thief.useCookie(a.client.cookie, a.client.csrf);
  for (const [method, path] of [['GET', '/api/products'], ['GET', '/api/auth/me'], ['POST', '/api/categories']]) {
    const res = await thief.request(method, path, method === 'GET' ? undefined : { name: 'من متجر آخر' });
    assert.deepStrictEqual([res.status, res.data.code], [401, 'AUTH_EXPIRED'], `${method} ${path}`);
  }
  assert.strictEqual((await thief.request('GET', '/cashier.html')).status, 302);
  assert.strictEqual((await a.client.request('GET', '/api/products')).status, 200);
  assert.ok(!(await b.client.request('GET', '/api/categories')).data.some((c) => c.name === 'من متجر آخر'));
});

test('signing in takes a string username and password only: operators and odd types get 400', async () => {
  const bodies = [
    { username: { $ne: '' }, password: FIRST_PASSWORD },
    { username: 'owner', password: { $ne: '' } },
    { username: { $gt: '' }, password: { $gt: '' } },
    { username: ['owner'], password: FIRST_PASSWORD },
    { username: 1, password: FIRST_PASSWORD },
    { username: 'o'.repeat(65), password: FIRST_PASSWORD },
    { username: 'owner', password: 'p'.repeat(129) },
    { password: FIRST_PASSWORD },
    { username: 'owner' },
    { username: '  ', password: 'x' },
  ];
  for (const body of bodies) {
    const res = await stranger(a).request('POST', '/api/auth/login', body);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
    assert.ok(!res.headers['set-cookie'], 'no session for a refused body');
  }
  assert.strictEqual(await env.db.controlModels.LoginAttempt.countDocuments({ scope: String(a.tenant._id) }), 0, 'and nothing counted');
});

test('a name that is no account is counted but never written down: a password typed in the username box stays out of pos_control', async () => {
  const shop = await env.createShop('auth-names', { signIn: false });
  const browser = stranger(shop);
  assert.strictEqual((await browser.login('My Shop Password 99', 'anything at all')).status, 401);
  assert.strictEqual((await browser.login('owner', 'Wrong-Password-2')).status, 401);
  const attempts = await env.db.controlModels.LoginAttempt.find({ scope: String(shop.tenant._id) }).lean();
  assert.ok(attempts.length >= 4, 'both are counted');
  assert.ok(!JSON.stringify(attempts).toLowerCase().includes('password 99'), JSON.stringify(attempts));
  assert.ok(attempts.some((d) => d.kind === 'user' && d.username === 'owner'), "an account's name is kept, for the reset to clear");
});

test('a wrong password and an unknown name get the same answer; the right one a session, stored hashed', async () => {
  const shop = await env.createShop('auth-login', { signIn: false });
  const first = shop.owner.password;
  const browser = stranger(shop);
  const wrong = await browser.login('owner', 'Wrong-Password-1');
  const unknown = await browser.login('nobody', first);
  for (const res of [wrong, unknown]) {
    assert.deepStrictEqual([res.status, res.data], [401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة', code: 'LOGIN_FAILED' }]);
  }

  const res = await browser.login('  OWNER ', first);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.data.user, { username: 'owner', displayName: 'owner' });
  assert.deepStrictEqual([res.data.role, res.data.mustChangePassword, typeof res.data.csrf], ['owner', true, 'string']);
  // Over http (development) the cookie has no __Host- prefix and no Secure; HttpOnly, Lax, Path=/, no Domain
  const [setCookie] = res.headers['set-cookie'];
  assert.match(setCookie, /^pos_sid=[A-Za-z0-9_-]{43}; Max-Age=1209600; Path=\/; Expires=[^;]+; HttpOnly; SameSite=Lax$/);
  const value = browser.cookie.split('=')[1];
  const { Session } = env.db.controlModels;
  const stored = await Session.findById(hashToken(value)).lean();
  assert.deepStrictEqual([stored.kind, String(stored.tenantId), stored.authVersion, stored.csrf], ['tenant', String(shop.tenant._id), 1, res.data.csrf]);
  assert.strictEqual(await Session.countDocuments({ _id: value }), 0, 'the cookie itself is never stored');
  // About 72 hours from now
  assert.ok(Math.abs(new Date(res.data.expiresAt) - Date.now() - 72 * 3600e3) < 60e3);

  // Signing in again starts a new session and ends the one the browser had
  const again = await browser.login('owner', first);
  assert.strictEqual(again.status, 200);
  assert.notStrictEqual(browser.cookie.split('=')[1], value);
  assert.strictEqual(await Session.countDocuments({ _id: hashToken(value) }), 0);
});

test('until the first password is changed, every other /api route answers 403 and every page goes to sign in', async () => {
  const shop = await env.createShop('auth-first', { signIn: false });
  const first = shop.owner.password;
  const browser = stranger(shop);
  await browser.login('owner', first);
  for (const route of apiRoutes().filter((r) => !PUBLIC.includes(r) && !ACCOUNT.includes(r))) {
    const [method, path] = asRequest(route);
    const res = await browser.request(method, path, method === 'GET' ? undefined : {});
    assert.deepStrictEqual([res.status, res.data?.code], [403, 'PASSWORD_CHANGE_REQUIRED'], route);
  }
  const page = await browser.request('GET', '/cashier.html');
  assert.deepStrictEqual([page.status, page.headers.location], [302, '/login.html?next=%2Fcashier.html']);
  assert.strictEqual((await browser.request('GET', '/api/auth/me')).data.mustChangePassword, true);

  // The rules for the new one
  const change = (currentPassword, newPassword) => browser.request('POST', '/api/auth/password', { currentPassword, newPassword });
  const refused = [
    ['Wrong-Password-1', 'A-good-new-one-77', 'WRONG_PASSWORD', /الحالية غير صحيحة/],
    [first, 'short-1', 'WEAK_PASSWORD', /10 أحرف/],
    [first, 'Password1234', 'WEAK_PASSWORD', /شائعة/],
    [first, '1234567890', 'WEAK_PASSWORD', /شائعة/],
    [first, 'my-OWNER-pass-9', 'WEAK_PASSWORD', /اسم المستخدم/],
    [first, 'x-auth-first-x9', 'WEAK_PASSWORD', /عنوان المتجر/],
    [first, first, 'WEAK_PASSWORD', /تختلف عن الحالية/],
  ];
  for (const [current, next, code, message] of refused) {
    const res = await change(current, next);
    assert.deepStrictEqual([res.status, res.data.code], [400, code], next);
    assert.match(res.data.error, message);
  }
  // Arabic is allowed, and counts by letters
  const res = await change(first, 'دكان أبو علي ٢٠٢٦');
  assert.deepStrictEqual([res.status, res.data.mustChangePassword], [200, false]);
  assert.strictEqual((await browser.request('GET', '/api/products')).status, 200);
  assert.strictEqual((await browser.request('GET', '/cashier.html')).status, 200);
  assert.strictEqual((await stranger(shop).login('owner', 'دكان أبو علي ٢٠٢٦')).status, 200);
});

test('a new password ends every other session of the account and keeps this one', async () => {
  const shop = await env.createShop('auth-change');
  const other = stranger(shop);
  assert.strictEqual((await other.login('owner', shop.owner.password)).status, 200);
  const before = await env.db.controlModels.Session.findById(hashToken(shop.client.cookie.split('=')[1])).lean();
  assert.strictEqual(await sessionCount(shop.tenant), 2);

  const newPassword = 'Another-Strong-Pass-8';
  const res = await shop.client.request('POST', '/api/auth/password', { currentPassword: shop.owner.password, newPassword });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 200, 'this session carries on');
  assert.strictEqual((await other.request('GET', '/api/products')).status, 401, 'the other one ended');
  assert.strictEqual(await sessionCount(shop.tenant), 1);
  const now = await env.db.controlModels.Session.findById(before._id).lean();
  assert.strictEqual(now.authVersion, before.authVersion + 1);
  assert.strictEqual((await stranger(shop).login('owner', shop.owner.password)).status, 401, 'the old password is gone');
  assert.strictEqual((await stranger(shop).login('owner', newPassword)).status, 200);
});

test('a request of this session made while it changes its password is not taken for a session of the old one', async () => {
  const shop = await env.createShop('auth-during');
  const { User } = await env.db.tenantModels(shop.tenant);
  const original = User.findOneAndUpdate;
  const during = [];
  // Another tab of the same browser asks something right after the account takes its new
  // version, before the session is given it
  const spy = mock.method(User, 'findOneAndUpdate', function (...args) {
    const query = original.apply(this, args);
    const exec = query.exec.bind(query);
    query.exec = async (...rest) => {
      const result = await exec(...rest);
      during.push(await shop.client.request('GET', '/api/auth/me'));
      return result;
    };
    return query;
  });
  try {
    const res = await shop.client.request('POST', '/api/auth/password', { currentPassword: shop.owner.password, newPassword: 'During-The-Change-5' });
    assert.strictEqual(res.status, 200);
  } finally {
    spy.mock.restore();
  }
  assert.deepStrictEqual(during.map((r) => r.status), [200]);
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 200, 'still signed in');
  const session = await env.db.controlModels.Session.findById(hashToken(shop.client.cookie.split('=')[1])).lean();
  assert.deepStrictEqual([session.authVersion, session.nextAuthVersion], [(await User.findOne({ role: 'owner' }).lean()).authVersion, null]);
  // The mark lets nothing else in: a session of the old password still ends
  const old = stranger(shop);
  assert.strictEqual((await old.login('owner', 'During-The-Change-5')).status, 200);
  await shop.client.request('POST', '/api/auth/password', { currentPassword: 'During-The-Change-5', newPassword: 'After-The-Change-6' });
  assert.strictEqual((await old.request('GET', '/api/auth/me')).status, 401);
});

test('signing out ends this session; signing out everywhere ends them all', async () => {
  const shop = await env.createShop('auth-out');
  const second = stranger(shop);
  const third = stranger(shop);
  await second.login('owner', shop.owner.password);
  await third.login('owner', shop.owner.password);
  assert.strictEqual(await sessionCount(shop.tenant), 3);

  const cookie = second.cookie;
  const out = await second.request('POST', '/api/auth/logout');
  assert.strictEqual(out.status, 204);
  assert.match(out.headers['set-cookie'][0], /^pos_sid=; Path=\/; Expires=Thu, 01 Jan 1970/);
  const replay = stranger(shop);
  replay.useCookie(cookie);
  assert.strictEqual((await replay.request('GET', '/api/auth/me')).status, 401, 'the cookie kept after signing out opens nothing');
  assert.strictEqual(await sessionCount(shop.tenant), 2);

  assert.strictEqual((await third.request('POST', '/api/auth/logout-all')).status, 204);
  assert.strictEqual(await sessionCount(shop.tenant), 0);
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 401);
});

// fetch for the pages' own code (public/js/auth.js), sent to the app as `browser` (one
// cookie jar, the page's Origin); the header the page sets wins over the harness's
function pageFetch(browser) {
  return async (url, { method = 'GET', headers = {}, body } = {}) => {
    const sent = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    const res = await browser.request(method, url, body === undefined ? undefined : JSON.parse(body), sent);
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: { 'content-type': res.headers['content-type'] ?? 'text/plain' } });
  };
}

test('signing out from a page whose token went stale (signed in again in another tab) still ends the session; offline it fails', async () => {
  const shop = await env.createShop('auth-signout', { signIn: false });
  const tabs = stranger(shop);
  assert.strictEqual((await tabs.login('owner', shop.owner.password)).status, 200);
  const { fetchMe, signOut } = await import('../public/js/auth.js');
  const spy = mock.method(globalThis, 'fetch', pageFetch(tabs));
  try {
    await fetchMe(); // the page's token
    // Another tab of this browser signs in again: a new session and token, the page's is stale
    assert.strictEqual((await tabs.login('owner', shop.owner.password)).status, 200);
    await signOut();
    assert.strictEqual((await tabs.request('GET', '/api/auth/me')).status, 401, 'no session left');
    assert.strictEqual(await sessionCount(shop.tenant), 0);
    // Already over: nothing left to end, and that is not a failure
    await signOut();

    // Offline: the session stays, and the page must not act as if it had ended
    assert.strictEqual((await tabs.login('owner', shop.owner.password)).status, 200);
    await fetchMe();
    spy.mock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(signOut(), (err) => err.code === 'NETWORK');
    assert.strictEqual((await tabs.request('GET', '/api/auth/me')).status, 200);
  } finally {
    spy.mock.restore();
  }
});

test('a new first password from the admin ends the sessions and must be changed again', async () => {
  const shop = await env.createShop('auth-reset');
  const reset = await setOwnerPassword(env.ctx, shop.tenant._id, { password: 'Reset-By-Admin-42' }, { actor: 'test' });
  assert.deepStrictEqual(reset, { username: 'owner', created: false });
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 401);
  const browser = stranger(shop);
  const res = await browser.login('owner', 'Reset-By-Admin-42');
  assert.deepStrictEqual([res.status, res.data.mustChangePassword], [200, true]);
  const entry = await env.db.controlModels.AuditLog.findOne({ tenantId: shop.tenant._id, action: 'tenant.owner.reset' }).lean();
  assert.deepStrictEqual(entry.details, { username: 'owner' }, 'the log names the account, never the password');
});

test('every write needs the session token, from a page of this very address', async () => {
  const body = { name: 'قسم' };
  const write = (headers) => a.client.request('POST', '/api/categories', body, headers);
  const refused = [
    { 'x-csrf-token': undefined },
    { 'x-csrf-token': 'not-the-token' },
    { 'x-csrf-token': b.client.csrf },
    { origin: undefined },
    { origin: 'http://evil.example' },
    { origin: `http://auth-b.pos.localhost:${env.app.port}` },
    { origin: `https://${a.host}` },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ];
  for (const headers of refused) {
    const res = await write(headers);
    assert.deepStrictEqual([res.status, res.data.code], [403, 'CSRF_FAILED'], JSON.stringify(headers));
  }
  assert.ok(!(await a.client.request('GET', '/api/categories')).data.some((c) => c.name === 'قسم'), 'nothing was written');
  assert.strictEqual((await write({ 'sec-fetch-site': 'same-origin' })).status, 201);
  // Signing in from another site is refused too, before any password is checked
  const res = await stranger(a).login('owner', a.owner.password, { origin: 'http://evil.example' });
  assert.deepStrictEqual([res.status, res.data.code], [403, 'CSRF_FAILED']);
  // No CORS: nothing lets another site read an answer
  for (const [method, path] of [['GET', '/api/products'], ['OPTIONS', '/api/products'], ['POST', '/api/auth/login']]) {
    const answer = await a.client.request(method, path, undefined, { origin: 'http://evil.example' });
    assert.ok(!Object.keys(answer.headers).some((h) => h.startsWith('access-control-')), `${method} ${path}`);
  }
});

test('the security headers are on every answer, and /api is never cached', async () => {
  const base = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
  const answers = [
    await stranger(a).request('GET', '/login.html'),
    await a.client.request('GET', '/cashier.html'),
    await a.client.request('GET', '/api/products'),
    await stranger(a).request('GET', '/api/products'),
    await env.client('nosuch.pos.localhost').request('GET', '/'),
  ];
  for (const res of answers) {
    for (const [name, value] of Object.entries(base)) assert.strictEqual(res.headers[name], value, name);
    assert.match(res.headers['permissions-policy'], /^camera=\(self\)/);
    assert.ok(!res.headers['x-powered-by']);
  }
  const csp = answers[1].headers['content-security-policy-report-only'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /report-uri \/api\/csp-report$/);
  assert.ok(!answers[1].headers['content-security-policy'], 'report-only for now');
  assert.strictEqual(answers[2].headers['cache-control'], 'no-store');
  assert.strictEqual(answers[3].headers['cache-control'], 'no-store');
});

test('CSP reports are taken without a session and limited per shop', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const report = { 'csp-report': { 'document-uri': 'http://x/cashier.html', 'violated-directive': 'style-src', 'blocked-uri': 'inline' } };
    const send = () => stranger(a).request('POST', '/api/csp-report', report, { 'content-type': 'application/csp-report' });
    assert.strictEqual((await send()).status, 204);
    assert.match(warn.mock.calls[0].arguments[0], /"csp":"auth-a".*"directive":"style-src"/);
    let last;
    for (let i = 0; i < 30; i++) last = await send();
    assert.strictEqual(last.status, 429);
  } finally {
    warn.mock.restore();
  }
});

test('suspending a shop ends its sessions: after it is resumed, everyone signs in again', async () => {
  const shop = await env.createShop('auth-pause');
  await stranger(shop).login('owner', shop.owner.password);
  assert.strictEqual(await sessionCount(shop.tenant), 2);
  await transition(env.ctx, shop.tenant._id, 'active', 'suspended', { actor: 'test' });
  assert.strictEqual(await sessionCount(shop.tenant), 0);
  assert.strictEqual(await sessionCount(a.tenant), 1, "another shop's sessions stay");
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 423);
  await transition(env.ctx, shop.tenant._id, 'suspended', 'active', { actor: 'test' });
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 401);
  assert.strictEqual((await stranger(shop).login('owner', shop.owner.password)).status, 200);
});

test('wrong guesses lock this name from this address only, and refuse even the right password meanwhile', async () => {
  const shop = await env.createShop('auth-lock', { signIn: false });
  const first = shop.owner.password;
  const from = (ip) => ({ 'x-forwarded-for': ip });
  const guess = (password, ip = '10.0.0.1', username = 'owner') => stranger(shop).login(username, password, from(ip));
  for (let i = 1; i <= 4; i++) assert.strictEqual((await guess(`Wrong-guess-${i}`)).status, 401, `guess ${i}`);
  const fifth = await guess('Wrong-guess-5');
  assert.deepStrictEqual([fifth.status, fifth.data.code, fifth.headers['retry-after']], [429, 'LOGIN_LOCKED', '900']);
  assert.match(fifth.data.error, /أعد المحاولة بعد 15 دقيقة/);
  const right = await guess(first);
  assert.deepStrictEqual([right.status, right.data.code], [429, 'LOGIN_LOCKED']);
  assert.ok(!right.headers['set-cookie']);
  // The owner from another address is not locked out, nor another name from this one
  assert.strictEqual((await guess('Wrong-guess-6', '10.0.0.1', 'someone')).status, 401);
  assert.strictEqual((await guess(first, '10.0.0.2')).status, 200);
});

test('signing in is reached by its exact path only, and is limited per address in the app itself', async () => {
  const { LoginAttempt } = env.db.controlModels;
  const from = (ip) => ({ 'x-forwarded-for': ip });
  const counted = () => LoginAttempt.countDocuments({ scope: { $in: [String(a.tenant._id), String(b.tenant._id)] } });
  const before = await counted();
  // Express would take these for /api/auth/login, where nginx's pattern might not: no handler
  // sees them (nothing is counted, no LOGIN_FAILED), with a session or without
  for (const path of ['/api/auth/login/', '/API/AUTH/LOGIN', '/api/Auth/Login', '/api/auth/LOGIN']) {
    const res = await stranger(a).request('POST', path, { username: 'owner', password: 'Not the password 1' }, from('10.7.0.1'));
    assert.ok([401, 404].includes(res.status) && res.data?.code !== 'LOGIN_FAILED', `${path} -> ${res.status} ${res.text}`);
  }
  for (const path of ['/api/auth/password/', '/api/AUTH/password', '/API/AUTH/PASSWORD/']) {
    const res = await a.client.request('POST', path, { currentPassword: 'Not the password 1', newPassword: 'Another new one 77' }, from('10.7.0.1'));
    assert.ok(res.data?.code !== 'WRONG_PASSWORD' && res.status !== 200, `${path} -> ${res.status} ${res.text}`);
  }
  assert.strictEqual(await counted(), before);

  // The app's own limit, on an app whose limit is 3 a minute: every shop together, per address
  const app = await startApp({ ...env.ctx, config: testConfig({ SIGN_IN_PER_MINUTE: '3' }) });
  try {
    const shopA = browser(app.request, `auth-a.${BASE_DOMAIN}:${app.port}`);
    const shopB = browser(app.request, `auth-b.${BASE_DOMAIN}:${app.port}`);
    for (let i = 1; i <= 2; i++) assert.strictEqual((await shopA.login('nobody', `Wrong guess ${i}`, from('10.7.0.2'))).status, 401);
    assert.strictEqual((await shopB.login('nobody', 'Wrong guess 3', from('10.7.0.2'))).status, 401);
    const over = await shopB.login('owner', b.owner.password, from('10.7.0.2'));
    assert.deepStrictEqual([over.status, over.data.code], [429, 'RATE_LIMITED']);
    assert.ok(Number(over.headers['retry-after']) > 0);
    assert.ok(!over.headers['set-cookie'], 'not even the right password is checked');
    // Another address has its own
    assert.strictEqual((await shopB.login('owner', b.owner.password, from('10.7.0.3'))).status, 200);
  } finally {
    await app.close();
  }
});

test('two sign-ins of one name from one address at the same moment: one is checked, the other waits its turn', async () => {
  const shop = await env.createShop('auth-twice', { signIn: false });
  const from = { 'x-forwarded-for': '10.7.1.1' };
  const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => stranger(shop).login('owner', `Wrong guess ${i}`, from)));
  const statuses = answers.map((r) => r.data.code ?? r.status);
  assert.ok(statuses.every((s) => ['LOGIN_FAILED', 'LOGIN_LOCKED', 'LOGIN_BUSY'].includes(s)), statuses.join());
  assert.ok(statuses.includes('LOGIN_BUSY'), statuses.join());
  // However many arrive at once, no more are checked than the lock allows (the name's count
  // from every address holds each one checked)
  const named = await env.db.controlModels.LoginAttempt.findOne({ scope: String(shop.tenant._id), kind: 'user' }).lean();
  assert.ok(named.count >= 1 && named.count <= 5, `${named.count} checked: ${statuses.join()}`);
  // Once they are done the name is free again from this address (or locked, never busy)
  const next = await stranger(shop).login('owner', shop.owner.password, from);
  assert.ok(next.status === 200 || next.data.code === 'LOGIN_LOCKED', next.text);
});

test('session limits: 72 hours idle, 14 days at most, the idle limit moved on by use', async () => {
  const { Session } = env.db.controlModels;
  let clock = Date.parse('2026-01-01T08:00:00Z');
  const store = createSessionStore({ Session, config: env.config, kind: 'tenant', now: () => clock });
  const cookies = [];
  const res = { cookie: (...args) => cookies.push(args), clearCookie() {} };
  const session = await store.start({ headers: {}, ip: '127.0.0.1' }, res, { tenantId: a.tenant._id, userId: a.tenant._id, authVersion: 1 });
  const [[name, value, options]] = cookies;
  assert.deepStrictEqual([name, options], ['pos_sid', { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 14 * 24 * 3600e3 }]);
  const req = { headers: { cookie: `other=1; ${name}=${value}` } };
  const H = 3600e3;
  assert.strictEqual(session.expiresAt.getTime(), clock + 72 * H);

  // Used every 70 hours, it lasts until the 14th day and not a moment more
  const start = clock;
  for (let i = 1; i <= 4; i++) {
    clock = start + i * 70 * H;
    const found = await store.find(req);
    assert.ok(found, `still open after ${i * 70} hours`);
    await store.touch(found);
  }
  clock = start + 300 * H;
  await store.touch(await store.find(req));
  assert.strictEqual((await Session.findById(session._id).lean()).expiresAt.getTime(), start + 14 * 24 * H, 'never past the absolute limit');
  clock = start + 14 * 24 * H;
  assert.strictEqual(await store.find(req), null);
  assert.strictEqual(await Session.countDocuments({ _id: session._id }), 0, 'an expired session is deleted when seen');

  // Left alone for 72 hours, it ends
  clock = start;
  const idle = await store.start({ headers: {}, ip: '127.0.0.1' }, res, { tenantId: a.tenant._id, userId: a.tenant._id, authVersion: 1 });
  const idleReq = { headers: { cookie: `${name}=${cookies.at(-1)[1]}` } };
  clock = start + 72 * H - 1000;
  assert.ok(await store.find(idleReq));
  clock = start + 72 * H;
  assert.strictEqual(await store.find(idleReq), null);
  assert.strictEqual(await Session.countDocuments({ _id: idle._id }), 0);
  await Session.deleteMany({ userId: a.tenant._id });
});

test("over https the cookie is __Host-pos_sid with Secure, and the admin's __Host-pos_admin", async () => {
  const cookies = [];
  const store = createSessionStore({ Session: env.db.controlModels.Session, config: testConfig({ PUBLIC_SCHEME: 'https' }), kind: 'tenant' });
  assert.strictEqual(store.cookieName, '__Host-pos_sid');
  const session = await store.start({ headers: {}, ip: '127.0.0.1' }, { cookie: (...args) => cookies.push(args) }, { tenantId: a.tenant._id, userId: a.tenant._id, authVersion: 1 });
  assert.deepStrictEqual(cookies[0][2], { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 14 * 24 * 3600e3 });
  await env.db.controlModels.Session.deleteOne({ _id: session._id });
  const admin = createSessionStore({ Session: env.db.controlModels.Session, config: testConfig({ PUBLIC_SCHEME: 'https' }), kind: 'admin' });
  assert.strictEqual(admin.cookieName, '__Host-pos_admin');
});
