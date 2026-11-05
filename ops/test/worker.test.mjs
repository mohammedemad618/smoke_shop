// The root worker (ops/sbin/pos-root-worker.mjs) and the monitor's checks, against a
// temporary folder, with fake certbot, mongodump, mongorestore and mongosh programs (small
// Node scripts written below). Nothing here touches MongoDB, the network or a real
// certificate authority. Run: node --test ops/test/worker.test.mjs
//
// On Windows, creating symbolic links needs a privilege, so the tests that need one (a
// symbolic link to refuse, installing a certificate for nginx) are skipped there; on the
// Linux server they all run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadConfig, isValidHost, isJobFile, TENANT_DB, parseRequest, checkArchivePath, assertArchiveFile,
  writeJsonAtomic, acquireLock, scanSpool, runOnce, runNightly, dumpDatabase, retentionPlan, dumpedCounts,
} from '../sbin/pos-root-worker.mjs';
import { parseMeminfo, count5xx, evaluate, mergeProblems, loadConfig as monitorConfig } from '../sbin/pos-monitor.mjs';

const BASE = 'pos.108-61-190-4.sslip.io';
const HOST = `amal.${BASE}`;
const DB_A = `pos_t_${'a'.repeat(24)}`;
const DB_B = `pos_t_${'b'.repeat(24)}`;
const DB_NEW = `pos_t_${'c'.repeat(24)}`;
const TENANT = '6650f1c2a1b2c3d4e5f60718';

let root;
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = (file) => fs.existsSync(file);

// mongodump / mongorestore / mongosh in one fake: a JSON file stands for the server
const FAKE_MONGO = String.raw`
import fs from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
const file = process.env.FAKE_MONGO_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const [tool, ...args] = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3);
if (tool === 'mongodump') {
  const db = opt('db');
  const collections = state.databases[db] ?? {};
  fs.writeFileSync(opt('archive'), gzipSync(JSON.stringify({ db, collections })));
  for (const [name, n] of Object.entries(collections)) process.stderr.write('2026-11-03T00:30:00.000+0000\tdone dumping \x60' + db + '.' + name + '\x60 (' + n + ' documents)\n');
} else if (tool === 'mongorestore') {
  const archive = JSON.parse(gunzipSync(fs.readFileSync(opt('archive'))));
  const from = opt('nsFrom').replace(/\.\*$/, '');
  const to = opt('nsTo').replace(/\.\*$/, '');
  if (archive.db !== from) { process.stderr.write('wrong source'); process.exit(1); }
  const collections = { ...archive.collections };
  // FAKE_RESTORE_PEEK=<jobs folder>|<file>: the job states as they are while this runs
  if (process.env.FAKE_RESTORE_PEEK) {
    const [dir, out] = process.env.FAKE_RESTORE_PEEK.split('|');
    fs.writeFileSync(out, JSON.stringify(fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(dir + '/' + n, 'utf8')))));
  }
  if (process.env.FAKE_RESTORE_LOSE) { const first = Object.keys(collections)[0]; if (first) collections[first] -= 1; }
  state.databases[to] = collections;
  save();
  const total = Object.values(collections).reduce((s, n) => s + n, 0);
  process.stderr.write(total + ' document(s) restored successfully. 0 document(s) failed to restore.\n');
} else if (tool === 'mongosh') {
  const script = args[args.indexOf('--eval') + 1];
  const op = /^\/\/ pos-op:(\S+)/.exec(script)[1];
  const name = /getSiblingDB\("([^"]+)"\)/.exec(script)?.[1];
  let result;
  if (op === 'databases') result = ['admin', 'config', 'local', ...Object.keys(state.databases)];
  else if (op === 'tenants') result = state.tenants;
  else if (op === 'counts') result = state.databases[name] ?? {};
  else if (op === 'drop') { delete state.databases[name]; save(); result = { ok: 1 }; }
  console.log('Current Mongosh Log ID: 0');
  console.log('POS_RESULT ' + JSON.stringify(result));
} else {
  process.exit(3);
}
`;

