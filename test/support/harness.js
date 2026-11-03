// Test harness: the app runs in-process on a free port with its registry, against databases
// of its own named pos_test_<run>_<random>_...: the control database ..._control and each
// shop's ..._t_<ObjectId>. Each test file runs in its own process, so each gets its own
// prefix. Shops are made with the real createTenant and reached through their Host header,
// as in the browser. Call env.close() in after(): it runs whether the tests passed or failed.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../app.js';
import { loadConfig } from '../../lib/config.js';
import { openDatabases } from '../../lib/db.js';
import { createRegistry } from '../../lib/registry.js';
import { createTenant } from '../../services/tenants.js';
import { TEST_MONGODB_URI, refuseProduction, dropDatabases } from './databases.js';

refuseProduction();

// npm test gives the run's id (test/support/global.js); a file run on its own makes one
const RUN = process.env.POS_TEST_RUN || randomBytes(4).toString('hex');
export const DB_PREFIX = `pos_test_${RUN}_${randomBytes(3).toString('hex')}_`;
export const BASE_DOMAIN = 'pos.localhost';

// The app's settings with this file's database names; `env` adds or replaces variables
export function testConfig(env = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: TEST_MONGODB_URI,
    CONTROL_DB: `${DB_PREFIX}control`,
    TENANT_DB_PREFIX: `${DB_PREFIX}t_`,
    TENANT_BASE_DOMAINS: BASE_DOMAIN,
    ADMIN_HOST: `admin.${BASE_DOMAIN}`,
    ...env,
  });
}

// A request on node:http rather than fetch, which cannot set the Host header. Sends and
// reads JSON; a 204 gives data null, and a reply that is not JSON gives its text.
export function request(port, method, path, body, headers = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...sent, ...headers } }, (res) => {
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
export async function startApp({ db, registry, config }) {
  const server = http.createServer(createApp({ db, registry, config }));
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
      tenantModels() {
        throw new Error('A file request opened the database');
      },
    },
    host: host._id,
  };
}

/*
 * Opens this file's databases (the control one must be empty, with its indexes in place as
 * server.js makes sure), the registry and the app. `retry` replaces lib/db.js's schedule
 * for a shop whose indexes could not be built. Returns:
 *   config, db, registry, app, ctx ({ db, registry, config } for services/tenants.js)
 *   createShop(slug, input?) -> { tenant, client, db }: a shop made by createTenant, a
 *     client whose request(method, path, body, headers) goes to its address, and its
 *     database's driver handle for the few tests that write to it directly
 *   client(host) -> the same client for any Host header
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
  const app = await startApp({ db, registry, config });
  const ctx = { db, registry, config };

  const client = (host) => ({
    host,
    request: (method, path, body, headers = {}) => app.request(method, path, body, { host, ...headers }),
  });

  return {
    config,
    db,
    registry,
    app,
    ctx,
    client,
    async createShop(slug, input = {}) {
      const { tenant } = await createTenant(ctx, { slug, shopName: `متجر ${slug}`, ...input }, { actor: 'test' });
      // With the port, as a browser sends it
      return { tenant, client: client(`${slug}.${BASE_DOMAIN}:${app.port}`), db: db.tenantConnection(tenant).db };
    },
    async close() {
      registry.stop();
      await app.close();
      try {
        await dropDatabases(db.base, DB_PREFIX);
      } finally {
        await db.close();
      }
    },
  };
}
