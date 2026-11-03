// The app's side of the root worker (ops/sbin/pos-root-worker.mjs), which issues the HTTPS
// certificates and makes, restores and drops backups, as root, from files the app leaves in
// SPOOL_DIR (docs/ops-runbook.md has the contract):
//   desired/<host>      empty: issue and keep a certificate for <host> (touched again: try again)
//   retire/<host>       empty: remove <host>'s certificate 24 hours later
//   requests/<id>.json  one backup, restore or drop, written as <id>.json.tmp then renamed
//   state/...           written by the worker only: certs/<host>.json, jobs/<id>.json,
//                       backups/<db>.json, monitor.json
// The app user can create files in desired/, retire/ and requests/ but not list them, and
// can only read state/. Every name is checked here as the worker checks it again there.
//
// Without SPOOL_DIR, or with DEV_FAKE_CERTS=1 (development, the tests), createWorker gives a
// local stand-in with the same interface and the same JSON: certificates count as issued at
// once, and backups, restores and drops are done in this process through the driver, with
// archives under .pos-local/backups (an EJSON line per document, gzipped) and the state
// files under .pos-local/state.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { escapeRegex } from './util.js';

const { EJSON } = mongoose.mongo.BSON;

export const JOB_ID = /^[0-9a-f]{24}$/;
export const ARCHIVE_KINDS = Object.freeze(['nightly', 'manual', 'pre-delete', 'pre-restore', 'purge']);
export const ARCHIVE_NAME = /^(\d{8}T\d{6}Z)-(nightly|manual|pre-delete|pre-restore|purge)\.archive\.gz$/;
const BACKUP_REASONS = ['manual', 'pre-delete', 'pre-restore', 'purge'];
// A database still in use by a shop is never dropped (the worker checks the same)
export const LIVE_STATUSES = Object.freeze(['provisioning', 'active', 'suspended']);

const iso = (date) => (date == null ? null : new Date(date).toISOString());

// A host the worker will take: <3 to 30 characters>.<base domain>, or the admin host
export function certHostAllowed(config, host) {
  if (typeof host !== 'string') return false;
  if (host === config.adminHost) return true;
  return config.tenantBaseDomains.some((domain) => new RegExp(`^[a-z][a-z0-9-]{1,28}[a-z0-9]\\.${escapeRegex(domain)}$`).test(host));
}

// An archive path as the worker writes it: absolute, already normal, and exactly
// <backupDir>/<dbName>/<time>-<kind>.archive.gz
export function archiveAllowed(config, archive, dbName) {
  if (typeof archive !== 'string' || !path.isAbsolute(archive) || path.normalize(archive) !== archive) return false;
  const parts = path.relative(path.resolve(config.backupDir), archive).split(path.sep);
  return parts.length === 2 && parts[0] === dbName && ARCHIVE_NAME.test(parts[1]);
}

// A request exactly as parseRequest in the worker wants it: these fields, all strings
const REQUEST_FIELDS = Object.freeze({
  backup: ['type', 'tenantId', 'dbName', 'reason'],
  restore: ['type', 'tenantId', 'archive', 'fromDb', 'targetDb'],
  drop: ['type', 'tenantId', 'dbName', 'verifiedArchive'],
});

