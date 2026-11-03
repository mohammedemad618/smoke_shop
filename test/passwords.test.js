// Passwords (lib/passwords.js): scrypt hashes that verify and never hold the password, at
// most two hashes at a time, nothing over 128 characters hashed, the rules for a new
// password (Arabic allowed), and first passwords that are readable and pass those rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, verifyDummy, hashQueue, passwordProblem, generatePassword, PASSWORD_MAX } from '../lib/passwords.js';

test('a hash verifies its password only, has its own salt and holds no trace of the password', async () => {
  const password = 'كلمة سر طويلة 2026';
  const [h1, h2] = await Promise.all([hashPassword(password), hashPassword(password)]);
  assert.match(h1, /^\$scrypt\$ln=14,r=8,p=5\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
  assert.notStrictEqual(h1, h2, 'a new salt every time');
  assert.ok(!h1.includes(password));
  assert.strictEqual(await verifyPassword(password, h1), true);
  assert.strictEqual(await verifyPassword(password, h2), true);
  // The same letters written another way (NFD) are the same password
  assert.strictEqual(await verifyPassword(password.normalize('NFD'), h1), true);
  for (const wrong of ['كلمة سر طويلة 2025', '', ' كلمة سر طويلة 2026', password.toUpperCase() + 'x']) {
    assert.strictEqual(await verifyPassword(wrong, h1), false, wrong);
  }
});

test('nothing over 128 characters is hashed, and a damaged or oversized hash never matches', async () => {
  await assert.rejects(hashPassword('x'.repeat(PASSWORD_MAX + 1)), (err) => err.status === 400);
  assert.ok(await hashPassword('x'.repeat(PASSWORD_MAX)));
  const good = await hashPassword('Kq7mT4vR9xWp2n');
  assert.strictEqual(await verifyPassword('x'.repeat(PASSWORD_MAX + 1), good), false);
  for (const stored of [undefined, null, '', 'plain-text', good.replace('ln=14', 'ln=30'), good.replace('r=8', 'r=99'), good.slice(0, -4), { $ne: '' }]) {
    const started = Date.now();
    assert.strictEqual(await verifyPassword('Kq7mT4vR9xWp2n', stored), false, String(stored));
    assert.ok(Date.now() - started < 5000, 'no huge parameters were tried');
  }
  assert.strictEqual(await verifyPassword({ toString: () => 'Kq7mT4vR9xWp2n' }, good), false);
  assert.strictEqual(await verifyDummy('anything'), false);
});

test('at most two hashes run at a time; the rest wait their turn', async () => {
  assert.deepStrictEqual(hashQueue(), { running: 0, waiting: 0 });
  const jobs = Array.from({ length: 5 }, (_, i) => hashPassword(`Password-number-${i}x`));
  assert.deepStrictEqual(hashQueue(), { running: 2, waiting: 3 });
  let most = 0;
  const watch = setInterval(() => {
    most = Math.max(most, hashQueue().running);
  }, 5);
  const hashes = await Promise.all(jobs);
  clearInterval(watch);
  assert.ok(most <= 2, `${most} at once`);
  assert.strictEqual(new Set(hashes).size, 5);
  assert.deepStrictEqual(hashQueue(), { running: 0, waiting: 0 });
});

test('one address has at most four hashes running or waiting; past that it is busy, others are not', async () => {
  const mine = Array.from({ length: 4 }, (_, i) => verifyDummy(`guess number ${i}`, { key: '10.9.9.1' }));
  await assert.rejects(verifyDummy('one more', { key: '10.9.9.1' }), (err) => err.status === 503);
  await assert.rejects(verifyPassword('one more', 'not a hash', { key: '10.9.9.1' }), (err) => err.status === 503);
  // Another address, and the work that names none (a new shop's owner), still get theirs
  const other = verifyDummy('from elsewhere', { key: '10.9.9.2' });
  const unnamed = hashPassword('Kq7mT4vR9xWp2n');
  assert.ok(await unnamed);
  assert.strictEqual(await other, false);
  await Promise.all(mine);
  // Once those are done the address has its four again
  assert.strictEqual(await verifyDummy('later', { key: '10.9.9.1' }), false);
  assert.deepStrictEqual(hashQueue(), { running: 0, waiting: 0 });
});

test('the rules for a new password', () => {
  const ok = { username: 'ahmed', slug: 'amal' };
  const cases = [
    ['Kq7mT4vR9xWp2n', null],
    ['دكان أبو علي ٢٠٢٦', null],
    ['ملح وسكر وشاي', null],
    ['correct horse battery', null],
    ['short', /10 أحرف/],
    ['شاي بالنعناع'.slice(0, 9), /10 أحرف/],
    ['x'.repeat(129), /طويلة جدًا/],
    [' leading-space-1', /مسافة/],
    ['password123', /شائعة/],
    ['Password!!!', /شائعة/],
    ['qwertyuiop12', /شائعة/],
    ['1234567890', /شائعة/],
    ['0000000000', /شائعة/],
    ['abcabcabcabc', /شائعة/],
    ['محمد123456789', /شائعة/],
    ['بغداد2026!!!', /شائعة/],
    ['the-AHMED-shop-1', /اسم المستخدم/],
    ['my-amal-shop-pass', /عنوان المتجر/],
    [undefined, /اكتب كلمة المرور/],
    [12345678901, /اكتب كلمة المرور/],
  ];
  for (const [password, expected] of cases) {
    const problem = passwordProblem(password, ok);
    if (expected === null) assert.strictEqual(problem, null, String(password));
    else assert.match(problem ?? '', expected, String(password));
  }
});

test('first passwords: readable, mixed, and never refused by the rules for their account and shop', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const password = generatePassword({ username: 'abc', slug: 'xyz' });
    assert.match(password, /^[a-km-zA-HJ-NP-Z2-9]{14}$/);
    assert.ok(/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password));
    assert.ok(!/abc|xyz/i.test(password));
    assert.strictEqual(passwordProblem(password, { username: 'abc', slug: 'xyz' }), null);
    seen.add(password);
  }
  assert.strictEqual(seen.size, 200);
  assert.strictEqual(generatePassword({ length: 12 }).length, 12);
});