// certbot: records its arguments; FAKE_CERTBOT_MODE=fail fails, =ok "issues" the certificate in
// FAKE_CERT_DIR (made with openssl) into <config-dir>/live/<host>/
const FAKE_CERTBOT = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CERTBOT_LOG, JSON.stringify(args) + '\n');
const opt = (name) => args[args.indexOf(name) + 1];
if (process.env.FAKE_CERTBOT_MODE === 'fail') { process.stderr.write('Some challenges have failed.\n'); process.exit(1); }
const configDir = opt('--config-dir');
const host = opt('--cert-name');
if (args[0] === 'certonly' && !args.includes('--dry-run')) {
  const live = path.join(configDir, 'live', host);
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'renewal'), { recursive: true });
  fs.copyFileSync(path.join(process.env.FAKE_CERT_DIR, 'cert.pem'), path.join(live, 'fullchain.pem'));
  fs.copyFileSync(path.join(process.env.FAKE_CERT_DIR, 'key.pem'), path.join(live, 'privkey.pem'));
  fs.writeFileSync(path.join(configDir, 'renewal', host + '.conf'), 'authenticator = webroot\n');
} else if (args[0] === 'delete') {
  fs.rmSync(path.join(configDir, 'live', host), { recursive: true, force: true });
  fs.rmSync(path.join(configDir, 'renewal', host + '.conf'), { force: true });
}
`;

function makeConfig(name, overrides = {}) {
  const dir = path.join(root, name);
  for (const sub of ['spool/desired', 'spool/retire', 'spool/requests', 'spool/state', 'work', 'backups', 'nginx-certs', 'le', 'webroot']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const mongo = path.join(root, 'fake-mongo.mjs');
  const config = loadConfig({
    SPOOL_DIR: path.join(dir, 'spool'),
    POS_WORKER_DIR: path.join(dir, 'work'),
    POS_BACKUP_DIR: path.join(dir, 'backups'),
    POS_NGINX_CERT_DIR: path.join(dir, 'nginx-certs'),
    POS_LE_CONFIG_DIR: path.join(dir, 'le', 'config'),
    POS_LE_WORK_DIR: path.join(dir, 'le', 'work'),
    POS_LE_LOGS_DIR: path.join(dir, 'le', 'logs'),
    POS_WEBROOT: path.join(dir, 'webroot'),
    POS_CERT_GROUP: '',
    POS_CERTBOT: JSON.stringify([process.execPath, path.join(root, 'fake-certbot.mjs')]),
    POS_MONGODUMP: JSON.stringify([process.execPath, mongo, 'mongodump']),
    POS_MONGORESTORE: JSON.stringify([process.execPath, mongo, 'mongorestore']),
    POS_MONGOSH: JSON.stringify([process.execPath, mongo, 'mongosh']),
  });
  config.logs = [];
  config.log = (level, message) => config.logs.push(`${level} ${message}`);
  config.checks = { dns: async () => {}, probe: async () => {} };
  Object.assign(config, overrides);
  process.env.FAKE_CERTBOT_LOG = path.join(dir, 'certbot.log');
  fs.writeFileSync(process.env.FAKE_CERTBOT_LOG, '');
  return config;
}

function fakeServer(config, databases, tenants = []) {
  const file = path.join(path.dirname(config.spoolDir), 'mongo.json');
  fs.writeFileSync(file, JSON.stringify({ databases, tenants }));
  process.env.FAKE_MONGO_STATE = file;
  return () => read(file);
}

const certbotCalls = () => fs.readFileSync(process.env.FAKE_CERTBOT_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function canSymlink() {
  const target = path.join(root, `.symlink-check-${process.pid}`);
  try {
    fs.symlinkSync('x', target);
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

function request(config, jobId, body) {
  fs.writeFileSync(path.join(config.requestsDir, `${jobId}.json`), typeof body === 'string' ? body : JSON.stringify(body));
}

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-worker-test-')));
  fs.writeFileSync(path.join(root, 'fake-mongo.mjs'), FAKE_MONGO);
  fs.writeFileSync(path.join(root, 'fake-certbot.mjs'), FAKE_CERTBOT);
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('host names, job ids and database names', () => {
  const config = loadConfig({});
  for (const host of [HOST, `abc.${BASE}`, `shop-a.${BASE}`, `${'a'.repeat(30)}.${BASE}`, `admin.${BASE}`]) {
    assert.ok(isValidHost(config, host), host);
  }
  const refused = [
    '', '../x', `../x.${BASE}`, `A.${BASE}`, `Amal.${BASE}`, `ab.${BASE}`, `${'a'.repeat(31)}.${BASE}`, `1abc.${BASE}`, `abc-.${BASE}`,
    `x.erp.108-61-190-4.sslip.io`, `amal.erp.108-61-190-4.sslip.io`, `a.b.${BASE}`, `amal.${BASE}.evil.com`, `amal_x.${BASE}`, `amal.${BASE}/`,
    `smoke.108-61-190-4.sslip.io`, `amal.pos.localhost`, null, 42,
  ];
  for (const host of refused) assert.ok(!isValidHost(config, host), String(host));

  assert.ok(isJobFile(`${'0123456789abcdef01234567'}.json`));
  for (const name of ['0123456789abcdef01234567', '0123456789ABCDEF01234567.json', '0123456789abcdef0123456.json', '0123456789abcdef01234567.json.tmp', '../0123456789abcdef01234567.json']) {
    assert.ok(!isJobFile(name), name);
  }
  assert.ok(TENANT_DB.test(DB_A));
  for (const name of ['pos_control', 'pos_t_', `pos_t_${'A'.repeat(24)}`, `pos_t_${'a'.repeat(23)}`, `smoke_shop`, `pos_test_x`]) assert.ok(!TENANT_DB.test(name), name);
});

test('request files: exactly the contract, everything else refused', () => {
  const config = makeConfig('requests');
  const archive = path.join(config.backupDir, DB_A, '20261103T003000Z-manual.archive.gz');
  const backup = { type: 'backup', tenantId: TENANT, dbName: DB_A, reason: 'manual' };
  const restore = { type: 'restore', tenantId: TENANT, archive, fromDb: DB_A, targetDb: DB_NEW };
  const drop = { type: 'drop', tenantId: TENANT, dbName: DB_A, verifiedArchive: archive };
  for (const job of [backup, restore, drop, { ...backup, reason: 'pre-delete' }, { ...backup, reason: 'purge' }]) {
    assert.deepStrictEqual({ ...parseRequest(config, JSON.stringify(job)) }, job);
  }
  const refused = [
    'not json', '[]', 'null', '"x"',
    { ...backup, type: 'shell' },
    { ...backup, extra: 1 },
    { type: 'backup', tenantId: TENANT, dbName: DB_A },
    { ...backup, dbName: 'pos_control' },
    { ...backup, dbName: 'smoke_shop' },
    { ...backup, reason: 'nightly' },
    { ...backup, tenantId: 'x' },
    { ...backup, tenantId: { $ne: '' } },
    { ...restore, archive: path.join(config.backupDir, DB_B, '20261103T003000Z-manual.archive.gz') },
    { ...restore, archive: [config.backupDir, DB_A, '..', DB_A, '20261103T003000Z-manual.archive.gz'].join(path.sep) },
    { ...restore, archive: path.join(root, 'elsewhere', DB_A, '20261103T003000Z-manual.archive.gz') },
    { ...restore, archive: path.join(config.backupDir, DB_A, 'x.archive.gz') },
    { ...restore, archive: 'relative/path.archive.gz' },
    { ...restore, targetDb: 'admin' },
    { ...drop, dbName: DB_B },
    { ...drop, verifiedArchive: 7 },
  ];
  for (const body of refused) {
    assert.throws(() => parseRequest(config, typeof body === 'string' ? body : JSON.stringify(body)), /طلب غير صالح|مسار النسخة/, JSON.stringify(body));
  }
  assert.throws(() => checkArchivePath(config, path.join(config.backupDir, DB_A), DB_A), /مسار النسخة/);
});

test('archive files on disk: a regular file with one link, no symbolic link on the way', async (t) => {
  const config = makeConfig('archives');
  const dir = path.join(config.backupDir, DB_A);
  fs.mkdirSync(dir);
  const file = path.join(dir, '20261103T003000Z-manual.archive.gz');
  await assert.rejects(assertArchiveFile(config, file, DB_A), /غير موجود/);
  fs.writeFileSync(file, 'x');
  assert.strictEqual(await assertArchiveFile(config, file, DB_A), file);

  const linked = path.join(dir, '20261103T003001Z-manual.archive.gz');
  fs.linkSync(file, linked);
  await assert.rejects(assertArchiveFile(config, linked, DB_A), /ليس ملفًا عاديًا/);

  if (!canSymlink()) return t.skip('symbolic links need a privilege on this system');
  const viaLink = path.join(dir, '20261103T003002Z-manual.archive.gz');
  fs.symlinkSync(file, viaLink);
  await assert.rejects(assertArchiveFile(config, viaLink, DB_A), /ليس ملفًا عاديًا/);
  // The database folder itself a link to another one
  fs.symlinkSync(dir, path.join(config.backupDir, DB_B), 'dir');
  await assert.rejects(assertArchiveFile(config, path.join(config.backupDir, DB_B, '20261103T003000Z-manual.archive.gz'), DB_B), /ليس مجلدًا/);
});

test('state files are replaced in one rename, with nothing left behind', async () => {
  const config = makeConfig('atomic');
  const file = path.join(config.stateDir, 'x.json');
  await writeJsonAtomic(file, { a: 1 });
  await writeJsonAtomic(file, { a: 2, text: 'نص' });
  assert.deepStrictEqual(read(file), { a: 2, text: 'نص' });
  assert.deepStrictEqual(fs.readdirSync(config.stateDir), ['x.json']);
});

test('the lock: one run at a time, and a dead run does not block for ever', async () => {
  const config = makeConfig('lock');
  const release = await acquireLock(config.lockFile);
  assert.ok(release);
  assert.strictEqual(await acquireLock(config.lockFile), null);
  release();
  assert.ok(!exists(config.lockFile));

  // A lock left by a process that has exited
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(config.lockFile, `${dead.stdout}\n`);
  const again = await acquireLock(config.lockFile);
  assert.ok(again, 'stale lock taken over');
  assert.strictEqual(fs.readFileSync(config.lockFile, 'utf8').trim(), String(process.pid));
  again();
});

test('spool folders: only valid names of empty regular files, each bad one logged once', async (t) => {
  const config = makeConfig('scan');
  const d = config.desiredDir;
  fs.writeFileSync(path.join(d, HOST), '');
  fs.writeFileSync(path.join(d, `admin.${BASE}`), '');
  fs.writeFileSync(path.join(d, `full.${BASE}`), 'x');
  fs.writeFileSync(path.join(d, `A.${BASE}`), '');
  fs.writeFileSync(path.join(d, `x.erp.108-61-190-4.sslip.io`), '');
  fs.writeFileSync(path.join(d, `ab.${BASE}`), '');
  fs.writeFileSync(path.join(d, `half.${BASE}.tmp`), '');
  fs.mkdirSync(path.join(d, `folder.${BASE}`));
  fs.writeFileSync(path.join(root, 'outside'), '');
  fs.linkSync(path.join(root, 'outside'), path.join(d, `hard.${BASE}`));
  if (canSymlink()) fs.symlinkSync(path.join(root, 'outside'), path.join(d, `link.${BASE}`));

  const logs = [];
  const notices = { seen: {}, note(key, stamp, message) { if (this.seen[key] !== String(stamp)) logs.push(message); this.seen[key] = String(stamp); } };
  const scan = () => scanSpool(config, d, { validName: (n) => isValidHost(config, n), empty: true }, notices);
  const found = await scan();
  assert.deepStrictEqual(found.map((e) => e.name).sort(), [`admin.${BASE}`, HOST].sort());
  const bad = canSymlink() ? 7 : 6;
  assert.strictEqual(logs.length, bad, logs.join('\n'));
  await scan();
  assert.strictEqual(logs.length, bad, 'logged once, not at every run');
  if (!canSymlink()) t.diagnostic('symbolic link case skipped: needs a privilege on this system');
});

test('certificate tries: checks first, then backoff, giving up after 6, and a new try when asked', async () => {
  let clock = Date.parse('2026-11-03T10:00:00Z');
  let dnsCalls = 0;
  let dnsFails = true;
  const config = makeConfig('certs', { now: () => new Date(clock) });
  config.checks = {
    dns: async () => {
      dnsCalls += 1;
      if (dnsFails) throw new Error('فحص DNS: العنوان يشير إلى 1.2.3.4 وليس 108.61.190.4');
    },
    probe: async () => {},
  };
  const desired = path.join(config.desiredDir, HOST);
  fs.writeFileSync(desired, '');
  // Asked at the start of this test's clock, not the machine's: a real date later than the
  // give-up below would read as asked again
  fs.utimesSync(desired, new Date(clock), new Date(clock));
  const statePath = path.join(config.stateDir, 'certs', `${HOST}.json`);

  await runOnce(config);
  let state = read(statePath);
  assert.deepStrictEqual(Object.keys(state), ['host', 'status', 'attempts', 'nextAttemptAt', 'expiresAt', 'lastError', 'updatedAt']);
  assert.strictEqual(state.status, 'pending');
  assert.strictEqual(state.attempts, 1);
  assert.strictEqual(state.nextAttemptAt, new Date(clock + 2 * 60_000).toISOString());
  assert.match(state.lastError, /فحص DNS/);
  assert.strictEqual(certbotCalls().length, 0, 'certbot is not called when the DNS check fails');

  // Before the wait is over: nothing is tried and the file is not rewritten
  const written = state.updatedAt;
  clock += 60_000;
  await runOnce(config);
  assert.strictEqual(dnsCalls, 1);
  assert.strictEqual(read(statePath).updatedAt, written);

  // The checks pass, certbot refuses: each failure waits longer (10 min, 1 h, 6 h, 24 h)
  dnsFails = false;
  process.env.FAKE_CERTBOT_MODE = 'fail';
  const waits = [10 * 60_000, 3600_000, 6 * 3600_000, 24 * 3600_000];
  for (const [i, wait] of waits.entries()) {
    clock = Date.parse(state.nextAttemptAt) + 1000;
    await runOnce(config);
    state = read(statePath);
    assert.strictEqual(state.attempts, i + 2);
    assert.strictEqual(state.status, 'pending');
    assert.strictEqual(state.nextAttemptAt, new Date(clock + wait).toISOString());
    assert.match(state.lastError, /تعذّر إصدار الشهادة من Let's Encrypt: Some challenges have failed/);
  }
  clock = Date.parse(state.nextAttemptAt) + 1000;
  await runOnce(config);
  state = read(statePath);
  assert.strictEqual(state.status, 'failed');
  assert.strictEqual(state.attempts, 6);
  assert.strictEqual(state.nextAttemptAt, null);

  const calls = certbotCalls();
  assert.strictEqual(calls.length, 5);
  const args = calls[0];
  assert.strictEqual(args[0], 'certonly');
  for (const [flag, value] of [['--config-dir', config.le.configDir], ['--work-dir', config.le.workDir], ['--logs-dir', config.le.logsDir], ['--webroot-path', config.le.webroot], ['--cert-name', HOST], ['-d', HOST], ['--key-type', 'ecdsa']]) {
    assert.strictEqual(args[args.indexOf(flag) + 1], value, flag);
  }
  assert.ok(args.includes('--non-interactive') && args.includes('--webroot') && args.includes('--keep-until-expiring'));

  // Failed stays failed...
  clock += 7 * 24 * 3600_000;
  await runOnce(config);
  assert.strictEqual(read(statePath).status, 'failed');
  assert.strictEqual(certbotCalls().length, 5);
  // ...until the app touches desired/<host> again
  fs.utimesSync(desired, new Date(clock + 1000), new Date(clock + 1000));
  clock += 2000;
  await runOnce(config);
  state = read(statePath);
  assert.strictEqual(state.status, 'pending');
  assert.strictEqual(state.attempts, 1);
  assert.strictEqual(certbotCalls().length, 6);
  delete process.env.FAKE_CERTBOT_MODE;
});

test('certificate limits: 3 orders a run', async () => {
  const config = makeConfig('limits');
  process.env.FAKE_CERTBOT_MODE = 'fail';
  for (const name of ['aaa', 'bbb', 'ccc', 'ddd', 'eee']) fs.writeFileSync(path.join(config.desiredDir, `${name}.${BASE}`), '');
  await runOnce(config);
  assert.strictEqual(certbotCalls().length, 3);
  const states = fs.readdirSync(path.join(config.stateDir, 'certs')).map((n) => read(path.join(config.stateDir, 'certs', n)));
  assert.strictEqual(states.filter((s) => s.attempts === 1).length, 3);
  assert.strictEqual(states.filter((s) => s.attempts === 0 && s.status === 'pending').length, 2);
  delete process.env.FAKE_CERTBOT_MODE;
});

test('a certificate issued and installed for nginx, then retired after 24 hours', async (t) => {
  const certDir = path.join(root, 'cert-fixture');
  fs.mkdirSync(certDir, { recursive: true });
  const made = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'), '-days', '90',
    '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`,
  ], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip('openssl is not available to make a test certificate');
  if (!canSymlink()) return t.skip('symbolic links need a privilege on this system');

  let clock = Date.now();
  const config = makeConfig('issue', { now: () => new Date(clock) });
  process.env.FAKE_CERT_DIR = certDir;
  process.env.FAKE_CERTBOT_MODE = 'ok';
  fs.writeFileSync(path.join(config.desiredDir, HOST), '');
  await runOnce(config);
  const state = read(path.join(config.stateDir, 'certs', `${HOST}.json`));
  assert.strictEqual(state.status, 'issued', state.lastError);
  assert.strictEqual(state.lastError, null);
  const link = path.join(config.nginxCertDir, HOST);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.match(fs.readlinkSync(link), new RegExp(`^\\.${HOST.replace(/\./g, '\\.')}\\.\\d{8}T\\d{6}Z-[0-9a-f]{6}$`));
  assert.strictEqual(fs.readFileSync(path.join(link, 'fullchain.pem'), 'utf8'), fs.readFileSync(path.join(certDir, 'cert.pem'), 'utf8'));
  assert.strictEqual(fs.statSync(path.join(link, 'privkey.pem')).mode & 0o777, 0o640);
  assert.strictEqual(new Date(state.expiresAt).getTime() > clock + 80 * 24 * 3600_000, true);

  // The next run finds it installed and changes nothing
  await runOnce(config);
  assert.strictEqual(certbotCalls().filter((a) => a[0] === 'certonly').length, 1);

  // Retired: noted now, removed 24 hours later with the request files
  fs.writeFileSync(path.join(config.retireDir, HOST), '');
  await runOnce(config);
  assert.ok(exists(link));
  clock += 25 * 3600_000;
  await runOnce(config);
  assert.strictEqual(read(path.join(config.stateDir, 'certs', `${HOST}.json`)).status, 'retired');
  assert.ok(!exists(link) && !fs.readdirSync(config.nginxCertDir).length);
  assert.ok(!exists(path.join(config.desiredDir, HOST)) && !exists(path.join(config.retireDir, HOST)));
  assert.ok(certbotCalls().some((a) => a[0] === 'delete' && a.includes(HOST)));
  delete process.env.FAKE_CERTBOT_MODE;
});

