// Test harness: the app runs in-process on a free port with its registry, against databases
// of its own named pos_test_<run>_<random>_...: the control database ..._control and each
// shop's ..._t_<ObjectId>. Each test file runs in its own process, so each gets its own
// prefix. Shops are made with the real createTenant and reached through their Host header,
// as in the browser; the client createShop gives back has signed in as the shop's owner and
// changed the first password, so it works like the owner's browser. Call env.close() in
// after(): it runs whether the tests passed or failed.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../app.js';
import { loadConfig } from '../../lib/config.js';
import { openDatabases } from '../../lib/db.js';
import { createRegistry } from '../../lib/registry.js';
import { generatePassword } from '../../lib/passwords.js';
import { createTenant } from '../../services/tenants.js';
import { createWorker } from '../../lib/worker.js';
import { createRunner } from '../../services/lifecycle.js';
import { TEST_MONGODB_URI, refuseProduction, dropDatabases } from './databases.js';

refuseProduction();

// npm test gives the run's id (test/support/global.js); a file run on its own makes one
const RUN = process.env.POS_TEST_RUN || randomBytes(4).toString('hex');
export const DB_PREFIX = `pos_test_${RUN}_${randomBytes(3).toString('hex')}_`;
export const BASE_DOMAIN = 'pos.localhost';
// The key that encrypts the test admins' authenticator secrets
export const TEST_TOTP_KEY = 'a1'.repeat(32);
// What the app keeps on disk in development (the local stand-in for the root worker's
// archives and state files), in a folder of this file's own (made when first written to),
// removed by env.close()
export const LOCAL_DIR = path.join(os.tmpdir(), DB_PREFIX.slice(0, -1));

// The app's settings with this file's database names; `env` adds or replaces variables
export function testConfig(env = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: TEST_MONGODB_URI,
    CONTROL_DB: `${DB_PREFIX}control`,
    TENANT_DB_PREFIX: `${DB_PREFIX}t_`,
    TENANT_BASE_DOMAINS: BASE_DOMAIN,
    ADMIN_HOST: `admin.${BASE_DOMAIN}`,
    TOTP_KEY: TEST_TOTP_KEY,
    // Test files make many shops and sign in often from one address; these limits have tests
    // of their own
    MAX_NEW_TENANTS_PER_DAY: '1000',
    SIGN_IN_PER_MINUTE: '100000',
    ADMIN_SIGN_IN_PER_MINUTE: '100000',
    POS_LOCAL_DIR: LOCAL_DIR,
    ...env,
  });
}

