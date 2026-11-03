#!/usr/bin/env node
// pos-root-worker: the only part of the POS that runs as root (docs/multitenant-plan.md,
// section 7; set up by docs/ops-runbook.md). Installed by hand after review as
// /usr/local/sbin/pos-root-worker.mjs and started by systemd:
//
//   pos-root-worker.mjs                one run (pos-root-worker.timer, every minute):
//                                      certificate retirements, certificates, backup jobs, renewals
//   pos-root-worker.mjs --nightly      nightly backups, retention, weekly restore drill (pos-backup.timer)
//   pos-root-worker.mjs --trial HOST   DNS and port 80 checks, then certbot --dry-run (Let's Encrypt
//                                      staging): changes nothing
//   pos-root-worker.mjs --install HOST copy HOST's certificate from /etc/letsencrypt-pos to nginx again
//   pos-root-worker.mjs --status       what the state files say
//
// It imports nothing from the app and only Node's own modules, so a compromised app cannot
// change what runs as root. The app (user pos) talks to it through files in SPOOL_DIR
// (/var/lib/pos-spool), the contract both sides implement:
//   desired/<host>      empty file: issue and keep a certificate for <host>; touching it again
//                       after a failure asks for a new try
//   retire/<host>       empty file: remove <host>'s certificate 24 hours later and stop renewing it
//   requests/<id>.json  a backup, restore or drop job (written <id>.json.tmp, then renamed)
//   state/              written only here, always as a temporary file renamed into place:
//                       certs/<host>.json, jobs/<id>.json, backups/<db>.json (monitor.json is
//                       pos-monitor's)
// Every name and field is checked (patterns, lstat, no symbolic links, no hard links) and
// anything else is ignored and logged once. Programs run with argument arrays, never a shell.
// One lock (WORK_DIR/lock) keeps runs from overlapping, the nightly one included.
import { spawn } from 'node:child_process';
import { constants, createReadStream, readFileSync, unlinkSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns';
import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// O_NOFOLLOW and O_NONBLOCK do not exist on Windows, where only the tests run
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

export const JOB_ID = /^[0-9a-f]{24}$/;
const JOB_FILE = /^[0-9a-f]{24}\.json$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
export const TENANT_DB = /^pos_t_[0-9a-f]{24}$/;
// The temporary databases a verification restores into; the only other names this worker drops
const VERIFY_DB = /^pos_verify_[0-9a-f]{16}$/;
export const ARCHIVE_KINDS = ['nightly', 'manual', 'pre-delete', 'pre-restore', 'purge'];
export const ARCHIVE_NAME = /^(\d{8}T\d{6}Z)-(nightly|manual|pre-delete|pre-restore|purge)\.archive\.gz$/;
const REASONS = ['manual', 'pre-delete', 'pre-restore', 'purge'];
// A database still in use by a shop is never dropped
const LIVE_STATUSES = ['provisioning', 'active', 'suspended'];
const MAX_REQUEST_BYTES = 4096;
const MAX_OUTPUT = 256 * 1024;

const JOB_FIELDS = Object.freeze({
  backup: ['type', 'tenantId', 'dbName', 'reason'],
  restore: ['type', 'tenantId', 'archive', 'fromDb', 'targetDb'],
  drop: ['type', 'tenantId', 'dbName', 'verifiedArchive'],
});

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (date) => (date == null ? null : new Date(date).toISOString());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The end of a program's output, on one line, for an error message
const tail = (text, n = 300) => String(text ?? '').trim().replace(/\s*\n\s*/g, ' | ').slice(-n);

// ---------------------------------------------------------------------------------------
// Settings: the production paths, each one changeable from the environment (the tests point
// them at a temporary folder and at fake programs)

function command(value, fallback) {
  if (!value) return [fallback];
  if (value.startsWith('[')) {
    const list = JSON.parse(value);
    if (!Array.isArray(list) || !list.length || !list.every((s) => typeof s === 'string' && s)) throw new Error(`Not a command: ${value}`);
    return list;
  }
  return [value];
}

// The group id of a group name, from /etc/group (Node has no getgrnam)
function groupId(name) {
  if (!name) return null;
  let text;
  try {
    text = readFileSync('/etc/group', 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const [group, , gid] = line.split(':');
    if (group === name && /^\d+$/.test(gid)) return Number(gid);
  }
  return null;
}

export function makeLogger(stream = process.stderr) {
  // Under systemd a "<3>" prefix sets the journal priority (err, warning, info)
  const journal = Boolean(process.env.JOURNAL_STREAM);
  const priority = { error: 3, warn: 4, info: 6 };
  return (level, message) => {
    stream.write(journal ? `<${priority[level] ?? 6}>${message}\n` : `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
  };
}

export function loadConfig(env = process.env) {
  const spoolDir = path.resolve(env.SPOOL_DIR || '/var/lib/pos-spool');
  const workDir = path.resolve(env.POS_WORKER_DIR || '/var/lib/pos-root-worker');
  const baseDomain = (env.POS_BASE_DOMAIN || 'pos.108-61-190-4.sslip.io').toLowerCase();
  const certGroup = env.POS_CERT_GROUP ?? 'www-data';
  const config = {
    spoolDir,
    desiredDir: path.join(spoolDir, 'desired'),
    retireDir: path.join(spoolDir, 'retire'),
    requestsDir: path.join(spoolDir, 'requests'),
    stateDir: path.join(spoolDir, 'state'),
    workDir,
    lockFile: path.join(workDir, 'lock'),
    backupDir: path.resolve(env.POS_BACKUP_DIR || '/var/backups/pos'),
    baseDomain,
    adminHost: (env.POS_ADMIN_HOST || `admin.${baseDomain}`).toLowerCase(),
    // Same shape as lib/slug.js (3 to 30 characters) and the nginx map in ops/nginx/pos.conf
    hostPattern: new RegExp(`^[a-z][a-z0-9-]{1,28}[a-z0-9]\\.${escapeRegex(baseDomain)}$`),
    publicIpv4: env.POS_PUBLIC_IPV4 || '108.61.190.4',
    mongoUri: env.POS_MONGODB_URI || 'mongodb://127.0.0.1:27017',
    controlDb: env.POS_CONTROL_DB || 'pos_control',
    le: {
      configDir: path.resolve(env.POS_LE_CONFIG_DIR || '/etc/letsencrypt-pos'),
      workDir: path.resolve(env.POS_LE_WORK_DIR || '/var/lib/letsencrypt-pos'),
      logsDir: path.resolve(env.POS_LE_LOGS_DIR || '/var/log/letsencrypt-pos'),
      webroot: path.resolve(env.POS_WEBROOT || '/var/www/letsencrypt'),
    },
    nginxCertDir: path.resolve(env.POS_NGINX_CERT_DIR || '/etc/nginx/pos-certs'),
    certGroup,
    certGid: groupId(certGroup),
    commands: {
      certbot: command(env.POS_CERTBOT, '/usr/bin/certbot'),
      mongodump: command(env.POS_MONGODUMP, '/usr/bin/mongodump'),
      mongorestore: command(env.POS_MONGORESTORE, '/usr/bin/mongorestore'),
      mongosh: command(env.POS_MONGOSH, '/usr/bin/mongosh'),
    },
    limits: {
      // Let's Encrypt orders: 3 a run, 15 in any 24 hours
      perRun: 3,
      perDay: 15,
      // Wait after the 1st, 2nd... failed try; the 6th failure gives up ("failed")
      backoffMs: [2 * MINUTE, 10 * MINUTE, HOUR, 6 * HOUR, DAY],
      maxAttempts: 6,
      renewEveryMs: 12 * HOUR,
      renewWithinMs: 35 * DAY,
      retireAfterMs: DAY,
      // A minute run stops taking new jobs after this, so the next one can start
      jobsBudgetMs: 20 * MINUTE,
    },
    now: () => new Date(),
    log: makeLogger(),
  };
  config.checks = {
    dns: (host) => checkDns(config, host),
    probe: (host) => probeHost(config, host),
  };
  return config;
}

const certStatePath = (config, host) => path.join(config.stateDir, 'certs', `${host}.json`);
const jobStatePath = (config, jobId) => path.join(config.stateDir, 'jobs', `${jobId}.json`);
const backupListPath = (config, dbName) => path.join(config.stateDir, 'backups', `${dbName}.json`);
const workFile = (config, name) => path.join(config.workDir, name);

// ---------------------------------------------------------------------------------------
// Checks on names and fields

export function isValidHost(config, name) {
  return typeof name === 'string' && (config.hostPattern.test(name) || name === config.adminHost);
}

export const isJobFile = (name) => typeof name === 'string' && JOB_FILE.test(name);

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// An archive path as written in a request: absolute, already normal, and exactly
// <backupDir>/<dbName>/<time>-<kind>.archive.gz. Whether it exists is checked when the job runs.
export function checkArchivePath(config, value, dbName) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error('مسار النسخة غير صالح');
  }
  const parts = path.relative(config.backupDir, value).split(path.sep);
  if (parts.length !== 2 || parts[0] !== dbName || !ARCHIVE_NAME.test(parts[1])) {
    throw new Error(`مسار النسخة يجب أن يكون داخل ${path.join(config.backupDir, dbName)}`);
  }
  return value;
}

// The job in a request file, or an error saying what is wrong with it. Exactly the fields of
// its type, all strings, each one checked.
export function parseRequest(config, text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('طلب غير صالح: ليس JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('طلب غير صالح: ليس كائن JSON');
  const fields = Object.hasOwn(JOB_FIELDS, data.type) ? JOB_FIELDS[data.type] : null;
  if (!fields) throw new Error('طلب غير صالح: نوع المهمة غير معروف');
  const extra = Object.keys(data).filter((key) => !fields.includes(key));
  const missing = fields.filter((key) => !Object.hasOwn(data, key));
  if (extra.length || missing.length) throw new Error(`طلب غير صالح: الحقول المطلوبة ${fields.join(', ')} فقط`);
  for (const key of fields) if (typeof data[key] !== 'string') throw new Error(`طلب غير صالح: ${key} ليس نصًا`);
  if (!OBJECT_ID.test(data.tenantId)) throw new Error('طلب غير صالح: tenantId');

  if (data.type === 'backup') {
    if (!TENANT_DB.test(data.dbName)) throw new Error('طلب غير صالح: اسم القاعدة');
    if (!REASONS.includes(data.reason)) throw new Error('طلب غير صالح: سبب النسخة');
  } else if (data.type === 'restore') {
    if (!TENANT_DB.test(data.fromDb) || !TENANT_DB.test(data.targetDb)) throw new Error('طلب غير صالح: اسم القاعدة');
    checkArchivePath(config, data.archive, data.fromDb);
  } else {
    if (!TENANT_DB.test(data.dbName)) throw new Error('طلب غير صالح: اسم القاعدة');
    checkArchivePath(config, data.verifiedArchive, data.dbName);
  }
  return Object.freeze({ ...data });
}

async function lstatOrNull(file) {
  try {
    return await fsp.lstat(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// The archive file of a job, after checking every part of its path on disk: the backup
// folder and the database folder are real folders, the file a regular file with one link,
// and its real path is the path asked for (no symbolic link anywhere below the backup folder)
export async function assertArchiveFile(config, value, dbName) {
  checkArchivePath(config, value, dbName);
  const dbDir = path.dirname(value);
  for (const dir of [config.backupDir, dbDir]) {
    const st = await lstatOrNull(dir);
    if (!st?.isDirectory()) throw new Error(`المجلد ${dir} غير موجود أو ليس مجلدًا`);
  }
  const st = await lstatOrNull(value);
  if (!st) throw new Error('ملف النسخة غير موجود');
  if (!st.isFile() || st.nlink !== 1) throw new Error('ملف النسخة ليس ملفًا عاديًا');
  const real = await fsp.realpath(value);
  const expected = path.join(await fsp.realpath(config.backupDir), dbName, path.basename(value));
  if (real !== expected) throw new Error('مسار ملف النسخة يمر برابط رمزي');
  return value;
}

// ---------------------------------------------------------------------------------------
// Files

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

// Written to a temporary file in the same folder, synced, then renamed over the old one:
// a reader sees the old content or the new, never half of it
export async function writeJsonAtomic(file, data, mode = 0o644) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fsp.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

async function unlinkIfExists(file) {
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// A folder only root can enter, created if missing; a symbolic link or a file there is refused
async function ensurePrivateDir(dir) {
  const st = await lstatOrNull(dir);
  if (!st) {
    await fsp.mkdir(dir, { mode: 0o700 });
  } else if (!st.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  await fsp.chmod(dir, 0o700);
}

// The state folders the app (user pos) reads: 0755 even when recreated under the units'
// UMask=0077, which would make them 0700 and leave the app's jobs waiting for ever
async function ensureStateDirs(config) {
  for (const dir of [config.stateDir, ...['certs', 'jobs', 'backups'].map((d) => path.join(config.stateDir, d))]) {
    const st = await lstatOrNull(dir);
    if (!st) {
      await fsp.mkdir(dir, { mode: 0o755 });
      await fsp.chmod(dir, 0o755);
    } else if (!st.isDirectory()) {
      throw new Error(`${dir} is not a directory`);
    }
  }
  await ensurePrivateDir(config.workDir);
}

// What the app asked for in one spool folder: regular files with a valid name (empty ones
// for desired/ and retire/), oldest first. Anything else is logged once and left alone.
export async function scanSpool(config, dir, { validName, empty }, notices) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    notices?.note(`missing:${dir}`, 'x', `${dir} does not exist`);
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const name = entry.name;
    // Still being written by the app (requests/<id>.json.tmp, renamed when complete)
    if (name.endsWith('.tmp')) continue;
    const file = path.join(dir, name);
    const st = await lstatOrNull(file);
    if (!st) continue;
    if (!validName(name)) {
      notices?.note(`${file}`, st.mtimeMs, `Ignored ${JSON.stringify(name)} in ${dir}: not a valid name`);
      continue;
    }
    const sizeOk = empty ? st.size === 0 : st.size <= MAX_REQUEST_BYTES;
    if (!st.isFile() || st.nlink !== 1 || !sizeOk) {
      notices?.note(`${file}`, st.mtimeMs, `Ignored ${file}: ${st.isSymbolicLink() ? 'a symbolic link' : !st.isFile() ? 'not a regular file' : st.nlink !== 1 ? 'hard linked' : empty ? 'not empty' : 'too large'}`);
      continue;
    }
    found.push({ name, path: file, mtimeMs: st.mtimeMs });
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
}

// A request file, opened without following a link and without blocking on a FIFO, and
// checked again on the open handle (the name could have been swapped after the scan)
async function readRequestFile(file) {
  const handle = await fsp.open(file, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_REQUEST_BYTES) throw new Error('not a regular file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

// Names already logged as ignored, so a bad file is reported once and not every minute
class Notices {
  static async load(config) {
    const notices = new Notices(config);
    notices.previous = (await readJson(workFile(config, 'ignored.json'))) ?? {};
    return notices;
  }

  constructor(config) {
    this.config = config;
    this.previous = {};
    this.current = {};
  }

  note(key, stamp, message) {
    const value = String(stamp);
    if (this.previous[key] !== value) this.config.log('warn', message);
    this.current[key] = value;
  }

  async save() {
    if (JSON.stringify(this.previous) === JSON.stringify(this.current)) return;
    await writeJsonAtomic(workFile(this.config, 'ignored.json'), this.current, 0o600);
  }
}

// ---------------------------------------------------------------------------------------
// The lock: a file holding the owner's pid, created exclusively. A lock whose process is
// gone (or is no longer this worker) is stale and taken over.

async function lockHolder(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return pid;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return null;
  }
  try {
    const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmdline.includes('pos-root-worker')) return null;
  } catch {
    // No /proc (Windows, in the tests): kill() said the process exists
  }
  return pid;
}

// A function that releases the lock, or null when another run still holds it after waitMs
export async function acquireLock(file, { waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await fsp.open(file, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.removeListener('exit', release);
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
        } catch {
          // Already gone
        }
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if ((await lockHolder(file)) === null) {
      await fsp.rm(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(5000, Math.max(50, deadline - Date.now())));
  }
}

// ---------------------------------------------------------------------------------------
// Running programs: an argument array, no shell, output kept (its end only), a time limit

export function run(name, cmd, args, { timeoutMs = 10 * MINUTE } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-MAX_OUTPUT);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT);
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${name} exited with ${signal ?? code}: ${tail(stderr || stdout)}`);
      err.output = { stdout, stderr };
      reject(err);
    });
  });
}