test('backup, restore and drop jobs, with their checks', async () => {
  const config = makeConfig('jobs');
  const server = fakeServer(config, { [DB_A]: { sales: 5, products: 3, users: 1 }, [DB_B]: { sales: 1 }, pos_control: { tenants: 2 } }, [
    { id: TENANT, slug: 'amal', dbName: DB_A, status: 'active', previous: [] },
  ]);
  const jobState = (id) => read(path.join(config.stateDir, 'jobs', `${id}.json`));

  // Backup: dumped, restored into a temporary database, counted, listed
  const backupId = '0'.repeat(23) + '1';
  request(config, backupId, { type: 'backup', tenantId: TENANT, dbName: DB_A, reason: 'manual' });
  await runOnce(config);
  let state = jobState(backupId);
  assert.deepStrictEqual(Object.keys(state), ['jobId', 'type', 'status', 'result', 'error', 'updatedAt']);
  assert.strictEqual(state.status, 'done', state.error);
  assert.deepStrictEqual(state.result.counts, { sales: 5, products: 3, users: 1 });
  assert.match(path.basename(state.result.archive), /^\d{8}T\d{6}Z-manual\.archive\.gz$/);
  assert.strictEqual(state.result.bytes, fs.statSync(state.result.archive).size);
  assert.ok(!exists(path.join(config.requestsDir, `${backupId}.json`)), 'the request is removed');
  assert.deepStrictEqual(Object.keys(server().databases).sort(), [DB_A, DB_B, 'pos_control'].sort(), 'the verification database is dropped');
  const list = read(path.join(config.stateDir, 'backups', `${DB_A}.json`));
  assert.deepStrictEqual(list, { dbName: DB_A, archives: [{ path: state.result.archive, bytes: state.result.bytes, createdAt: list.archives[0].createdAt, kind: 'manual', verified: true }] });
  const verified = state.result.archive;

  // The same request again: not run twice
  request(config, backupId, { type: 'backup', tenantId: TENANT, dbName: DB_A, reason: 'manual' });
  await runOnce(config);
  assert.strictEqual(fs.readdirSync(path.join(config.backupDir, DB_A)).filter((n) => n.endsWith('.archive.gz')).length, 1);
  assert.ok(!exists(path.join(config.requestsDir, `${backupId}.json`)));

  // A restore that does not give back what was dumped fails, and nothing is kept
  process.env.FAKE_RESTORE_LOSE = '1';
  const lossyId = '0'.repeat(23) + '2';
  request(config, lossyId, { type: 'backup', tenantId: TENANT, dbName: DB_A, reason: 'pre-delete' });
  await runOnce(config);
  delete process.env.FAKE_RESTORE_LOSE;
  state = jobState(lossyId);
  assert.strictEqual(state.status, 'failed');
  assert.match(state.error, /لا تطابق الأصل/);
  assert.strictEqual(fs.readdirSync(path.join(config.backupDir, DB_A)).filter((n) => n.includes('pre-delete')).length, 0);

  // Restore: never over an existing database
  const overId = '0'.repeat(23) + '3';
  request(config, overId, { type: 'restore', tenantId: TENANT, archive: verified, fromDb: DB_A, targetDb: DB_B });
  await runOnce(config);
  assert.match(jobState(overId).error, /موجودة مسبقًا/);
  assert.deepStrictEqual(server().databases[DB_B], { sales: 1 });

  const restoreId = '0'.repeat(23) + '4';
  request(config, restoreId, { type: 'restore', tenantId: TENANT, archive: verified, fromDb: DB_A, targetDb: DB_NEW });
  await runOnce(config);
  state = jobState(restoreId);
  assert.strictEqual(state.status, 'done', state.error);
  assert.deepStrictEqual(state.result, { targetDb: DB_NEW, counts: { sales: 5, products: 3, users: 1 } });

  // Drop: refused with a nightly archive (checked by gzip only), refused while a live shop uses
  // the database, done once the shop is being deleted and the archive was verified by a restore
  const nightly = await dumpDatabase(config, DB_A, 'nightly', { verify: 'gzip' });
  const dropNightlyId = '0'.repeat(23) + '5';
  request(config, dropNightlyId, { type: 'drop', tenantId: TENANT, dbName: DB_A, verifiedArchive: nightly.path });
  await runOnce(config);
  assert.match(jobState(dropNightlyId).error, /مُتحقَّق منها بالاستعادة/);

  const dropLiveId = '0'.repeat(23) + '6';
  request(config, dropLiveId, { type: 'drop', tenantId: TENANT, dbName: DB_A, verifiedArchive: verified });
  await runOnce(config);
  assert.match(jobState(dropLiveId).error, /قاعدة المتجر amal \(active\)/);
  assert.ok(server().databases[DB_A]);

  const s = server();
  s.tenants[0].status = 'pending_deletion';
  fs.writeFileSync(process.env.FAKE_MONGO_STATE, JSON.stringify(s));
  const dropId = '0'.repeat(23) + '7';
  request(config, dropId, { type: 'drop', tenantId: TENANT, dbName: DB_A, verifiedArchive: verified });
  await runOnce(config);
  state = jobState(dropId);
  assert.strictEqual(state.status, 'done', state.error);
  assert.deepStrictEqual(state.result, { dropped: true });
  assert.ok(!server().databases[DB_A]);

  // A request that is not valid: failed with the reason, request removed
  const badId = '0'.repeat(23) + '8';
  request(config, badId, { type: 'drop', tenantId: TENANT, dbName: 'pos_control', verifiedArchive: verified });
  const junkId = '0'.repeat(23) + '9';
  request(config, junkId, '{not json');
  await runOnce(config);
  assert.deepStrictEqual([jobState(badId).type, jobState(badId).status], ['drop', 'failed']);
  assert.match(jobState(badId).error, /طلب غير صالح/);
  assert.deepStrictEqual([jobState(junkId).type, jobState(junkId).status], ['unknown', 'failed']);
  assert.deepStrictEqual(fs.readdirSync(config.requestsDir), []);
  assert.ok(server().pos_control === undefined && server().databases.pos_control, 'pos_control untouched');
});

