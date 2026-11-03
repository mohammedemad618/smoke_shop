// The MongoDB connections: one client and one pool for everything. The control database and
// each shop's database are views on it (useDb), so twenty shops still share ten connections.
// A shop's database name always comes from its tenant record and is checked here before any
// useDb or drop: nothing from a request can name a database.
import mongoose from 'mongoose';
import { httpError } from './errors.js';
import { escapeRegex } from './util.js';
import { bindModels, initModels } from '../models/index.js';
import { CONTROL_SCHEMAS } from '../control/models/index.js';

// A shop whose indexes could not be built is tried again after 1 s, then 2 s, 4 s... up to a minute
const RETRY = { firstMs: 1000, maxMs: 60000 };

export const tenantDbPattern = (prefix) => new RegExp(`^${escapeRegex(prefix)}[0-9a-f]{24}$`);

export async function openDatabases(config, { serverSelectionTimeoutMS = 5000, retry = RETRY } = {}) {
  const base = mongoose.createConnection(config.mongodbUri, {
    // Its own default database is the control one, so nothing ever lands in "test"
    dbName: config.controlDb,
    maxPoolSize: 10,
    // A full pool fails a request after 2 s instead of queueing it for ever
    waitQueueTimeoutMS: 2000,
    serverSelectionTimeoutMS,
    // Binding models must not create anything: indexes are built by initModels(), with retries
    autoCreate: false,
    autoIndex: false,
  });
  await base.asPromise();

  const pattern = tenantDbPattern(config.tenantDbPrefix);
  function assertDbName(name) {
    if (typeof name !== 'string' || !pattern.test(name)) throw new Error(`Refusing database name ${JSON.stringify(name)}`);
    return name;
  }

  const control = base.useDb(config.controlDb, { useCache: true });
  const controlModels = bindModels(control, CONTROL_SCHEMAS);

  // dbName -> { conn, models, ready, failures, retryAt }. An entry stays for the life of the
  // process, failed or not, so a broken shop never adds connection objects (useCache keeps
  // one per name too). The number of shops is capped by MAX_TENANTS when they are created.
  const tenants = new Map();

  function tenantEntry(tenant) {
    const dbName = assertDbName(tenant?.dbName);
    let entry = tenants.get(dbName);
    if (!entry) {
      const conn = base.useDb(dbName, { useCache: true });
      entry = { conn, models: bindModels(conn), ready: null, failures: 0, retryAt: 0 };
      tenants.set(dbName, entry);
    }
    return entry;
  }

  // The shop's models, its indexes built on first use. Never for a purged shop: building
  // its indexes would make its dropped database again, empty, and nothing would drop it.
  async function tenantModels(tenant) {
    if (tenant?.status === 'deleted') throw httpError(410, 'هذا المتجر لم يعد موجودًا.', 'TENANT_DELETED');
    const entry = tenantEntry(tenant);
    if (!entry.ready) {
      if (Date.now() < entry.retryAt) throw httpError(503, 'تعذّر فتح بيانات المتجر الآن. أعد المحاولة بعد قليل');
      entry.ready = initModels(entry.models).then(
        () => {
          entry.failures = 0;
          return entry.models;
        },
        (err) => {
          entry.ready = null;
          entry.failures += 1;
          entry.retryAt = Date.now() + Math.min(retry.firstMs * 2 ** (entry.failures - 1), retry.maxMs);
          console.error(`Could not prepare ${tenant.dbName} (attempt ${entry.failures}): ${err.message}`);
          throw httpError(503, 'تعذّر فتح بيانات المتجر الآن. أعد المحاولة بعد قليل');
        },
      );
    }
    return entry.ready;
  }

  // Forgets a shop database's models and connection object, once it is gone (dropped by
  // the root worker after a purge, or the database a restore replaced)
  function forgetTenantDb(name) {
    assertDbName(name);
    tenants.delete(name);
    if (base.otherDbs.some((db) => db.name === name)) base.removeDb(name);
  }

  // Drops a shop's database: the purge's last step when the app does the root worker's work
  // itself (development, lib/worker.js). On the server the worker drops it, as root.
  async function dropTenantDb(name) {
    forgetTenantDb(name);
    await base.getClient().db(name).dropDatabase();
  }

  // Whether a shop's database exists yet (MongoDB makes it with its first collection)
  async function databaseExists(name) {
    assertDbName(name);
    const { databases } = await base.db.admin().listDatabases({ nameOnly: true, filter: { name } });
    return databases.length > 0;
  }

  return {
    base,
    control,
    controlModels,
    assertDbName,
    tenantModels,
    tenantConnection: (tenant) => tenantEntry(tenant).conn,
    dropTenantDb,
    forgetTenantDb,
    databaseExists,
    // The control database's indexes (unique slug and dbName, one active job per shop...)
    initControl: () => initModels(controlModels),
    close: () => base.close(),
  };
}
