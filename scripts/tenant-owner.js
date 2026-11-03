// A new first password for a shop's owner, when they forgot theirs or never had an account
// (shops made before accounts existed):
//   npm run tenant:owner -- --slug amal [--username ahmed]
// Prints the new password once; the owner must change it at the next sign-in. Every session
// of the account ends at once and its failed sign-ins are forgotten. --username names the
// account only when the shop has no owner yet; an existing owner keeps their name.
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../lib/config.js';
import { openDatabases } from '../lib/db.js';
import { generatePassword } from '../lib/passwords.js';
import { setOwnerPassword } from '../services/tenants.js';

const USAGE = `Usage: npm run tenant:owner -- --slug <address> [--username <name>]

  --slug       the shop's address
  --username   the owner's username, for a shop that has no owner yet (default: owner)`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      slug: { type: 'string' },
      username: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(1);
}
if (args.help || !args.slug) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

let config;
let db;
try {
  config = loadConfig();
  db = await openDatabases(config);
  await db.initControl();
  const slug = args.slug.trim().toLowerCase();
  const tenant = await db.controlModels.Tenant.findOne({ slug }).lean();
  if (!tenant) throw new Error(`No shop with the address "${slug}"`);
  // Before its database is opened: opening a purged shop's would make it again, empty, and
  // a shop being set up or deleted has no use for a new password
  if (!['active', 'suspended'].includes(tenant.status)) throw new Error(`"${slug}" is ${tenant.status}: only an active or suspended shop's owner gets a new password`);
  const { User } = await db.tenantModels(tenant);
  const existing = await User.findOne({ role: 'owner' }, 'usernameLower').lean();
  const username = existing?.usernameLower ?? (args.username ?? 'owner').trim().toLowerCase();
  const password = generatePassword({ username, slug });
  const owner = await setOwnerPassword({ db, config }, tenant._id, { username, password }, { actor: `cli:${userInfo().username}` });
  console.log(`Shop "${slug}": ${owner.created ? 'owner account made' : 'new first password'}`);
  console.log(`  owner:    ${owner.username}`);
  console.log(`  password: ${password}`);
  console.log('  The password is shown this once. The owner must change it at the next sign-in.');
} catch (err) {
  if (!db && config) console.error(`Could not connect to MongoDB at ${config.mongodbUri}`);
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db?.close();
}