export function checkRequest(config, dbPattern, request) {
  const fields = REQUEST_FIELDS[request?.type];
  if (!fields) throw new Error(`Unknown worker job ${request?.type}`);
  const keys = Object.keys(request);
  if (keys.length !== fields.length || !fields.every((key) => typeof request[key] === 'string')) throw new Error(`A ${request.type} request needs exactly ${fields.join(', ')}`);
  if (!JOB_ID.test(request.tenantId)) throw new Error('Bad tenantId');
  const db = (name) => {
    if (!dbPattern.test(name)) throw new Error(`Refusing database name ${JSON.stringify(name)}`);
  };
  if (request.type === 'backup') {
    db(request.dbName);
    if (!BACKUP_REASONS.includes(request.reason)) throw new Error(`Bad backup reason ${request.reason}`);
  } else if (request.type === 'restore') {
    db(request.fromDb);
    db(request.targetDb);
    if (!archiveAllowed(config, request.archive, request.fromDb)) throw new Error('Bad archive path');
  } else {
    db(request.dbName);
    if (!archiveAllowed(config, request.verifiedArchive, request.dbName)) throw new Error('Bad archive path');
  }
  return request;
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

async function exists(file) {
  try {
    await fsp.lstat(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

// The state files, the same under SPOOL_DIR/state and under .pos-local/state
function stateReader(stateDir) {
  return {
    certState: (host) => readJson(path.join(stateDir, 'certs', `${host}.json`)),
    jobState: (ref) => (JOB_ID.test(ref) ? readJson(path.join(stateDir, 'jobs', `${ref}.json`)) : null),
    async backups(dbName) {
      const list = await readJson(path.join(stateDir, 'backups', `${dbName}.json`));
      return Array.isArray(list?.archives) ? list.archives : [];
    },
    monitor: () => readJson(path.join(stateDir, 'monitor.json')),
  };
}

/* The real worker, through SPOOL_DIR */

function spoolWorker(config, dbPattern) {
  const dir = (name) => path.join(config.spoolDir, name);
  const state = stateReader(dir('state'));

  // An empty file named after the host. Asking again (a failed certificate) moves its time
  // on, which the worker takes as a new request.
  async function emptyFile(file, again) {
    try {
      await (await fsp.open(file, 'wx', 0o640)).close();
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (again) {
        const now = new Date();
        await fsp.utimes(file, now, now);
      }
    }
  }

  return {
    mode: 'spool',
    ...state,
    async wantCert(host, { again = false } = {}) {
      if (!certHostAllowed(config, host)) throw new Error(`Not a host the worker takes: ${host}`);
      await emptyFile(path.join(dir('desired'), host), again);
    },
    async retireCert(host) {
      if (!certHostAllowed(config, host)) return;
      await emptyFile(path.join(dir('retire'), host), false);
    },
    async submit(ref, request) {
      if (!JOB_ID.test(ref)) throw new Error(`Bad job id ${ref}`);
      checkRequest(config, dbPattern, request);
      const file = path.join(dir('requests'), `${ref}.json`);
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(request), { mode: 0o640 });
      await fsp.rename(`${file}.tmp`, file);
    },
    // Still waiting in requests/ (the worker deletes it once it has written the job's state)
    requestPending: (ref) => exists(path.join(dir('requests'), `${ref}.json`)),
  };
}

/* The local stand-in: the same JSON, done here */

const stampOf = (date) => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

async function fileSha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

// Every document of an archive, in order: { c: collection, d: document }
async function* archiveLines(file) {
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield EJSON.parse(line, { relaxed: false });
}

/*
 * dbPattern: the shop database names (lib/db.js), db: the app's databases, for the driver,
 * the drop (db.dropTenantDb) and the check that no live shop uses a database being dropped.
 */
function localWorker(config, db, dbPattern) {
  const stateDir = path.join(config.localDir, 'state');
  const state = stateReader(stateDir);
  const client = () => db.base.getClient();
  const databaseNames = async () => (await client().db().admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
  const checkDb = (name) => {
    if (!dbPattern.test(name)) throw new Error(`Refusing database name ${JSON.stringify(name)}`);
    return name;
  };

  async function counts(dbName) {
    const database = client().db(checkDb(dbName));
    const result = {};
    for (const { name } of await database.listCollections({}, { nameOnly: true }).toArray()) {
      if (!name.startsWith('system.')) result[name] = await database.collection(name).countDocuments();
    }
    return result;
  }

  const sameCounts = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
    return true;
  };

  async function restoreInto(archive, toDb) {
    const target = client().db(checkDb(toDb));
    const batches = new Map();
    const flush = async (name) => {
      const docs = batches.get(name);
      if (docs?.length) await target.collection(name).insertMany(docs, { ordered: true });
      batches.set(name, []);
    };
    for await (const { c, d } of archiveLines(archive)) {
      if (typeof c !== 'string' || !c || c.startsWith('system.')) throw new Error('Unreadable archive');
      if (!batches.has(c)) batches.set(c, []);
      batches.get(c).push(d);
      if (batches.get(c).length >= 500) await flush(c);
    }
    for (const name of batches.keys()) await flush(name);
  }

  async function listArchives(dbName) {
    const folder = path.join(config.backupDir, dbName);
    let names = [];
    try {
      names = await fsp.readdir(folder);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const archives = [];
    for (const name of names) {
      const m = ARCHIVE_NAME.exec(name);
      const meta = m && (await readJson(path.join(folder, `${name}.meta.json`)));
      if (meta?.dbName !== dbName) continue;
      archives.push({ path: path.join(folder, name), bytes: meta.bytes, createdAt: meta.createdAt, kind: m[2], verified: true });
    }
    return archives.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // The archive and its sidecar, checked as the worker checks them before it drops or restores
  async function verifiedArchive(archive, dbName) {
    if (!archiveAllowed(config, archive, dbName)) throw new Error('مسار النسخة غير صالح');
    const meta = await readJson(`${archive}.meta.json`);
    if (!meta || meta.dbName !== dbName || meta.verify !== 'restore') throw new Error('لا توجد نسخة احتياطية مُتحقَّق منها بالاستعادة في المسار المطلوب');
    const st = await fsp.lstat(archive).catch(() => null);
    if (!st?.isFile()) throw new Error('ملف النسخة غير موجود');
    if (meta.sha256 !== (await fileSha256(archive))) throw new Error('تغيّر ملف النسخة بعد التحقق منه');
    return meta;
  }

  // A dump of every collection, then a full restore into a scratch database whose counts
  // must match: an archive that cannot be restored is never called a backup
  async function backup(dbName, kind) {
    checkDb(dbName);
    if (!(await databaseNames()).includes(dbName)) throw new Error('قاعدة بيانات المتجر غير موجودة');
    const folder = path.join(config.backupDir, dbName);
    await fsp.mkdir(folder, { recursive: true });
    let createdAt = new Date();
    let name = `${stampOf(createdAt)}-${kind}.archive.gz`;
    while (await exists(path.join(folder, name))) {
      createdAt = new Date(createdAt.getTime() + 1000);
      name = `${stampOf(createdAt)}-${kind}.archive.gz`;
    }
    const final = path.join(folder, name);
    const partial = path.join(folder, `.${name}.partial`);
    const database = client().db(dbName);
    const written = {};
    try {
      const gzip = createGzip();
      const done = pipeline(gzip, createWriteStream(partial, { mode: 0o600 }));
      done.catch(() => {}); // awaited below; a failure before then is thrown from there
      for (const { name: collection } of await database.listCollections({}, { nameOnly: true }).toArray()) {
        if (collection.startsWith('system.')) continue;
        written[collection] = 0;
        for await (const doc of database.collection(collection).find()) {
          if (!gzip.write(`${EJSON.stringify({ c: collection, d: doc }, { relaxed: false })}\n`)) await once(gzip, 'drain');
          written[collection] += 1;
        }
      }
      gzip.end();
      await done;
      const scratch = checkDb(`${config.tenantDbPrefix}${new mongoose.Types.ObjectId().toHexString()}`);
      try {
        await restoreInto(partial, scratch);
        if (!sameCounts(written, await counts(scratch))) throw new Error('أعداد السجلات بعد الاستعادة التجريبية لا تطابق النسخة');
      } finally {
        await client().db(scratch).dropDatabase();
      }
      const { size } = await fsp.stat(partial);
      const meta = { dbName, kind, createdAt: iso(createdAt), bytes: size, sha256: await fileSha256(partial), counts: written, verify: 'restore', verifiedAt: iso(new Date()) };
      await writeJsonAtomic(`${final}.meta.json`, meta);
      await fsp.rename(partial, final);
      await writeJsonAtomic(path.join(stateDir, 'backups', `${dbName}.json`), { dbName, archives: await listArchives(dbName) });
      return { archive: final, bytes: size, counts: written };
    } catch (err) {
      await fsp.rm(partial, { force: true });
      throw err;
    }
  }

  async function restore({ archive, fromDb, targetDb }) {
    const meta = await verifiedArchive(archive, fromDb);
    if ((await databaseNames()).includes(checkDb(targetDb))) throw new Error('قاعدة البيانات الهدف موجودة مسبقًا، والاستعادة لا تكتب فوق قاعدة موجودة');
    try {
      await restoreInto(archive, targetDb);
      const restored = await counts(targetDb);
      if (!sameCounts(meta.counts, restored)) throw new Error('أعداد السجلات بعد الاستعادة لا تطابق النسخة');
      return { targetDb, counts: restored };
    } catch (err) {
      await client().db(targetDb).dropDatabase().catch(() => {});
      throw err;
    }
  }

  async function drop({ dbName, verifiedArchive: archive }) {
    await verifiedArchive(archive, dbName);
    const user = await db.controlModels.Tenant.findOne({ dbName, status: { $in: LIVE_STATUSES } }, 'slug status').lean();
    if (user) throw new Error(`القاعدة ما زالت قاعدة المتجر ${user.slug} (${user.status})، فلن تُحذف`);
    await db.dropTenantDb(dbName);
    return { dropped: true };
  }

  const writeJob = (ref, fields) => writeJsonAtomic(path.join(stateDir, 'jobs', `${ref}.json`), { jobId: ref, ...fields, updatedAt: iso(new Date()) });

  return {
    mode: 'local',
    ...state,
    certState: async (host) => ({ host, status: 'issued', attempts: 0, nextAttemptAt: null, expiresAt: null, lastError: null, updatedAt: iso(new Date()) }),
    async wantCert(host) {
      if (!certHostAllowed(config, host)) throw new Error(`Not a host the worker takes: ${host}`);
    },
    async retireCert() {},
    // Done before it returns; the state file says how it went, as the worker's would
    async submit(ref, request) {
      if (!JOB_ID.test(ref)) throw new Error(`Bad job id ${ref}`);
      checkRequest(config, dbPattern, request);
      await writeJob(ref, { type: request.type, status: 'running', result: null, error: null });
      try {
        let result;
        if (request.type === 'backup') result = await backup(request.dbName, request.reason);
        else if (request.type === 'restore') result = await restore(request);
        else result = await drop(request);
        await writeJob(ref, { type: request.type, status: 'done', result, error: null });
      } catch (err) {
        await writeJob(ref, { type: request.type, status: 'failed', result: null, error: err.message });
      }
    },
    requestPending: async () => false,
    listArchives,
  };
}

export function createWorker(config, db) {
  const pattern = new RegExp(`^${escapeRegex(config.tenantDbPrefix)}[0-9a-f]{24}$`);
  return config.workerMode === 'spool' ? spoolWorker(config, pattern) : localWorker(config, db, pattern);
}

// For the tests: the local stand-in's work, to play the root worker's part on a spool
export const localWorkerFor = (config, db) => localWorker(config, db, new RegExp(`^${escapeRegex(config.tenantDbPrefix)}[0-9a-f]{24}$`));
