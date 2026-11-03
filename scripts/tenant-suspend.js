// Suspends a shop, or resumes it, from the command line (the admin panel does the same):
//   npm run tenant:suspend -- --slug amal [--reason "لم يُدفع الاشتراك"]
//   npm run tenant:suspend -- --slug amal --resume
// A suspended shop answers 423 «هذا المتجر موقوف مؤقتًا» to everything and every session of
// it ends; resuming opens it again (everyone signs in again). The change is in the audit log,
// and a running server sees it within 5 seconds.
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../lib/config.js';
import { openDatabases } from '../lib/db.js';
import { transition } from '../services/tenants.js';

const USAGE = `Usage: npm run tenant:suspend -- --slug <address> [--reason <text>] [--resume]

  --slug     the shop's address
  --reason   why (kept in the audit log and shown to the admin only)
  --resume   open a suspended shop again`;

let args;
try {
  ({ values: args } = parseArgs({ options: { slug: { type: 'string' }, reason: { type: 'string' }, resume: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(1);
}
if (args.help || !args.slug) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

let db;
try {
  const config = loadConfig();
  db = await openDatabases(config);
  await db.initControl();
  const slug = args.slug.trim().toLowerCase();
  const tenant = await db.controlModels.Tenant.findOne({ slug }).lean();
  if (!tenant) throw new Error(`No shop with the address "${slug}"`);
  const [from, to] = args.resume ? ['suspended', 'active'] : ['active', 'suspended'];
  if (tenant.status !== from) throw new Error(`"${slug}" is ${tenant.status}, not ${from}`);
  await transition({ db, config }, tenant._id, from, to, { actor: `cli:${userInfo().username}`, reason: args.resume ? '' : (args.reason ?? '') });
  console.log(`Shop "${slug}" is now ${to}.${to === 'suspended' ? ' Its sessions have ended.' : ''}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db?.close();
}