const leDirs = (config) => ['--config-dir', config.le.configDir, '--work-dir', config.le.workDir, '--logs-dir', config.le.logsDir];

// ---------------------------------------------------------------------------------------
// MongoDB through mongosh (the worker cannot use the app's node_modules). Each script starts
// with "// pos-op:<name>" and prints one line "POS_RESULT <json>"; the only values put in a
// script are database names that matched a pattern above.

async function mongosh(config, op, body) {
  const uri = `${config.mongoUri.replace(/\/$/, '')}/?directConnection=true&serverSelectionTimeoutMS=5000&appName=pos-root-worker`;
  const script = `// pos-op:${op}\n${body}`;
  const { stdout } = await run('mongosh', config.commands.mongosh, ['--quiet', '--norc', uri, '--eval', script], { timeoutMs: 5 * MINUTE });
  const line = stdout.split('\n').reverse().find((l) => l.startsWith('POS_RESULT '));
  if (!line) throw new Error(`mongosh ${op}: no result (${tail(stdout)})`);
  return JSON.parse(line.slice('POS_RESULT '.length));
}

function assertCountableDb(config, name) {
  if (!(TENANT_DB.test(name) || VERIFY_DB.test(name) || name === config.controlDb)) throw new Error(`Refusing database name ${JSON.stringify(name)}`);
  return name;
}