test('a job left running by a dead run is marked failed', async () => {
  const config = makeConfig('orphan');
  fakeServer(config, {});
  const id = 'f'.repeat(24);
  fs.mkdirSync(path.join(config.stateDir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, 'jobs', `${id}.json`), JSON.stringify({ jobId: id, type: 'backup', status: 'running', result: null, error: null, updatedAt: new Date().toISOString() }));
  await runOnce(config);
  const state = read(path.join(config.stateDir, 'jobs', `${id}.json`));
  assert.strictEqual(state.status, 'failed');
  assert.match(state.error, /توقف العامل/);
});

test('a restore cut off half way: its partial target is dropped, so asking again works; a database a shop names never is', async () => {
  const config = makeConfig('orphan-restore');
  const server = fakeServer(config, { [DB_A]: { sales: 5 }, [DB_B]: { sales: 2 }, [DB_NEW]: { sales: 3 } }, [
    { id: TENANT, slug: 'amal', dbName: DB_A, status: 'suspended', previous: [DB_B] },
  ]);
  const jobs = path.join(config.stateDir, 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const running = (id, targetDb) =>
    fs.writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify({ jobId: id, type: 'restore', status: 'running', targetDb, result: null, error: null, updatedAt: new Date().toISOString() }));
  // The running state a restore writes names its target
  await runOnce(config); // makes the state folders
  const archive = await dumpDatabase(config, DB_A, 'manual', { verify: 'restore' });
  const fresh = `pos_t_${'d'.repeat(24)}`;
  const firstId = '1'.repeat(23) + 'a';
  request(config, firstId, { type: 'restore', tenantId: TENANT, archive: archive.path, fromDb: DB_A, targetDb: fresh });
  const peek = path.join(path.dirname(config.spoolDir), 'peek.json');
  process.env.FAKE_RESTORE_PEEK = `${jobs}|${peek}`;
  try {
    await runOnce(config);
  } finally {
    delete process.env.FAKE_RESTORE_PEEK;
  }
  const during = read(peek).find((s) => s.jobId === firstId);
  assert.deepStrictEqual([during.status, during.targetDb], ['running', fresh]);
  assert.strictEqual(read(path.join(jobs, `${firstId}.json`)).status, 'done');
  assert.strictEqual(server().databases[fresh].sales, 5);

  // Killed while restoring into DB_NEW (half of it there); another state names DB_B, a database
  // the shop keeps after a restore, and one names the shop's own: those two stay
  running('2'.repeat(24), DB_NEW);
  running('3'.repeat(24), DB_B);
  running('4'.repeat(24), DB_A);
  await runOnce(config);
  for (const id of ['2', '3', '4']) assert.strictEqual(read(path.join(jobs, `${id.repeat(24)}.json`)).status, 'failed');
  assert.deepStrictEqual(Object.keys(server().databases).sort(), [DB_A, DB_B, fresh].sort());
  assert.ok(config.logs.some((l) => l.includes(`Dropped ${DB_NEW}`)), config.logs.join('\n'));

  // The same restore asked for again now goes through
  const againId = '5'.repeat(24);
  request(config, againId, { type: 'restore', tenantId: TENANT, archive: archive.path, fromDb: DB_A, targetDb: DB_NEW });
  await runOnce(config);
  const again = read(path.join(jobs, `${againId}.json`));
  assert.strictEqual(again.status, 'done', again.error);
  assert.deepStrictEqual(server().databases[DB_NEW], { sales: 5 });
});

