// Creates a shop from the command line:
//   npm run tenant:create -- --slug amal --name "متجر الأمل" [--owner ahmed] [--label "..."] [--first-invoice 100]
// The owner's first password is made here and printed once: give it to the shop's owner,
// who must change it at the first sign-in. Only its hash is stored, so it cannot be shown
// again; npm run tenant:owner makes a new one. Running this again with the same --slug
// finishes a creation that stopped half way (an owner made by the first run keeps their
// password). A server already running picks the new shop up within 5 seconds. On the server,
// where the certificate comes from the root worker, the running server finishes the last
// steps once it is issued.
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../lib/config.js';
import { openDatabases } from '../lib/db.js';
import { generatePassword } from '../lib/passwords.js';
import { createTenant } from '../services/tenants.js';

const USAGE = `Usage: npm run tenant:create -- --slug <address> --name <shop name> [options]

  --slug            the shop's address: <slug>.<base domain> (3-30 lower-case letters, digits, hyphens)
  --name            the shop's name, shown on the receipt and in the header
  --owner           the owner's username (default: owner); 3-32 lower-case letters, digits, . _ -
  --label           your own name for the shop (default: --name)
  --first-invoice   number of the first sale invoice (default 1)
  --receipt-note    a line at the end of the receipt
  --time-zone       default Asia/Baghdad
  --currency        default د.ع
  --phone           the shop's phone
  --request-id      makes repeating the same request safe (one shop, not two)`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      owner: { type: 'string' },
      label: { type: 'string' },
      'first-invoice': { type: 'string' },
      'receipt-note': { type: 'string' },
      'time-zone': { type: 'string' },
      currency: { type: 'string' },
      phone: { type: 'string' },
      'request-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(1);
}
if (args.help || !args.slug || !args.name) {
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
  const username = (args.owner ?? 'owner').trim().toLowerCase();
  const password = generatePassword({ username, slug });
  const { tenant, url, owner, pending } = await createTenant(
    { db, config },
    {
      slug: args.slug,
      shopName: args.name,
      owner: { username, password },
      label: args.label,
      firstInvoiceNumber: args['first-invoice'],
      receiptNote: args['receipt-note'],
      timeZone: args['time-zone'],
      currency: args.currency,
      phone: args.phone,
      requestId: args['request-id'],
    },
    { actor: `cli:${userInfo().username}` },
  );
  console.log(`Shop "${tenant.slug}" is ${tenant.status}`);
  if (pending) console.log('  Waiting for its HTTPS certificate from the root worker: the running server finishes setting it up (follow it in the admin panel).');
  console.log(`  address:  ${url}`);
  console.log(`  database: ${tenant.dbName}`);
  if (owner?.created) {
    console.log(`  owner:    ${owner.username}`);
    console.log(`  password: ${password}`);
    console.log('  The password is shown this once. The owner must change it at the first sign-in.');
  } else if (owner) {
    console.log(`  owner:    ${owner.username} (made by an earlier run: password unchanged)`);
    console.log(`  A new first password: npm run tenant:owner -- --slug ${tenant.slug}`);
  }
} catch (err) {
  if (!db && config) console.error(`Could not connect to MongoDB at ${config.mongodbUri}`);
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db?.close();
}