export async function listDatabases(config) {
  return mongosh(config, 'databases', "print('POS_RESULT ' + JSON.stringify(db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name)));");
}

export async function listTenants(config) {
  const control = JSON.stringify(config.controlDb);
  return mongosh(
    config,
    'tenants',
    `const list = db.getSiblingDB(${control}).getCollection('tenants').find({}, { slug: 1, dbName: 1, status: 1, previousDbNames: 1 }).toArray();
print('POS_RESULT ' + JSON.stringify(list.map((t) => ({ id: t._id.toHexString(), slug: String(t.slug), dbName: String(t.dbName), status: String(t.status), previous: (t.previousDbNames || []).map((p) => String(p.name)) }))));`,
  );
}

// { collection: number of documents } of one database (system collections left out)
export async function collectionCounts(config, dbName) {
  const name = JSON.stringify(assertCountableDb(config, dbName));
  return mongosh(
    config,
    'counts',
    `const d = db.getSiblingDB(${name});
const out = {};
for (const c of d.getCollectionInfos({ type: 'collection' }, { nameOnly: true })) {
  if (!c.name.startsWith('system.')) out[c.name] = d.getCollection(c.name).countDocuments({});
}
print('POS_RESULT ' + JSON.stringify(out));`,
  );
}

// Only a shop database (after the checks of a drop job or a failed restore into a new one)
// or a verification database
async function dropDatabase(config, dbName) {
  if (!TENANT_DB.test(dbName) && !VERIFY_DB.test(dbName)) throw new Error(`Refusing to drop ${JSON.stringify(dbName)}`);
  const name = JSON.stringify(dbName);
  return mongosh(config, 'drop', `const r = db.getSiblingDB(${name}).dropDatabase();\nprint('POS_RESULT ' + JSON.stringify({ ok: r.ok }));`);
}

async function dropLeftoverVerifyDbs(config) {
  for (const name of await listDatabases(config)) {
    if (!VERIFY_DB.test(name)) continue;
    await dropDatabase(config, name);
    config.log('warn', `Dropped ${name}, a verification database left by an interrupted run`);
  }
}

// mongodump says on stderr how many documents it wrote for each collection:
// "<time>\tdone dumping pos_t_x.sales (123 documents)"
export function dumpedCounts(stderr, dbName) {
  const counts = {};
  for (const m of String(stderr).matchAll(/done dumping ([^\s.]+)\.(\S+) \((\d+) documents?\)/g)) {
    if (m[1] === dbName) counts[m[2]] = Number(m[3]);
  }
  return counts;
}

export function compareCounts(expected, actual) {
  const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const wrong = names.filter((n) => expected[n] !== actual[n]);
  if (wrong.length) {
    const detail = wrong.slice(0, 5).map((n) => `${n}: ${expected[n] ?? '-'} / ${actual[n] ?? '-'}`).join('، ');
    throw new Error(`النسخة لا تطابق الأصل عند التحقق (${detail})`);
  }
}

async function restoreArchive(config, archive, fromDb, toDb) {
  const { stdout, stderr } = await run(
    'mongorestore',
    config.commands.mongorestore,
    [`--uri=${config.mongoUri}`, '--gzip', `--archive=${archive}`, `--nsInclude=${fromDb}.*`, `--nsFrom=${fromDb}.*`, `--nsTo=${toDb}.*`, '--stopOnError', '--numInsertionWorkersPerCollection=1'],
    { timeoutMs: 2 * HOUR },
  );
  const failed = /(\d+) document\(s\) failed to restore/.exec(`${stdout}\n${stderr}`);
  if (failed && Number(failed[1]) > 0) throw new Error(`فشلت استعادة ${failed[1]} مستند`);
}