test('state folders the worker recreates stay 0755 under UMask=0077, so the app can read them', async (t) => {
  if (process.platform === 'win32') return t.skip('file modes are POSIX only');
  const config = makeConfig('state-dirs');
  fakeServer(config, {});
  fs.rmSync(config.stateDir, { recursive: true, force: true });
  // The umask of pos-root-worker.service and pos-backup.service
  const previous = process.umask(0o077);
  try {
    await runOnce(config);
  } finally {
    process.umask(previous);
  }
  for (const dir of [config.stateDir, ...['certs', 'jobs', 'backups'].map((d) => path.join(config.stateDir, d))]) {
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o755, dir);
  }
  assert.strictEqual(fs.statSync(config.workDir).mode & 0o777, 0o700);
});

test('nightly: pos_control and every live shop, then a restore drill', async () => {
  const config = makeConfig('nightly');
  fakeServer(config, { [DB_A]: { sales: 2 }, [DB_B]: { sales: 9 }, pos_control: { tenants: 2 }, other_site: { x: 1 } }, [
    { id: TENANT, slug: 'amal', dbName: DB_A, status: 'active', previous: [] },
    { id: 'b'.repeat(24), slug: 'gone', dbName: DB_B, status: 'deleted', previous: [] },
  ]);
  const report = await runNightly(config);
  assert.strictEqual(report.ok, true, report.errors.join('; '));
  assert.deepStrictEqual(Object.keys(report.databases).sort(), ['pos_control', DB_A].sort());
  assert.ok(!exists(path.join(config.backupDir, 'other_site')) && !exists(path.join(config.backupDir, DB_B)));
  assert.strictEqual(report.drill.ok, true);
  assert.strictEqual(report.drill.dbName, DB_A);
  const saved = read(path.join(config.workDir, 'nightly.json'));
  assert.strictEqual(saved.lastSuccessAt, report.finishedAt);
  // The drill is weekly: not again the next night
  assert.strictEqual((await runNightly(config)).drill, null);
});

