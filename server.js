import { loadConfig, publicUrl } from './lib/config.js';
import { openDatabases } from './lib/db.js';
import { createRegistry } from './lib/registry.js';
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

const server = createApp({ db, registry, config }).listen(config.port, config.host, () => {
  console.log(`POS running at http://${config.host}:${config.port}`);
  console.log(`  admin: ${publicUrl(config, config.adminHost)}`);
  const active = registry.tenants().filter((t) => t.status === 'active');
  for (const tenant of active) {
    const host = registry.hostsOf(tenant._id).find((h) => h.kind === 'primary');
    if (host) console.log(`  ${tenant.slug}: ${publicUrl(config, host._id)}`);
  }
  if (!active.length) console.log('  no shops yet: npm run tenant:create -- --slug <address> --name <shop name>');
});

// Stop taking requests, let those running finish, then close the database
function shutdown() {
  registry.stop();
  server.close(() => db.close().finally(() => process.exit(0)));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
