// The demo shop: a made-up restaurant with about three months of history, to show the app
// to prospective customers (services/demo-shop.js has how it is made):
//   npm run demo:shop -- create --slug demo-market [--name "..."] [--days 90] [--seed 2026]
//   npm run demo:shop -- reset --slug demo-market [--yes]
//   npm run demo:shop -- fill --slug <address> [--yes]
// create makes the shop and fills it; its owner's first password is made and thrown away
// unseen, so the owner takes a new one from the admin panel («إعادة تعيين كلمة المرور» on
// the shop's page) or npm run tenant:owner. reset puts the shop back to a fresh history ending now; it never
// touches the owner's password, nor any shop that is not the demo's. fill fills a shop made
// otherwise that has nothing in it yet. Any of them run again after a failure carries on;
// none ever adds a second history to a shop.
import readline from 'node:readline/promises';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../lib/config.js';
import { openDatabases } from '../lib/db.js';
import { createDemoShop, fillDemoShop, readMarker, resetDemoShop } from '../services/demo-shop.js';
import { DEFAULT_DAYS, DEFAULT_SEED, MAX_DAYS, MIN_DAYS } from '../services/demo-plan.js';
import { DEMO_SHOP_NAME } from '../services/demo-data.js';

const USAGE = `Usage: npm run demo:shop -- <create|reset|fill> --slug <address> [options]

  create   make the demo shop and fill it (run again, it finishes what stopped half way)
  reset    replace the demo shop's history with a new one ending now (asks first)
  fill     fill a shop made otherwise, which has no products, sales or staff yet (asks first)

  --slug    the shop's address, e.g. demo-market ("demo" alone is reserved)
  --name    the shop's name, for create (default: ${DEMO_SHOP_NAME})
  --days    days of history, ${MIN_DAYS} to ${MAX_DAYS} (default: ${DEFAULT_DAYS}; a reset keeps the shop's)
  --seed    the history's seed: the same seed on the same day gives the same history
            (default: ${DEFAULT_SEED}; a reset keeps the shop's)
  --wait    minutes create waits for the shop's certificate (default 5)
  --yes     do not ask before reset or fill`;

let args;
let command;
try {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      days: { type: 'string' },
      seed: { type: 'string' },
      wait: { type: 'string' },
      yes: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  args = parsed.values;
  [command] = parsed.positionals;
  if (parsed.positionals.length > 1) throw new Error(`Unexpected: ${parsed.positionals.slice(1).join(' ')}`);
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(1);
}
if (args.help || !['create', 'reset', 'fill'].includes(command) || !args.slug) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

function wholeNumber(value, label, min, max) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`--${label} must be a whole number from ${min} to ${max}`);
    process.exit(1);
  }
  return n;
}
const days = wholeNumber(args.days, 'days', MIN_DAYS, MAX_DAYS);
const seed = wholeNumber(args.seed, 'seed', 0, 2 ** 31 - 1);
const waitMinutes = wholeNumber(args.wait, 'wait', 1, 120) ?? 5;
const slug = args.slug.trim().toLowerCase();

// Asked on the terminal only: without one, --yes must say it
async function confirm(question, expected) {
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    console.error('Not asked (no terminal): add --yes to go ahead');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase() === expected;
  } finally {
    rl.close();
  }
}

// Ctrl+C, or the terminal going away (an SSH connection that drops sends SIGHUP), stops the
// wait for the shop at once and the filling at the next request; the run cleans up after
// itself and logs it. A second Ctrl+C ends the process at once. With the terminal gone,
// what is printed goes nowhere instead of ending the run before its clean-up.
const stop = new AbortController();
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, () => stop.abort());
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

const say = (line) => console.log(line);
const ownerAdvice = (url, slugName) => [
  '  owner:    owner (its first password was made at random and thrown away unseen)',
  '  Before signing in, give the account a new password from the admin panel (the shop\'s page,',
  `  «إعادة تعيين كلمة المرور» next to owner) or with npm run tenant:owner -- --slug ${slugName},`,
  `  then open ${url} and sign in as owner. Everything in this shop is made up.`,
];
function report(result) {
  const { counts, plan, ms, foreign } = result;
  say(`  history:  ${plan.firstDay} to ${plan.lastDay} (seed ${plan.seed}, ${plan.days} days), made in ${Math.round(ms / 1000)} s`);
  say(`  ${counts.products} products, ${counts.sales} invoices (${counts.returns} returns), ${counts.customers} customers, ${counts.purchases} purchases, ${counts.expenses} expenses, ${counts.staff} staff, ${counts.stocktakes} stocktake`);
  // Something else added to the shop or removed from it while it was filled (someone used
  // it): those records sit on wrong days
  if (foreign.length) {
    console.error('  Warning: the shop was changed by something else while it was being filled (was it in use?):');
    for (const line of foreign) console.error(`    ${line}`);
    console.error(`  Some records now sit on wrong days. Run reset again while nobody uses the shop.`);
  }
}

let config;
let db;
try {
  config = loadConfig();
  db = await openDatabases(config);
  await db.initControl();
  const ctx = { db, config };
  const actor = `cli:${userInfo().username}`;
  const common = { slug, seed, days, actor, log: say, signal: stop.signal };

  if (command === 'create') {
    say(`Demo shop "${slug}"`);
    let result;
    try {
      result = await createDemoShop(ctx, { ...common, name: args.name, waitMs: waitMinutes * 60 * 1000 });
    } catch (err) {
      if (err.timedOut || err.setupFailed || err.stoppedWaiting) {
        console.error(err.message);
        console.error(`When the admin panel shows the shop ready, run the same create again: it fills the shop`);
        process.exitCode = 1;
        throw Object.assign(err, { reported: true });
      }
      throw err;
    }
    say(`  address:  ${result.url}`);
    if (result.filled) report(result);
    else say(`  already filled (${result.marker.firstDay} to ${result.marker.lastDay}): to start again, npm run demo:shop -- reset --slug ${slug}`);
    for (const line of ownerAdvice(result.url, slug)) say(line);
  } else if (command === 'reset') {
    // Refused before anything is asked when it is not the demo shop
    const tenant = await db.controlModels.Tenant.findOne({ slug }).lean();
    if (!tenant) throw new Error(`No shop with the address "${slug}"`);
    if (tenant.status !== 'active') throw new Error(`"${slug}" is ${tenant.status}: nothing was changed`);
    if (!(await readMarker(ctx, tenant))) throw new Error(`"${slug}" is not a demo shop (no demo marker in its database): nothing was changed`);
    const ok = await confirm(`Every sale, product, customer and staff account of "${slug}" (${tenant.shopNameCache}) will be replaced by a new made-up history; the owner keeps the account and its password. Type the address to go ahead: `, slug);
    if (!ok) throw new Error('Not confirmed: nothing was changed');
    say(`Resetting the demo shop "${slug}"`);
    report(await resetDemoShop(ctx, common));
  } else {
    say(`Filling "${slug}"`);
    const result = await fillDemoShop(ctx, {
      ...common,
      confirmUnmarked: (tenant) => confirm(`"${slug}" (${tenant.shopNameCache}) will get a made-up restaurant's history, settings and staff. Type the address to go ahead: `, slug),
    });
    if (result.filled) report(result);
    else say(`  already filled (${result.marker.firstDay} to ${result.marker.lastDay}): to start again, npm run demo:shop -- reset --slug ${slug}`);
  }
} catch (err) {
  if (!err.reported) {
    if (!db && config) console.error(`Could not connect to MongoDB at ${config.mongodbUri}`);
    console.error(err.message);
  }
  process.exitCode = 1;
} finally {
  await db?.close();
}