test('retention: 14 daily, 8 weekly, 6 monthly; job archives by age; the newest always', () => {
  const now = new Date('2026-11-03T01:00:00Z');
  const day = 24 * 3600_000;
  const archives = [];
  for (let i = 0; i < 400; i += 1) {
    const createdAt = new Date(now.getTime() - i * day - 30 * 60_000);
    archives.push({ name: `n${i}`, kind: 'nightly', createdAt });
  }
  archives.push({ name: 'manual-80', kind: 'manual', createdAt: new Date(now - 80 * day) });
  archives.push({ name: 'manual-100', kind: 'manual', createdAt: new Date(now - 100 * day) });
  archives.push({ name: 'purge-300', kind: 'purge', createdAt: new Date(now - 300 * day) });
  archives.push({ name: 'purge-500', kind: 'pre-delete', createdAt: new Date(now - 500 * day) });
  const { keep, remove } = retentionPlan(archives, { now, dbExists: true });
  const kept = new Set(keep.map((a) => a.name));
  for (let i = 0; i < 14; i += 1) assert.ok(kept.has(`n${i}`), `day ${i}`);
  const nightlyKept = keep.filter((a) => a.kind === 'nightly');
  const weeks = new Set(nightlyKept.map((a) => Math.floor((Math.floor(a.createdAt / day) - 4) / 7)));
  const months = new Set(nightlyKept.map((a) => a.createdAt.toISOString().slice(0, 7)));
  assert.ok(weeks.size >= 8 && months.size >= 6);
  assert.ok(nightlyKept.length <= 14 + 8 + 6);
  assert.ok(nightlyKept.every((a) => now - a.createdAt < 200 * day));
  assert.ok(kept.has('manual-80') && !kept.has('manual-100') && kept.has('purge-300') && !kept.has('purge-500'));
  assert.strictEqual(keep.length + remove.length, archives.length);

  // A database that still exists keeps its newest archive whatever its age
  const old = [{ name: 'old', kind: 'manual', createdAt: new Date(now - 300 * day) }];
  assert.deepStrictEqual(retentionPlan(old, { now, dbExists: true }).remove, []);
  assert.strictEqual(retentionPlan(old, { now, dbExists: false }).remove.length, 1);
});

