import { loadConfig, publicUrl } from './lib/config.js';
import { openDatabases } from './lib/db.js';
import { createRegistry } from './lib/registry.js';
import { createWorker } from './lib/worker.js';
import { createRunner } from './services/lifecycle.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

let db;
let registry;
try {
  db = await openDatabases(config);
  // Make sure the control indexes (unique address and database name...) exist before serving;
  // each shop's indexes are built when it is first used
  await db.initControl();
  registry = createRegistry(db.controlModels);
  await registry.start();
} catch (err) {
  console.error(`Could not connect to MongoDB at ${config.mongodbUri}`);
  console.error('Make sure the MongoDB service is running, or set MONGODB_URI in .env');
  console.error(err.message);
  process.exit(1);
}

// The root worker's spool on the server; in development the app does that work itself.
// The runner carries out the shops' jobs (setting up, backups, renames, deletions) and the
// lifecycle's upkeep, in this process only.
const worker = createWorker(config, db);
const ctx = { db, registry, config, worker };
const runner = createRunner(ctx);
ctx.runner = runner;

const server = createApp(ctx).listen(config.port, config.host, () => {
  console.log(`POS running at http://${config.host}:${config.port}`);
  console.log(`  admin: ${publicUrl(config, config.adminHost)}`);
  if (worker.mode === 'local') console.log('  certificates and backups: done in this process (development, .pos-local/)');
  const active = registry.tenants().filter((t) => t.status === 'active');
  for (const tenant of active) {
    const host = registry.hostsOf(tenant._id).find((h) => h.kind === 'primary');
    if (host) console.log(`  ${tenant.slug}: ${publicUrl(config, host._id)}`);
  }
  if (!active.length) console.log('  no shops yet: create one from the admin panel, or npm run tenant:create -- --slug <address> --name <shop name>');
  runner.start();
});

// Stop taking requests and jobs, let those running finish, then close the database
function shutdown() {
  registry.stop();
  const jobs = runner.stop();
  server.close(() => jobs.finally(() => db.close().finally(() => process.exit(0))));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
