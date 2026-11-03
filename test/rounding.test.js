// The one rounding function, public/js/rounding.js: the server imports it through
// lib/util.js and the browser through public/js/common.js. Checked on the server's copy
// and on the file the browser downloads, so the screen and the server cannot drift apart.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { roundTo } from '../public/js/rounding.js';
import * as util from '../lib/util.js';
import { startApp, filesOnly } from './support/harness.js';

// [number, digits, expected]; strictEqual tells -0 from 0, so "never -0" is checked too
const CASES = [
  [10.075, 2, 10.08], // stored as 10.07499999..., rounded as written
  [1.005, 2, 1.01],
  [-1.005, 2, -1.01], // half away from zero
  [-0.004, 2, 0], // 0, not -0
  [0.1 + 0.2, 2, 0.3],
  [10000 / 24, 6, 416.666667], // a unit cost, kept to 6 decimals
  [9.667 + 3 * 0.111, 3, 10], // a weight, kept to the gram
  [1e-7, 2, 0], // written with an exponent
];

function checkCases(round) {
  for (const [n, digits, expected] of CASES) {
    assert.strictEqual(round(n, digits), expected, `roundTo(${n}, ${digits})`);
  }
}

// Files are served before the shop's database is opened: this app has none at all
const files = filesOnly();
let app;
before(async () => {
  app = await startApp(files);
});
after(async () => {
  await app?.close();
});

test('rounds half away from zero on the number as written, never -0', () => {
  checkCases(roundTo);
  assert.ok(Number.isNaN(roundTo('abc', 2)), 'not a number stays NaN');
});

test('the server uses the shared function', () => {
  assert.strictEqual(util.roundTo, roundTo);
  assert.strictEqual(util.money(10.075), 10.08);
  assert.strictEqual(util.precise(10000 / 24), 416.666667);
  assert.strictEqual(util.roundQty(-0.0004), 0);
});

test('the browser imports the shared function, with no copy of its own', async () => {
  // common.js touches the page when loaded, so it is read rather than imported
  const common = await readFile(new URL('../public/js/common.js', import.meta.url), 'utf8');
  assert.match(common, /^import \{ roundTo \} from '\.\/rounding\.js';$/m);
  assert.match(common, /^export \{ roundTo \};$/m, 'purchases.js imports roundTo from common.js');
  assert.doesNotMatch(common, /function roundTo/);
});

test('the file the browser downloads rounds the same', async () => {
  const res = await app.request('GET', '/js/rounding.js', undefined, { host: files.host });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  const served = await import(`data:text/javascript,${encodeURIComponent(res.text)}`);
  checkCases(served.roundTo);
});