test('retention: a deleted database keeps nothing after 400 days, its nightly archives included', () => {
  const now = new Date('2026-11-03T01:00:00Z');
  const day = 24 * 3600_000;
  const history = (deletedAt, kind) => {
    const list = [{ name: kind, kind, createdAt: new Date(deletedAt) }];
    for (let i = 1; i <= 200; i += 1) list.push({ name: `n${i}`, kind: 'nightly', createdAt: new Date(deletedAt - i * day - 30 * 60_000) });
    return list;
  };

  // Purged 730 days ago after 200 nights: nothing is left, and no nightly archive outlives the purge one
  const purged = history(now - 730 * day, 'purge');
  const gone = retentionPlan(purged, { now, dbExists: false });
  assert.deepStrictEqual(gone.keep, []);
  assert.strictEqual(gone.remove.length, purged.length);

  // Deleted 30 days ago: its deletion archive and the nightly ones of the 14/8/6 rules stay...
  const deletedAt = now - 30 * day;
  const recent = history(deletedAt, 'pre-delete');
  const kept = retentionPlan(recent, { now, dbExists: false }).keep;
  assert.ok(kept.some((a) => a.kind === 'pre-delete'));
  const nightly = kept.filter((a) => a.kind === 'nightly');
  assert.ok(nightly.length >= 14 && nightly.length <= 14 + 8 + 6, String(nightly.length));
  // ...each nightly one goes when it is 400 days old, and once the deletion archive is 400 days old, all are gone
  const halfway = new Date(deletedAt + 300 * day);
  const fewer = retentionPlan(kept, { now: halfway, dbExists: false }).keep;
  assert.ok(fewer.length < kept.length && fewer.every((a) => halfway - a.createdAt < 400 * day));
  assert.deepStrictEqual(retentionPlan(kept, { now: new Date(deletedAt + 400 * day), dbExists: false }).keep, []);
  // A database that still exists is not affected: its old nightly archives follow the rules alone
  assert.ok(retentionPlan(purged, { now, dbExists: true }).keep.filter((a) => a.kind === 'nightly').length >= 14);
});