// The archive restored into a temporary database, counted against what mongodump wrote, and
// the temporary database dropped whatever happened
async function verifyByRestore(config, archive, dbName, expected) {
  const temp = `pos_verify_${randomBytes(8).toString('hex')}`;
  try {
    await restoreArchive(config, archive, dbName, temp);
    const counts = await collectionCounts(config, temp);
    compareCounts(expected, counts);
    return counts;
  } finally {
    await dropDatabase(config, temp).catch((err) => config.log('error', `Could not drop ${temp}: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------------------
// Backups: /var/backups/pos/<db>/<UTC time>-<kind>.archive.gz (0600), with a sidecar
// <archive>.meta.json saying what was checked. Only archives with a valid sidecar count.

const stampOf = (date) => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function dateOfStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

async function checkGzip(file) {
  let bytes = 0;
  await pipeline(
    createReadStream(file),
    createGunzip(),
    new Writable({
      write(chunk, encoding, done) {
        bytes += chunk.length;
        done();
      },
    }),
  );
  if (!bytes) throw new Error('النسخة فارغة بعد فك الضغط');
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function readMeta(archive, dbName) {
  const meta = await readJson(`${archive}.meta.json`);
  if (!meta || meta.dbName !== dbName || typeof meta.counts !== 'object' || !meta.counts) return null;
  return meta;
}

// The archives of one database, newest first
export async function listArchives(config, dbName) {
  const dir = path.join(config.backupDir, dbName);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const archives = [];
  for (const name of names) {
    const m = ARCHIVE_NAME.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    const st = await lstatOrNull(file);
    if (!st?.isFile()) continue;
    archives.push({ name, path: file, kind: m[2], createdAt: dateOfStamp(m[1]), bytes: st.size, meta: await readMeta(file, dbName) });
  }
  return archives.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
}

// state/backups/<db>.json, the list the admin panel shows
async function refreshBackupList(config, dbName) {
  const archives = (await listArchives(config, dbName))
    .filter((a) => a.meta)
    .map((a) => ({ path: a.path, bytes: a.bytes, createdAt: iso(a.createdAt), kind: a.kind, verified: true }));
  await writeJsonAtomic(backupListPath(config, dbName), { dbName, archives });
}

// mongodump of one database into its folder, then the checks: a complete gzip always, and a
// full restore into a temporary database when verify is 'restore' (every job backup; the
// nightly ones are drilled once a week instead)
export async function dumpDatabase(config, dbName, kind, { verify }) {
  if (!(TENANT_DB.test(dbName) || dbName === config.controlDb)) throw new Error(`Refusing database name ${JSON.stringify(dbName)}`);
  if (!ARCHIVE_KINDS.includes(kind)) throw new Error(`Unknown backup kind ${kind}`);
  const dir = path.join(config.backupDir, dbName);
  await ensurePrivateDir(config.backupDir);
  await ensurePrivateDir(dir);

  let createdAt = config.now();
  let name = `${stampOf(createdAt)}-${kind}.archive.gz`;
  while (await lstatOrNull(path.join(dir, name))) {
    createdAt = new Date(createdAt.getTime() + 1000);
    name = `${stampOf(createdAt)}-${kind}.archive.gz`;
  }
  const final = path.join(dir, name);
  const partial = path.join(dir, `.${name}.partial`);
  try {
    const { stderr } = await run('mongodump', config.commands.mongodump, [`--uri=${config.mongoUri}`, `--db=${dbName}`, '--gzip', `--archive=${partial}`], { timeoutMs: 2 * HOUR });
    const counts = dumpedCounts(stderr, dbName);
    const st = await fsp.lstat(partial);
    if (!st.isFile() || st.size === 0) throw new Error('ملف النسخة فارغ');
    await fsp.chmod(partial, 0o600);
    await checkGzip(partial);
    if (verify === 'restore') await verifyByRestore(config, partial, dbName, counts);
    const meta = { dbName, kind, createdAt: iso(createdAt), bytes: st.size, sha256: await fileSha256(partial), counts, verify, verifiedAt: iso(config.now()) };
    await writeJsonAtomic(`${final}.meta.json`, meta, 0o600);
    await fsp.rename(partial, final);
    await refreshBackupList(config, dbName);
    config.log('info', `Backup of ${dbName} (${kind}, ${verify} checked): ${final}, ${st.size} bytes`);
    return { path: final, bytes: st.size, counts };
  } catch (err) {
    await fsp.rm(partial, { force: true });
    throw err;
  }
}

// Which archives of one database to keep: the newest nightly one of each of the last 14 days,
// 8 weeks and 6 months that have one; job archives for 90 days, the deletion ones (pre-delete,
// purge) for 400 days; and always the newest archive of a database that still exists.
// A database that no longer exists gets no new nightly archive, so its last ones would fill
// those 14 + 8 + 6 places for ever: they go after 400 days, like its deletion archive.
export function retentionPlan(archives, { now, dbExists, daily = 14, weekly = 8, monthly = 6 }) {
  const sorted = [...archives].sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Set();
  const nightly = sorted.filter((a) => a.kind === 'nightly' && (dbExists || now - a.createdAt < 400 * DAY));
  const dayKey = (d) => d.toISOString().slice(0, 10);
  // Weeks start on Monday: 1970-01-05 was one
  const weekKey = (d) => Math.floor((Math.floor(d.getTime() / DAY) - 4) / 7);
  const monthKey = (d) => d.toISOString().slice(0, 7);
  for (const [keyOf, limit] of [[dayKey, daily], [weekKey, weekly], [monthKey, monthly]]) {
    const seen = new Set();
    for (const archive of nightly) {
      const key = keyOf(archive.createdAt);
      if (seen.has(key)) continue;
      if (seen.size >= limit) break;
      seen.add(key);
      keep.add(archive.name);
    }
  }
  for (const archive of sorted) {
    if (archive.kind === 'nightly') continue;
    const maxDays = archive.kind === 'pre-delete' || archive.kind === 'purge' ? 400 : 90;
    if (now - archive.createdAt < maxDays * DAY) keep.add(archive.name);
  }
  if (dbExists && sorted.length) keep.add(sorted[0].name);
  return { keep: sorted.filter((a) => keep.has(a.name)), remove: sorted.filter((a) => !keep.has(a.name)) };
}

async function applyRetention(config, existing) {
  let entries;
  try {
    entries = await fsp.readdir(config.backupDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const now = config.now();
  for (const entry of entries) {
    // Only database folders (a symbolic link is not a directory entry here)
    if (!entry.isDirectory() || !(TENANT_DB.test(entry.name) || entry.name === config.controlDb)) continue;
    const dbName = entry.name;
    const dir = path.join(config.backupDir, dbName);
    const plan = retentionPlan(await listArchives(config, dbName), { now, dbExists: existing.has(dbName) });
    for (const archive of plan.remove) {
      await fsp.rm(archive.path, { force: true });
      await fsp.rm(`${archive.path}.meta.json`, { force: true });
      config.log('info', `Retention: removed ${archive.path}`);
    }
    // Left by interrupted runs: partial dumps over a day old, sidecars without their archive
    for (const name of await fsp.readdir(dir)) {
      const file = path.join(dir, name);
      const st = await lstatOrNull(file);
      if (!st?.isFile()) continue;
      const orphanMeta = name.endsWith('.archive.gz.meta.json') && !(await lstatOrNull(file.slice(0, -'.meta.json'.length)));
      const oldPartial = name.endsWith('.partial') && now - st.mtimeMs > DAY;
      if (orphanMeta || oldPartial) await fsp.rm(file, { force: true });
    }
    await refreshBackupList(config, dbName);
  }
}

// Nothing under the backup folder may be readable by anyone but root (folders 0700, files 0600)
async function sweepBackupPermissions(config) {
  let fixed = 0;
  const walk = async (dir, depth) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const st = await fsp.lstat(file);
      if (st.isSymbolicLink()) {
        config.log('warn', `Symbolic link in the backup folder: ${file}`);
        continue;
      }
      const wanted = st.isDirectory() ? 0o700 : 0o600;
      if ((st.mode & 0o777) !== wanted && (st.mode & 0o077) !== 0) {
        await fsp.chmod(file, wanted);
        fixed += 1;
      }
      if (st.isDirectory() && depth < 3) await walk(file, depth + 1);
    }
  };
  if (await lstatOrNull(config.backupDir)) await walk(config.backupDir, 0);
  if (fixed) config.log('warn', `Fixed the permissions of ${fixed} files in ${config.backupDir}`);
  return fixed;
}

// ---------------------------------------------------------------------------------------
// Jobs

async function writeJobState(config, jobId, fields) {
  await writeJsonAtomic(jobStatePath(config, jobId), { jobId, ...fields, updatedAt: iso(config.now()) });
}

async function jobBackup(config, job) {
  if (!(await listDatabases(config)).includes(job.dbName)) throw new Error('قاعدة بيانات المتجر غير موجودة');
  const archive = await dumpDatabase(config, job.dbName, job.reason, { verify: 'restore' });
  return { archive: archive.path, bytes: archive.bytes, counts: archive.counts };
}

// Into a new database only, then counted (and compared with the archive's own counts)
async function jobRestore(config, job) {
  const archive = await assertArchiveFile(config, job.archive, job.fromDb);
  if ((await listDatabases(config)).includes(job.targetDb)) throw new Error('قاعدة البيانات الهدف موجودة مسبقًا، والاستعادة لا تكتب فوق قاعدة موجودة');
  const meta = await readMeta(archive, job.fromDb);
  try {
    await restoreArchive(config, archive, job.fromDb, job.targetDb);
    const counts = await collectionCounts(config, job.targetDb);
    if (meta) compareCounts(meta.counts, counts);
    return { targetDb: job.targetDb, counts };
  } catch (err) {
    // The target did not exist before this job: what it holds now is a partial restore
    await dropDatabase(config, job.targetDb).catch((e) => config.log('error', `Could not drop the partial ${job.targetDb}: ${e.message}`));
    throw err;
  }
}

// Only a shop database, only with an archive of it that this worker verified by a full
// restore (and that has not changed since), and never one a live shop still uses
async function jobDrop(config, job) {
  const archive = await assertArchiveFile(config, job.verifiedArchive, job.dbName);
  const meta = await readMeta(archive, job.dbName);
  if (!meta || meta.verify !== 'restore') throw new Error('لا توجد نسخة احتياطية مُتحقَّق منها بالاستعادة في المسار المطلوب، فلن تُحذف القاعدة');
  if (meta.sha256 !== (await fileSha256(archive))) throw new Error('تغيّر ملف النسخة بعد التحقق منه، فلن تُحذف القاعدة');
  const user = (await listTenants(config)).find((t) => t.dbName === job.dbName && LIVE_STATUSES.includes(t.status));
  if (user) throw new Error(`القاعدة ما زالت قاعدة المتجر ${user.slug} (${user.status})، فلن تُحذف`);
  if ((await listDatabases(config)).includes(job.dbName)) {
    await dropDatabase(config, job.dbName);
    if ((await listDatabases(config)).includes(job.dbName)) throw new Error('القاعدة ما زالت موجودة بعد الحذف');
    config.log('warn', `Dropped ${job.dbName} (verified backup ${archive})`);
  }
  return { dropped: true };
}

const JOBS = { backup: jobBackup, restore: jobRestore, drop: jobDrop };

// What a restore cut off half way left in its new database. Dropped, so the restore can be
// asked for again (it never writes over a database that exists), unless a shop names it as
// its database or one kept after a restore, which the target of a restore still under way
// never is.
async function dropPartialTarget(config, dbName, tenants) {
  if (!TENANT_DB.test(dbName)) return;
  const user = tenants.find((t) => t.dbName === dbName || (t.previous ?? []).includes(dbName));
  if (user) {
    config.log('error', `${dbName}, the target of an interrupted restore, belongs to the shop ${user.slug}: left as it is`);
    return;
  }
  if (!(await listDatabases(config)).includes(dbName)) return;
  await dropDatabase(config, dbName);
  config.log('warn', `Dropped ${dbName}, the partial target of an interrupted restore`);
}

// A job left "running" by a run that died: no run holds the lock but this one. A restore's
// partial target goes with it.
async function failOrphanJobs(config) {
  const dir = path.join(config.stateDir, 'jobs');
  let orphans = 0;
  let tenants = null;
  for (const name of await fsp.readdir(dir)) {
    if (!isJobFile(name)) continue;
    const state = await readJson(path.join(dir, name));
    if (state?.status !== 'running') continue;
    if (state.type === 'restore' && state.targetDb) {
      try {
        tenants ??= await listTenants(config);
        await dropPartialTarget(config, state.targetDb, tenants);
      } catch (err) {
        config.log('error', `Could not drop ${state.targetDb}, the target of an interrupted restore: ${err.message}`);
      }
    }
    await writeJobState(config, name.slice(0, 24), { type: state.type, status: 'failed', result: null, error: 'توقف العامل قبل أن تنتهي المهمة، فأعد طلبها' });
    config.log('warn', `Job ${name.slice(0, 24)} was interrupted`);
    orphans += 1;
  }
  return orphans;
}

async function processJobs(config, ctx, notices) {
  if (await failOrphanJobs(config)) await dropLeftoverVerifyDbs(config).catch((err) => config.log('error', err.message));
  const deadline = ctx.startedAt + config.limits.jobsBudgetMs;
  for (const entry of await scanSpool(config, config.requestsDir, { validName: isJobFile, empty: false }, notices)) {
    if (Date.now() > deadline) break;
    const jobId = entry.name.slice(0, 24);
    let text;
    try {
      text = await readRequestFile(entry.path);
    } catch (err) {
      notices.note(entry.path, entry.mtimeMs, `Ignored ${entry.path}: ${err.message}`);
      continue;
    }
    const existing = await readJson(jobStatePath(config, jobId));
    if (existing?.status === 'done') {
      config.log('info', `Job ${jobId} is already done; removing its repeated request`);
      await unlinkIfExists(entry.path);
      continue;
    }
    let job;
    try {
      job = parseRequest(config, text);
    } catch (err) {
      let type = 'unknown';
      try {
        const t = JSON.parse(text)?.type;
        if (Object.hasOwn(JOB_FIELDS, t)) type = t;
      } catch {
        // Not JSON: type stays unknown
      }
      await writeJobState(config, jobId, { type, status: 'failed', result: null, error: err.message });
      await unlinkIfExists(entry.path);
      config.log('warn', `Job ${jobId} refused: ${err.message}`);
      continue;
    }
    // A restore names its target here, so a run that dies half way leaves it to be dropped
    const target = job.type === 'restore' ? { targetDb: job.targetDb } : {};
    await writeJobState(config, jobId, { type: job.type, status: 'running', ...target, result: null, error: null });
    await unlinkIfExists(entry.path);
    config.log('info', `Job ${jobId}: ${job.type} ${job.dbName ?? job.targetDb}`);
    try {
      const result = await JOBS[job.type](config, job);
      await writeJobState(config, jobId, { type: job.type, status: 'done', result, error: null });
      config.log('info', `Job ${jobId} done`);
    } catch (err) {
      await writeJobState(config, jobId, { type: job.type, status: 'failed', result: null, error: err.message });
      config.log('error', `Job ${jobId} failed: ${err.message}`);
    }
    ctx.summary.jobs += 1;
  }
}

// ---------------------------------------------------------------------------------------
// Certificates

// The A record must be exactly the server's address and there must be no AAAA record
// (Let's Encrypt would try IPv6 first). Guards against names like shop-1-2-3-4 on sslip.io.
async function checkDns(config, host) {
  const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  let a;
  try {
    a = await resolver.resolve4(host);
  } catch (err) {
    throw new Error(`فحص DNS: لا يوجد سجل A للعنوان (${err.code ?? err.message})`);
  }
  if (a.length !== 1 || a[0] !== config.publicIpv4) throw new Error(`فحص DNS: العنوان يشير إلى ${a.join(' ')} وليس ${config.publicIpv4}`);
  let aaaa = [];
  try {
    aaaa = await resolver.resolve6(host);
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw new Error(`فحص DNS: تعذّر التأكد من عدم وجود سجل AAAA (${err.code ?? err.message})`);
  }
  if (aaaa.length) throw new Error(`فحص DNS: للعنوان سجل AAAA (${aaaa.join(' ')})`);
}

// The name reaches this server's nginx on port 80 (ops/nginx/pos.conf answers "pos-ok"), so
// Let's Encrypt will reach the challenge too: no failed validation counts against the name
function probeHost(config, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: config.publicIpv4, port: 80, path: '/.well-known/acme-challenge/pos-probe', headers: { Host: host, 'User-Agent': 'pos-root-worker' }, timeout: 10_000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 100) body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200 && body.trim() === 'pos-ok') resolve();
          else reject(new Error(`فحص الوصول: nginx أعاد ${res.statusCode} بدل pos-ok على المنفذ 80`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => reject(new Error(`فحص الوصول: تعذّر الاتصال على المنفذ 80 (${err.code ?? err.message})`)));
  });
}

function firstPem(text) {
  return /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)?.[0] ?? null;
}

// The first certificate of a PEM file, which must name exactly this host and nothing else
export function inspectCert(pem, host) {
  const first = firstPem(pem);
  if (!first) throw new Error('no certificate in the file');
  const cert = new X509Certificate(first);
  const names = (cert.subjectAltName ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length !== 1 || names[0] !== `DNS:${host}`) throw new Error(`the certificate names ${names.join(' ') || 'nothing'}, not only ${host}`);
  return { cert, serial: cert.serialNumber, validTo: cert.validToDate ?? new Date(cert.validTo) };
}

async function readInstalled(config, host) {
  try {
    return inspectCert(await fsp.readFile(path.join(config.nginxCertDir, host, 'fullchain.pem'), 'utf8'), host);
  } catch {
    return null;
  }
}

// certbot's current certificate and key for the host (live/<host>/*.pem are links into
// archive/<host>/), checked: one name, the key matches
async function readLineage(config, host) {
  const root = await fsp.realpath(config.le.configDir).catch(() => null);
  if (!root) return null;
  const live = path.join(root, 'live', host);
  const archive = path.join(root, 'archive', host);
  const files = {};
  for (const name of ['fullchain.pem', 'privkey.pem']) {
    let real;
    try {
      real = await fsp.realpath(path.join(live, name));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    if (!isInside(real, live) && !isInside(real, archive)) throw new Error(`${name} of ${host} points outside its certbot folders`);
    files[name] = await fsp.readFile(real, 'utf8');
  }
  const info = inspectCert(files['fullchain.pem'], host);
  if (!info.cert.checkPrivateKey(createPrivateKey(files['privkey.pem']))) throw new Error(`the private key of ${host} does not match its certificate`);
  return { ...info, fullchain: files['fullchain.pem'], privkey: files['privkey.pem'] };
}

async function chownCertGroup(config, file) {
  if (config.certGroup && config.certGid === null) throw new Error(`group ${config.certGroup} not found`);
  if (config.certGid !== null) await fsp.chown(file, 0, config.certGid);
}

// The entries of one host in the nginx folder: .<host>.<time>-<rand> (a copy) and
// .<host>.link-<rand> / .<host>.old-<time> (left by an interrupted swap)
function hostEntryOf(name) {
  return /^\.(.+)\.(?:\d{8}T\d{6}Z-[0-9a-f]{6}|link-[0-9a-f]{8}|old-\d{8}T\d{6}Z-[0-9a-f]{6})$/.exec(name)?.[1] ?? null;
}

// Copies the host's certificate and key into /etc/nginx/pos-certs/.<host>.<time>/ (root:www-data,
// folder 0750, files 0640, as niura-certs) and points the link <host> at it with one rename:
// nginx reads the old pair or the new one at each handshake, never one file of each
export async function installCert(config, host, lineage) {
  if (!isValidHost(config, host)) throw new Error(`Not a POS host: ${host}`);
  lineage ??= await readLineage(config, host);
  if (!lineage) throw new Error(`no certificate for ${host} in ${config.le.configDir}`);
  if (lineage.validTo <= config.now()) throw new Error(`the certificate of ${host} has expired`);
  const base = config.nginxCertDir;
  const st = await lstatOrNull(base);
  if (!st?.isDirectory()) throw new Error(`${base} is not a directory`);

  const stamp = `${stampOf(config.now())}-${randomBytes(3).toString('hex')}`;
  const dirName = `.${host}.${stamp}`;
  const dir = path.join(base, dirName);
  await fsp.mkdir(dir, { mode: 0o750 });
  await chownCertGroup(config, dir);
  await fsp.chmod(dir, 0o750);
  for (const [name, text] of [['fullchain.pem', lineage.fullchain], ['privkey.pem', lineage.privkey]]) {
    const file = path.join(dir, name);
    const handle = await fsp.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o640);
    try {
      await handle.writeFile(text);
      await handle.chmod(0o640);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chownCertGroup(config, file);
  }

  const link = path.join(base, host);
  const current = await lstatOrNull(link);
  const previous = current?.isSymbolicLink() ? await fsp.readlink(link) : null;
  // A real folder put there by hand is moved aside, never deleted
  if (current && !current.isSymbolicLink()) await fsp.rename(link, path.join(base, `.${host}.old-${stamp}`));
  const tmpLink = path.join(base, `.${host}.link-${randomBytes(4).toString('hex')}`);
  await fsp.symlink(dirName, tmpLink);
  await fsp.rename(tmpLink, link);

  // Keep the new copy and the one before it (a handshake may still be reading it)
  for (const name of await fsp.readdir(base)) {
    if (hostEntryOf(name) !== host || name === dirName || name === previous || name.startsWith(`.${host}.old-`)) continue;
    await fsp.rm(path.join(base, name), { recursive: true, force: true });
  }
  return lineage;
}

async function removeCertFiles(config, host) {
  const base = config.nginxCertDir;
  const link = path.join(base, host);
  const st = await lstatOrNull(link);
  if (st?.isSymbolicLink()) await fsp.unlink(link);
  else if (st) await fsp.rm(link, { recursive: true, force: true });
  for (const name of await fsp.readdir(base).catch(() => [])) {
    if (hostEntryOf(name) === host) await fsp.rm(path.join(base, name), { recursive: true, force: true });
  }
}

async function certonly(config, host, { dryRun = false } = {}) {
  const args = [
    'certonly', '--non-interactive', '--agree-tos', ...leDirs(config),
    '--webroot', '--webroot-path', config.le.webroot,
    '--cert-name', host, '-d', host,
    '--key-type', 'ecdsa', '--elliptic-curve', 'secp256r1',
    dryRun ? '--dry-run' : '--keep-until-expiring',
  ];
  try {
    await run('certbot', config.commands.certbot, args, { timeoutMs: 5 * MINUTE });
  } catch (err) {
    throw new Error(`تعذّر إصدار الشهادة من Let's Encrypt: ${tail(err.output?.stderr || err.message)}`);
  }
}

const CERT_FIELDS = ['status', 'attempts', 'nextAttemptAt', 'expiresAt', 'lastError'];

// Written only when something other than the time changed, so the files do not churn every minute
async function saveCertState(config, state, previous) {
  if (previous && CERT_FIELDS.every((key) => previous[key] === state[key])) return previous;
  const next = { host: state.host, status: state.status, attempts: state.attempts, nextAttemptAt: state.nextAttemptAt, expiresAt: state.expiresAt, lastError: state.lastError, updatedAt: iso(config.now()) };
  await writeJsonAtomic(certStatePath(config, state.host), next);
  return next;
}

// Let's Encrypt orders this run and in the last 24 hours (WORK_DIR/limits.json)
class OrderBudget {
  static async load(config) {
    const budget = new OrderBudget(config);
    const saved = (await readJson(workFile(config, 'limits.json'))) ?? {};
    const since = config.now().getTime() - DAY;
    const orders = Array.isArray(saved.orders) ? saved.orders : [];
    budget.orders = orders.filter((t) => Date.parse(t) > since);
    budget.changed = budget.orders.length !== orders.length;
    return budget;
  }

  constructor(config) {
    this.config = config;
    this.orders = [];
    this.thisRun = 0;
    this.changed = false;
  }

  get exhausted() {
    return this.thisRun >= this.config.limits.perRun || this.orders.length >= this.config.limits.perDay;
  }

  spend() {
    this.thisRun += 1;
    this.changed = true;
    this.orders.push(iso(this.config.now()));
  }

  async save() {
    if (this.changed) await writeJsonAtomic(workFile(this.config, 'limits.json'), { orders: this.orders }, 0o600);
  }
}

async function ensureCertificate(config, ctx, entry) {
  const host = entry.name;
  const now = config.now();
  const previous = await readJson(certStatePath(config, host));
  const fresh = { host, status: 'pending', attempts: 0, nextAttemptAt: null, expiresAt: null, lastError: null };
  let state = previous && previous.status !== 'retired' ? { ...fresh, ...previous } : { ...fresh };
  // The app touched desired/<host> after the last failure: start again
  if (state.status === 'failed' && entry.mtimeMs > Date.parse(previous.updatedAt)) {
    state = { ...state, status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null };
    config.log('info', `${host}: asked again after failing, trying from the start`);
  }

  // A certificate certbot has and nginx does not (or an older one there): install it
  let installed = await readInstalled(config, host);
  const lineage = await readLineage(config, host).catch((err) => {
    ctx.notices.note(`lineage:${host}`, err.message, `${host}: ${err.message}`);
    return null;
  });
  if (lineage && lineage.validTo > now && installed?.serial !== lineage.serial) {
    installed = await installCert(config, host, lineage);
    config.log('info', `${host}: certificate installed for nginx, valid until ${iso(installed.validTo)}`);
  }
  if (installed && installed.validTo - now > DAY) {
    const lastError = state.status === 'issued' ? state.lastError : null;
    return saveCertState(config, { ...state, status: 'issued', nextAttemptAt: null, expiresAt: iso(installed.validTo), lastError }, previous);
  }
  // Was issued but its certificate is gone or expiring: a new series of tries
  if (state.status === 'issued') state = { ...state, attempts: 0, nextAttemptAt: null };
  if (state.status === 'failed') return saveCertState(config, state, previous);
  if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > now) return saveCertState(config, { ...state, status: 'pending' }, previous);
  if (ctx.budget.exhausted) {
    ctx.notices.note('budget', ctx.budget.orders.length, `Certificate limit reached (${config.limits.perRun} a run, ${config.limits.perDay} a day): ${host} waits`);
    return saveCertState(config, { ...state, status: 'pending' }, previous);
  }

  state = { ...state, status: 'pending', attempts: state.attempts + 1, nextAttemptAt: null };
  let saved = await saveCertState(config, state, previous);
  try {
    await config.checks.dns(host);
    await config.checks.probe(host);
    ctx.budget.spend();
    await certonly(config, host);
    const issued = await readLineage(config, host);
    if (!issued) throw new Error('certbot finished but left no certificate');
    installed = await installCert(config, host, issued);
    state = { ...state, status: 'issued', expiresAt: iso(installed.validTo), lastError: null };
    config.log('info', `${host}: certificate issued, valid until ${state.expiresAt}`);
  } catch (err) {
    const gaveUp = state.attempts >= config.limits.maxAttempts;
    const wait = config.limits.backoffMs[Math.min(state.attempts, config.limits.backoffMs.length) - 1];
    state = { ...state, status: gaveUp ? 'failed' : 'pending', nextAttemptAt: gaveUp ? null : iso(now.getTime() + wait), lastError: err.message };
    config.log(gaveUp ? 'error' : 'warn', `${host}: try ${state.attempts} failed${gaveUp ? ', giving up' : `, next at ${state.nextAttemptAt}`}: ${err.message}`);
  }
  saved = await saveCertState(config, state, saved);
  ctx.summary.certs += 1;
  return saved;
}

async function processCertificates(config, ctx) {
  const desired = await scanSpool(config, config.desiredDir, { validName: (n) => isValidHost(config, n), empty: true }, ctx.notices);
  ctx.desired = desired.map((e) => e.name);
  for (const entry of desired) {
    if (ctx.retiring.has(entry.name)) continue;
    try {
      await ensureCertificate(config, ctx, entry);
    } catch (err) {
      config.log('error', `${entry.name}: ${err.message}`);
      ctx.summary.errors.push(`${entry.name}: ${err.message}`);
    }
  }
}

async function lineageExists(config, host) {
  return Boolean(await lstatOrNull(path.join(config.le.configDir, 'renewal', `${host}.conf`)));
}

async function retireHost(config, host) {
  if (await lineageExists(config, host)) {
    await run('certbot', config.commands.certbot, ['delete', '--non-interactive', ...leDirs(config), '--cert-name', host], { timeoutMs: 2 * MINUTE });
  }
  await removeCertFiles(config, host);
  const previous = await readJson(certStatePath(config, host));
  await saveCertState(config, { host, status: 'retired', attempts: previous?.attempts ?? 0, nextAttemptAt: null, expiresAt: null, lastError: null }, previous);
  await unlinkIfExists(path.join(config.desiredDir, host));
  await unlinkIfExists(path.join(config.retireDir, host));
  config.log('info', `${host}: certificate removed and no longer renewed`);
}

// retire/<host>: noted the first time it is seen, done 24 hours later
async function processRetirements(config, ctx) {
  const file = workFile(config, 'retire.json');
  const memory = (await readJson(file)) ?? {};
  const pending = {};
  const now = config.now();
  for (const entry of await scanSpool(config, config.retireDir, { validName: (n) => isValidHost(config, n), empty: true }, ctx.notices)) {
    const host = entry.name;
    ctx.retiring.add(host);
    const since = typeof memory[host] === 'string' ? memory[host] : iso(now);
    if (!memory[host]) config.log('info', `${host}: certificate will be removed after ${iso(Date.parse(since) + config.limits.retireAfterMs)}`);
    if (now - Date.parse(since) < config.limits.retireAfterMs) {
      pending[host] = since;
      continue;
    }
    try {
      await retireHost(config, host);
      ctx.summary.retired += 1;
    } catch (err) {
      pending[host] = since;
      config.log('error', `${host}: could not retire: ${err.message}`);
    }
  }
  if (JSON.stringify(memory) !== JSON.stringify(pending)) await writeJsonAtomic(file, pending, 0o600);
}

// Twice a day (with up to an hour of jitter), each wanted host whose certificate ends within
// 35 days is given to certbot renew (same folders; certbot decides). nginx needs no reload.
async function processRenewals(config, ctx) {
  const file = workFile(config, 'renew.json');
  const memory = (await readJson(file)) ?? {};
  const now = config.now();
  if (memory.nextCheckAt && Date.parse(memory.nextCheckAt) > now) return;
  for (const host of ctx.desired) {
    if (ctx.retiring.has(host)) continue;
    const lineage = await readLineage(config, host).catch(() => null);
    if (!lineage || lineage.validTo - now > config.limits.renewWithinMs) continue;
    const previous = await readJson(certStatePath(config, host));
    try {
      await run('certbot', config.commands.certbot, ['renew', '--non-interactive', '--no-random-sleep-on-renew', ...leDirs(config), '--cert-name', host], { timeoutMs: 5 * MINUTE });
      const renewed = await readLineage(config, host);
      if (renewed && renewed.serial !== (await readInstalled(config, host))?.serial) await installCert(config, host, renewed);
      if (previous) await saveCertState(config, { ...previous, status: 'issued', expiresAt: iso(renewed?.validTo ?? lineage.validTo), lastError: null }, previous);
      config.log('info', `${host}: renewal checked, valid until ${iso(renewed?.validTo ?? lineage.validTo)}`);
    } catch (err) {
      config.log('error', `${host}: renewal failed: ${err.message}`);
      if (previous) await saveCertState(config, { ...previous, lastError: `تعذّر تجديد الشهادة: ${tail(err.message, 200)}` }, previous);
    }
  }
  const jitter = Math.floor(Math.random() * HOUR);
  await writeJsonAtomic(file, { lastCheckAt: iso(now), nextCheckAt: iso(now.getTime() + config.limits.renewEveryMs + jitter) }, 0o600);
}

// ---------------------------------------------------------------------------------------
// The runs

// One minute run. Each step's failure is logged and does not stop the others.
export async function runOnce(config) {
  await ensureStateDirs(config);
  const ctx = {
    startedAt: Date.now(),
    notices: await Notices.load(config),
    budget: await OrderBudget.load(config),
    retiring: new Set(),
    desired: [],
    summary: { certs: 0, retired: 0, jobs: 0, errors: [] },
  };
  const steps = [
    ['retirements', processRetirements],
    ['certificates', processCertificates],
    ['jobs', processJobs],
    ['renewals', processRenewals],
  ];
  for (const [name, step] of steps) {
    try {
      await step(config, ctx, ctx.notices);
    } catch (err) {
      ctx.summary.errors.push(`${name}: ${err.message}`);
      config.log('error', `${name}: ${err.message}`);
    }
  }
  await ctx.notices.save();
  await ctx.budget.save();
  const status = (await readJson(workFile(config, 'worker.json'))) ?? {};
  const at = iso(config.now());
  await writeJsonAtomic(
    workFile(config, 'worker.json'),
    { lastRunAt: at, lastOkAt: ctx.summary.errors.length ? (status.lastOkAt ?? null) : at, lastErrors: ctx.summary.errors.slice(0, 10) },
    0o600,
  );
  return ctx.summary;
}

// Once a week, the newest nightly archive of one shop (the one drilled longest ago) is
// restored into a temporary database and counted against what mongodump wrote
async function maybeDrill(config, dbNames) {
  const file = workFile(config, 'drill.json');
  const memory = (await readJson(file)) ?? { history: {} };
  const now = config.now();
  if (memory.lastAt && now - Date.parse(memory.lastAt) < 7 * DAY - HOUR) return null;
  const candidates = dbNames.filter((n) => TENANT_DB.test(n)).sort((a, b) => (Date.parse(memory.history?.[a] ?? 0) || 0) - (Date.parse(memory.history?.[b] ?? 0) || 0));
  for (const dbName of candidates) {
    const archive = (await listArchives(config, dbName)).find((a) => a.kind === 'nightly' && a.meta);
    if (!archive) continue;
    const result = { at: iso(now), dbName, archive: archive.path, ok: false, error: null };
    try {
      await verifyByRestore(config, archive.path, dbName, archive.meta.counts);
      result.ok = true;
      config.log('info', `Restore drill of ${dbName}: counts match (${archive.path})`);
    } catch (err) {
      result.error = err.message;
      config.log('error', `Restore drill of ${dbName} failed: ${err.message}`);
    }
    await writeJsonAtomic(file, { lastAt: result.at, last: result, history: { ...memory.history, [dbName]: result.at } }, 0o600);
    return result;
  }
  return null;
}

export async function runNightly(config) {
  await ensureStateDirs(config);
  await ensurePrivateDir(config.backupDir);
  const report = { startedAt: iso(config.now()), finishedAt: null, ok: true, databases: {}, drill: null, errors: [] };
  const fail = (message) => {
    report.ok = false;
    report.errors.push(message);
    config.log('error', message);
  };

  await dropLeftoverVerifyDbs(config).catch((err) => fail(`leftover verification databases: ${err.message}`));
  let tenants = [];
  try {
    tenants = await listTenants(config);
  } catch (err) {
    fail(`could not read the shops from ${config.controlDb}: ${err.message}`);
  }
  let existing = null;
  try {
    existing = new Set(await listDatabases(config));
  } catch (err) {
    fail(`could not list the databases: ${err.message}`);
  }
  if (!existing) {
    // mongod is not answering: no backup can be taken, and retention must not run blind
    report.finishedAt = iso(config.now());
    const previous = (await readJson(workFile(config, 'nightly.json'))) ?? {};
    await writeJsonAtomic(workFile(config, 'nightly.json'), { ...report, lastSuccessAt: previous.lastSuccessAt ?? null }, 0o600);
    return report;
  }

  const targets = [];
  if (existing.has(config.controlDb)) targets.push(config.controlDb);
  else if (existing.size) config.log('warn', `${config.controlDb} does not exist yet`);
  for (const tenant of tenants) {
    if (tenant.status === 'deleted' || !TENANT_DB.test(tenant.dbName) || targets.includes(tenant.dbName)) continue;
    if (existing.has(tenant.dbName)) targets.push(tenant.dbName);
    else config.log('warn', `The database of shop ${tenant.slug} (${tenant.dbName}) does not exist`);
  }
  const registered = new Set(tenants.flatMap((t) => [t.dbName, ...(t.previous ?? [])]));
  for (const name of existing) {
    if (TENANT_DB.test(name) && !registered.has(name)) config.log('warn', `${name} is not registered to any shop (not backed up)`);
  }

  for (const dbName of targets) {
    try {
      const archive = await dumpDatabase(config, dbName, 'nightly', { verify: 'gzip' });
      report.databases[dbName] = { ok: true, archive: archive.path, bytes: archive.bytes };
    } catch (err) {
      report.databases[dbName] = { ok: false, error: err.message };
      fail(`backup of ${dbName} failed: ${err.message}`);
    }
  }

  const steps = [
    ['retention', () => applyRetention(config, existing)],
    ['permissions', () => sweepBackupPermissions(config)],
    ['old job states', () => pruneJobStates(config)],
    ['restore drill', async () => {
      report.drill = await maybeDrill(config, targets);
      if (report.drill && !report.drill.ok) fail(`restore drill of ${report.drill.dbName} failed: ${report.drill.error}`);
    }],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      fail(`${name}: ${err.message}`);
    }
  }

  report.finishedAt = iso(config.now());
  const previous = (await readJson(workFile(config, 'nightly.json'))) ?? {};
  await writeJsonAtomic(workFile(config, 'nightly.json'), { ...report, lastSuccessAt: report.ok ? report.finishedAt : (previous.lastSuccessAt ?? null) }, 0o600);
  config.log(report.ok ? 'info' : 'error', `Nightly backups ${report.ok ? 'done' : 'finished with errors'}: ${Object.keys(report.databases).length} databases`);
  return report;
}

