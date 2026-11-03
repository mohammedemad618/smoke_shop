// Lets an admin locked out by wrong passwords or codes try again at once (the lock lifts by
// itself after 15 minutes, doubling up to 4 hours):
//   npm run admin:unlock [-- --username boss]
// Clears the admin panel's failed sign-ins, of every address, for that username or for all.
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../lib/config.js';
import { openDatabases } from '../lib/db.js';
import { unlockAdmins } from '../services/admins.js';

const USAGE = `Usage: npm run admin:unlock [-- --username <name>]

  --username   only this admin's failed sign-ins (default: all of the admin panel's)`;

let args;
try {
  ({ values: args } = parseArgs({ options: { username: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(1);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

let db;
try {
  const config = loadConfig();
  db = await openDatabases(config);
  await db.initControl();
  const username = args.username?.trim().toLowerCase() || undefined;
  const cleared = await unlockAdmins({ db, config }, { username }, { actor: `cli:${userInfo().username}` });
  console.log(`Cleared ${cleared} record(s) of failed sign-ins${username ? ` for ${username}` : ''}. The admin can sign in again now.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db?.close();
}