test('mongodump counts are read from its own output', () => {
  const stderr = `2026-11-03T00:30:00.1+0000\twriting ${DB_A}.sales to archive 'x'\n2026-11-03T00:30:00.2+0000\tdone dumping ${DB_A}.sales (1520 documents)\n2026-11-03T00:30:00.3+0000\tdone dumping ${DB_A}.settings (1 document)\n2026-11-03T00:30:00.3+0000\tdone dumping other.sales (7 documents)`;
  assert.deepStrictEqual(dumpedCounts(stderr, DB_A), { sales: 1520, settings: 1 });
  // mongodump 100.19.1, as it writes on the server: the namespace in backticks
  const quoted = `2026-11-03T23:11:09.630+0000\tdone dumping \`${DB_A}.settings\` (1 document)\n2026-11-03T23:11:09.637+0000\tdone dumping \`${DB_A}.products\` (0 documents)\n2026-11-03T23:11:09.638+0000\tdone dumping \`other.sales\` (7 documents)`;
  assert.deepStrictEqual(dumpedCounts(quoted, DB_A), { settings: 1, products: 0 });
});

test('monitor: thresholds, journal 5xx count, a problem logged once an hour', () => {
  assert.deepStrictEqual(parseMeminfo('MemTotal: 2000000 kB\nMemAvailable:  281600 kB\nSwapTotal: 2411720 kB\nSwapFree: 1285320 kB\n'), { memAvailableMB: 275, swapUsedMB: 1100 });
  assert.strictEqual(count5xx('{"tenant":"a","status":200}\n{"tenant":"a","status":503,"ms":3}\n{"status": 500}\nplain line 500\n'), 2);

  const config = monitorConfig({});
  const now = new Date('2026-11-03T12:00:00Z');
  config.now = () => now;
  const healthy = {
    memAvailableMB: 800, disks: [{ path: '/', usedPercent: 40 }], mongod: 'active', app: 'active', healthz: 200,
    certs: [{ host: HOST, expiresAt: '2027-01-01T00:00:00Z', days: 59 }], certStates: [], failedJobs: [],
    lastNightlyAt: '2026-11-03T00:31:00Z', lastNightlyErrors: [], lastDrill: { at: '2026-11-01T00:40:00Z', dbName: DB_A, ok: true },
    workerLastOkAt: '2026-11-03T11:59:00Z', workerLastErrors: [], looseBackupFiles: [], errors5xx: 0, hasShops: true,
  };
  assert.deepStrictEqual(evaluate(healthy, config), []);
  const sick = {
    ...healthy, memAvailableMB: 250, disks: [{ path: '/', usedPercent: 85 }], mongod: 'inactive',
    certs: [{ host: HOST, expiresAt: '2026-11-10T00:00:00Z', days: 6 }], lastNightlyAt: '2026-11-01T00:31:00Z',
    workerLastOkAt: '2026-11-03T11:00:00Z', errors5xx: 12, looseBackupFiles: ['/var/backups/pos/x'],
  };
  const problems = evaluate(sick, config);
  assert.deepStrictEqual(problems.map((p) => p.key).sort(), ['5xx', 'backup-perms', `cert:${HOST}`, 'disk:/', 'memory', 'mongod', 'nightly', 'worker'].sort());
  assert.ok(problems.every((p) => p.level === 'error' && /[؀-ۿ]/.test(p.message)));

  const logged = [];
  const log = (level, message) => logged.push(message);
  const first = mergeProblems(problems, null, now, log);
  assert.strictEqual(logged.length, problems.length);
  const later = new Date(now.getTime() + 10 * 60_000);
  const second = mergeProblems(problems, { problems: first }, later, log);
  assert.strictEqual(logged.length, problems.length, 'not again within the hour');
  assert.strictEqual(second[0].since, first[0].since);
  mergeProblems([], { problems: second }, later, log);
  assert.strictEqual(logged.filter((m) => m.includes('resolved')).length, problems.length);
});

