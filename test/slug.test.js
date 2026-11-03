// The rules for a shop's address (lib/slug.js), and their parity with the nginx pattern in
// docs/multitenant-plan.md that picks a certificate: every address the app accepts must be
// one nginx serves, or a shop would be created without HTTPS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkSlug, RESERVED_SLUGS, SLUG_MESSAGES } from '../lib/slug.js';

const reasonOf = (slug) => (checkSlug(slug).ok ? 'ok' : checkSlug(slug).reason);

test('accepted addresses', () => {
  for (const slug of ['abc', 'amal', 'smoke', 'shop-a', 'my-shop-2', 'x9z', 'a'.repeat(30), 'shop-1-2-3', 'cafe-deadbee', 'cafebabe1', 'a1-b2-c3']) {
    assert.strictEqual(reasonOf(slug), 'ok', slug);
  }
});

test('refused addresses', () => {
  const invalid = [
    '', 'ab', 'a'.repeat(31), 'Abc', 'AMAL', '1abc', '9', 'abc-', '-abc', 'a--b', 'a_b', 'a.b', 'a b', 'متجر',
    // An IP address in the name: sslip.io would answer with that address
    'shop-1-2-3-4', 'x10-0-0-1', 'a-192-168-1-5', 'deadbeef', 'shop-7f000001', 'cafe-deadbeef-x',
  ];
  for (const slug of invalid) assert.strictEqual(reasonOf(slug), 'invalid', slug);
  for (const value of [undefined, null, 42, ['abc'], { slug: 'abc' }]) assert.strictEqual(reasonOf(value), 'invalid', String(value));
});

test('reserved names: exactly the list in the plan, refused as reserved, and "smoke" is not one', async () => {
  const plan = await readFile(new URL('../docs/multitenant-plan.md', import.meta.url), 'utf8');
  const listed = plan.match(/فيه قائمة محجوزة واحدة: ([a-z0-9، ]+)/)?.[1].split('، ').map((s) => s.trim());
  assert.ok(listed?.length > 30, 'the reserved list is in the plan');
  assert.deepStrictEqual([...RESERVED_SLUGS].sort(), listed.sort());
  for (const slug of RESERVED_SLUGS) assert.strictEqual(reasonOf(slug), 'reserved', slug);
  assert.strictEqual(reasonOf('smoke'), 'ok');
  assert.match(SLUG_MESSAGES.invalid, /من 3 إلى 30/);
});

test('parity with the nginx certificate pattern in the plan', async () => {
  const plan = await readFile(new URL('../docs/multitenant-plan.md', import.meta.url), 'utf8');
  const source = plan.match(/"~(\^\[a-z\][^"]*\$)"\s+\$ssl_server_name;/)?.[1];
  assert.ok(source, 'the map line of the nginx config is in the plan');
  const nginx = new RegExp(source);
  const suffix = source.slice(source.indexOf('\\.pos\\.')).replace(/\\\./g, '.').replace(/\$$/, '');
  assert.strictEqual(suffix, '.pos.108-61-190-4.sslip.io');
  const served = (slug) => nginx.test(slug + suffix);

  // What nginx serves but the app refuses can only be a double hyphen, an IP address or a reserved name
  const stricter = (slug) => slug.includes('--') || /\d{1,3}(-\d{1,3}){3}/.test(slug) || /(^|-)[0-9a-f]{8}(-|$)/.test(slug) || RESERVED_SLUGS.has(slug);
  // Mostly hex letters, digits and hyphens, where the rules differ; now and then a character nginx refuses
  const pick = (chars) => chars[Math.floor(Math.random() * chars.length)];
  let accepted = 0;
  for (let i = 0; i < 20000; i++) {
    const length = 1 + Math.floor(Math.random() * 34);
    const slug = Array.from({ length }, () => pick(Math.random() < 0.03 ? 'xyzA_.' : 'abcdef019-')).join('');
    const ok = checkSlug(slug).ok;
    if (ok) {
      accepted++;
      assert.ok(served(slug), `${slug} is accepted but nginx would not serve it`);
    } else if (served(slug)) {
      assert.ok(stricter(slug), `${slug} is served by nginx but refused for another reason`);
    }
  }
  assert.ok(accepted > 1000, `only ${accepted} random addresses were valid`);
  // The bounds, exactly
  assert.ok(served('a'.repeat(30)) && checkSlug('a'.repeat(30)).ok);
  assert.ok(!served('a'.repeat(31)) && !checkSlug('a'.repeat(31)).ok);
  assert.ok(served('abc') && checkSlug('abc').ok);
  assert.ok(!served('ab') && !checkSlug('ab').ok);
});