// Job states the app has had a month to read
async function pruneJobStates(config) {
  const dir = path.join(config.stateDir, 'jobs');
  const before = config.now().getTime() - 30 * DAY;
  for (const name of await fsp.readdir(dir)) {
    if (!isJobFile(name)) continue;
    const state = await readJson(path.join(dir, name));
    if (state && state.status !== 'running' && Date.parse(state.updatedAt) < before) await unlinkIfExists(path.join(dir, name));
  }
}

// DNS, port 80, then a certbot --dry-run against Let's Encrypt's staging server: nothing saved
export async function trialHost(config, host) {
  await config.checks.dns(host);
  config.log('info', `${host}: DNS points to ${config.publicIpv4} only`);
  await config.checks.probe(host);
  config.log('info', `${host}: nginx answers the probe on port 80`);
  await certonly(config, host, { dryRun: true });
  config.log('info', `${host}: certbot --dry-run (staging) succeeded`);
}

async function printStatus(config) {
  const out = [];
  const dir = path.join(config.stateDir, 'certs');
  for (const name of (await fsp.readdir(dir).catch(() => [])).sort()) {
    const s = await readJson(path.join(dir, name));
    if (s) out.push(`cert  ${s.host}  ${s.status}  attempts=${s.attempts}  expires=${s.expiresAt ?? '-'}${s.lastError ? `  error=${s.lastError}` : ''}`);
  }
  const jobs = path.join(config.stateDir, 'jobs');
  for (const name of (await fsp.readdir(jobs).catch(() => [])).sort()) {
    const s = await readJson(path.join(jobs, name));
    if (s && s.status !== 'done') out.push(`job   ${s.jobId}  ${s.type}  ${s.status}  ${s.updatedAt}${s.error ? `  error=${s.error}` : ''}`);
  }
  const worker = await readJson(workFile(config, 'worker.json'));
  const nightly = await readJson(workFile(config, 'nightly.json'));
  const drill = await readJson(workFile(config, 'drill.json'));
  out.push(`worker  last run ${worker?.lastRunAt ?? '-'}, last good run ${worker?.lastOkAt ?? '-'}`);
  out.push(`nightly last success ${nightly?.lastSuccessAt ?? '-'}${nightly && !nightly.ok ? ` (last run had errors: ${nightly.errors.join('; ')})` : ''}`);
  out.push(`drill   ${drill?.last ? `${drill.last.at} ${drill.last.dbName} ${drill.last.ok ? 'ok' : `FAILED ${drill.last.error}`}` : '-'}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

const USAGE = `usage: pos-root-worker.mjs [--nightly | --trial HOST | --install HOST | --status]`;

async function main(argv) {
  const config = loadConfig();
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    config.log('error', 'pos-root-worker must run as root');
    return 2;
  }
  const [mode, host] = argv;
  if (mode === undefined || mode === '--once') {
    const release = await acquireLock(config.lockFile);
    if (!release) {
      config.log('info', 'Another run holds the lock; skipping this one');
      return 0;
    }
    try {
      const summary = await runOnce(config);
      return summary.errors.length ? 1 : 0;
    } finally {
      release();
    }
  }
  if (mode === '--nightly') {
    // A minute run may be busy with a job: wait for it rather than skip the night
    const release = await acquireLock(config.lockFile, { waitMs: HOUR });
    if (!release) {
      config.log('error', 'Could not take the lock within an hour: nightly backups not done');
      return 1;
    }
    try {
      return (await runNightly(config)).ok ? 0 : 1;
    } finally {
      release();
    }
  }
  if (mode === '--trial' || mode === '--install') {
    if (!isValidHost(config, host)) {
      config.log('error', `Not a POS host: ${JSON.stringify(host ?? '')}`);
      return 2;
    }
    const release = await acquireLock(config.lockFile, { waitMs: 5 * MINUTE });
    if (!release) {
      config.log('error', 'Another run holds the lock');
      return 1;
    }
    try {
      if (mode === '--trial') await trialHost(config, host);
      else {
        const lineage = await installCert(config, host);
        config.log('info', `${host}: installed, valid until ${iso(lineage.validTo)}`);
      }
      return 0;
    } catch (err) {
      config.log('error', `${host}: ${err.message}`);
      return 1;
    } finally {
      release();
    }
  }
  if (mode === '--status') {
    await printStatus(config);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

const isMain = import.meta.main ?? (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url);
if (isMain) {
  // systemd stops a run with SIGTERM: leave through exit, so the lock is released
  process.once('SIGTERM', () => process.exit(143));
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
