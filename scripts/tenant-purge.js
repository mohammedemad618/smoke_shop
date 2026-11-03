// «الحذف النهائي الآن», on the server only: ends the 30-day wait of a shop already waiting
// for deletion (asked for from the admin panel), so the running server purges it within a
// minute: a last verified backup, the database dropped by the root worker, its addresses
// retired for ever.
//   npm run tenant:purge -- --slug amal --confirm
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../lib/config.js';
import { openDatabases } from '../lib/db.js';

const USAGE = `Usage: npm run tenant:purge -- --slug <address> --confirm

  The shop must be waiting for deletion (asked for from the admin panel). Its database is
  dropped within a minute by the running server, after a last verified backup.`;

let args;
try {
  ({ values: args } = parseArgs({ options: { slug: { type: 'string' }, confirm: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(1);
}
if (args.help || !args.slug || !args.confirm) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

let db;
try {
  const config = loadConfig();
  db = await openDatabases(config);
  await db.initControl();
  const { Tenant, AuditLog } = db.controlModels;
  const slug = args.slug.trim().toLowerCase();
  const tenant = await Tenant.findOneAndUpdate({ slug, status: 'pending_deletion' }, { $set: { 'deletion.purgeAfter': new Date() } }, { returnDocument: 'after' }).lean();
  if (!tenant) throw new Error(`"${slug}" is not waiting for deletion: ask for its deletion from the admin panel first`);
  await AuditLog.record({ actor: `cli:${userInfo().username}`, action: 'tenant.purge.now', tenantId: tenant._id, tenantSlug: slug, details: {} });
  console.log(`"${slug}" will be purged within a minute by the running server. Follow it on the shop's page in the admin panel.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db?.close();
}