// A request on node:http rather than fetch, which cannot set the Host header. Sends and
// reads JSON; a 204 gives data null, and a reply that is not JSON gives its text. A header
// given as undefined is left out (to send a request without the Origin a client adds).
export function request(port, method, path, body, headers = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
  const all = Object.fromEntries(Object.entries({ ...sent, ...headers }).filter(([, value]) => value !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: all }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const isJson = (res.headers['content-type'] ?? '').startsWith('application/json');
        try {
          const data = res.statusCode === 204 ? null : isJson ? JSON.parse(text) : text;
          resolve({ status: res.statusCode, headers: res.headers, data, text });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// Starts createApp() on a free port of 127.0.0.1. `request(method, path, body, headers)`
// is the helper above aimed at it; close() stops it, idle keep-alive sockets included.
export async function startApp(ctx) {
  const server = http.createServer(createApp(ctx));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    request: (method, path, body, headers) => request(port, method, path, body, headers),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// The app with one active shop, `slug`, and no database at all: any use of the database
// fails. For the tests of the files, which are served without opening it.
export function filesOnly(slug = 'files') {
  const tenant = { _id: 'files', slug, status: 'active', dbName: null };
  const host = { _id: `${slug}.${BASE_DOMAIN}`, tenantId: 'files', kind: 'primary' };
  return {
    config: testConfig(),
    registry: { resolve: (name) => (name === host._id ? { host, tenant } : null) },
    db: {
      // The control models are only used by requests past the files
      controlModels: {},
      tenantModels() {
        throw new Error('A file request opened the database');
      },
    },
    host: host._id,
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// A first password for tests: passes the rules, and holds no username or address used here
export const FIRST_PASSWORD = 'Kq7mT4vR9xWp2n';
export const owner = (username = 'owner', password = FIRST_PASSWORD) => ({ username, password });

// The cookie a Set-Cookie header sets, as name=value, or null when it clears it
function cookieFrom(setCookie) {
  const [pair, ...attributes] = setCookie.split(';').map((part) => part.trim());
  const cleared = !pair.split('=')[1] || attributes.some((a) => /^max-age=0$/i.test(a) || /^expires=.*1970/i.test(a));
  return { name: pair.split('=')[0], value: cleared ? null : pair };
}

/*
 * A browser on one address, as the shop's pages use it: it keeps the cookies it is given,
 * sends the page's Origin with every request that changes something, and the CSRF token of
 * its last sign-in (or GET /api/auth/me). `send(method, path, body, headers)` is the bare
 * request to the app; headers given to request() win over the ones added here.
 */
export function browser(send, host, scheme = 'http') {
  const jar = new Map();
  let csrf = null;
  const client = {
    host,
    get cookie() {
      return [...jar.values()].join('; ') || null;
    },
    get csrf() {
      return csrf;
    },
    // Sets or replaces the cookies, e.g. another browser's to see what it opens
    useCookie(cookie, token = null) {
      jar.clear();
      for (const pair of String(cookie ?? '').split(';').map((p) => p.trim()).filter(Boolean)) jar.set(pair.split('=')[0], pair);
      csrf = token;
    },
    async request(method, path, body, headers = {}) {
      const added = {};
      if (jar.size) added.cookie = client.cookie;
      if (!SAFE_METHODS.has(method)) {
        added.origin = `${scheme}://${host}`;
        if (csrf) added['x-csrf-token'] = csrf;
      }
      const res = await send(method, path, body, { host, ...added, ...headers });
      for (const header of [res.headers['set-cookie'] ?? []].flat()) {
        const { name, value } = cookieFrom(header);
        if (value) jar.set(name, value);
        else jar.delete(name);
      }
      if (typeof res.data?.csrf === 'string') csrf = res.data.csrf;
      return res;
    },
    login: (username, password, headers) => client.request('POST', '/api/auth/login', { username, password }, headers),
  };
  return client;
}

// Signs a browser in with the owner's first password and changes it, as the owner does the
// first time; returns the new password
export async function signInAsOwner(client, { username, password }, slug) {
  const login = await client.login(username, password);
  if (login.status !== 200) throw new Error(`Signing in to ${slug} -> ${login.status} ${login.text}`);
  const newPassword = generatePassword({ username, slug });
  const changed = await client.request('POST', '/api/auth/password', { currentPassword: password, newPassword });
  if (changed.status !== 200) throw new Error(`Changing the first password of ${slug} -> ${changed.status} ${changed.text}`);
  return newPassword;
}

/*
 * Opens this file's databases (the control one must be empty, with its indexes in place as
 * server.js makes sure), the registry and the app. `retry` replaces lib/db.js's schedule
 * for a shop whose indexes could not be built. Returns:
 *   config, db, registry, app, ctx ({ db, registry, config } for services/tenants.js)
 *   createShop(slug, input?) -> { tenant, client, db, owner, host }: a shop made by
 *     createTenant with its owner account, a client signed in as that owner (first password
 *     changed) whose request(method, path, body, headers) goes to the shop's address, its
 *     database's driver handle for the few tests that write to it directly, and the owner's
 *     { username, password }. input.signIn false leaves the client signed out and the first
 *     password as it was.
 *   client(host) -> a browser (signed out) for any Host header
 *   worker, runner: the root worker's client (local stand-in unless env sets SPOOL_DIR) and
 *     the job runner, which has no clock here: queued jobs start at once (kick), and
 *     runner.drain() / runner.maintain() run what is due
 *   close() -> stops the app and drops every database of this file
 */
export async function startTestEnv({ env, retry } = {}) {
  const config = testConfig(env);
  let db;
  try {
    db = await openDatabases(config, retry ? { retry } : {});
  } catch (err) {
    throw new Error(`Could not connect to MongoDB at ${TEST_MONGODB_URI} (set TEST_MONGODB_URI): ${err.message}`);
  }
  const controlDb = db.control.db;
  if (controlDb.databaseName !== config.controlDb) throw new Error(`Connected to ${controlDb.databaseName}, not ${config.controlDb}`);
  if ((await controlDb.listCollections({}, { nameOnly: true }).toArray()).length) throw new Error(`${config.controlDb} is not empty`);
  await db.initControl();
  // No timers: the tests call registry.poll() when they need a refresh
  const registry = createRegistry(db.controlModels, { pollMs: 0, reloadMs: 0 });
  await registry.start();
  // Steps waiting for the worker look again every 50 ms, and passing failures are retried at once
  const ctx = { db, registry, config, workerPollMs: 50, retryWaitsMs: [20, 20, 20] };
  ctx.worker = createWorker(config, db);
  ctx.runner = createRunner(ctx, { pollMs: 0, maintainMs: 0, measureMs: 0 });
  const app = await startApp(ctx);

  const client = (host) => browser(app.request, host, config.publicScheme);

  return {
    config,
    db,
    registry,
    app,
    ctx,
    worker: ctx.worker,
    runner: ctx.runner,
    client,
    async createShop(slug, { signIn = true, ...input } = {}) {
      const username = input.owner?.username ?? 'owner';
      const owner = { username, password: input.owner?.password ?? generatePassword({ username, slug }) };
      const { tenant } = await createTenant(ctx, { slug, shopName: `متجر ${slug}`, ...input, owner }, { actor: 'test' });
      // With the port, as a browser sends it
      const host = `${slug}.${BASE_DOMAIN}:${app.port}`;
      const shopClient = client(host);
      if (signIn) {
        owner.password = await signInAsOwner(shopClient, owner, slug);
      }
      return { tenant, client: shopClient, db: db.tenantConnection(tenant).db, owner, host };
    },
    async close() {
      registry.stop();
      await ctx.runner.stop();
      await app.close();
      try {
        await dropDatabases(db.base, DB_PREFIX);
      } finally {
        await db.close();
        rmSync(LOCAL_DIR, { recursive: true, force: true });
      }
    },
  };
}
