#!/usr/bin/env node
// pos-monitor: the POS health checks, every 5 minutes (pos-monitor.timer), installed by hand
// as /usr/local/sbin/pos-monitor.mjs. Standalone like the root worker: Node's own modules only.
//
// Checks: memory available (< 300 MB), disk use (> 80 %), mongod and pos.service running,
// the app's /healthz, certificates ending within 14 days, certificates the worker gave up
// on, the last nightly backup (> 26 hours) and restore drill, the worker's last good run
// (> 10 minutes), failed jobs of the last day, backup files readable by anyone but root,
// and the app's 5xx answers of the last 5 minutes (from the journal).
//
// Results go to SPOOL_DIR/state/monitor.json (read by the admin panel, messages in Arabic)
// and problems to the journal (English, priority err or warning), each one when it starts,
// then at most once an hour while it lasts, and once more when it is over.
import { execFile } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function loadConfig(env = process.env) {
  const spoolDir = path.resolve(env.SPOOL_DIR || '/var/lib/pos-spool');
  return {
    stateDir: path.join(spoolDir, 'state'),
    workDir: path.resolve(env.POS_WORKER_DIR || '/var/lib/pos-root-worker'),
    backupDir: path.resolve(env.POS_BACKUP_DIR || '/var/backups/pos'),
    nginxCertDir: path.resolve(env.POS_NGINX_CERT_DIR || '/etc/nginx/pos-certs'),
    disks: (env.POS_MONITOR_DISKS || '/,/var/lib/mongodb,/var/backups/pos').split(',').filter(Boolean),
    appPort: Number(env.POS_APP_PORT || 3401),
    thresholds: {
      memAvailableMB: 300,
      diskPercent: 80,
      certDays: 14,
      nightlyHours: 26,
      drillDays: 8,
      workerMinutes: 10,
      errors5xxWarn: 1,
      errors5xxError: 10,
    },
    now: () => new Date(),
  };
}

const iso = (date) => (date == null ? null : new Date(date).toISOString());

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fsp.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.chmod(0o644);
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

function exec(file, args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? '') }));
  });
}

// "MemAvailable:  812345 kB" -> 793 (MB)
export function parseMeminfo(text) {
  const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? NaN);
  return { memAvailableMB: Math.round(kb('MemAvailable') / 1024), swapUsedMB: Math.round((kb('SwapTotal') - kb('SwapFree')) / 1024) };
}

// The app logs one JSON line per request ({tenant, reqId, route, status, ms}): count the 5xx
export function count5xx(journalText) {
  let count = 0;
  for (const line of journalText.split('\n')) {
    if (/"status"\s*:\s*5\d\d\b/.test(line)) count += 1;
  }
  return count;
}

function healthz(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { Host: 'localhost' }, timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

async function diskUse(dir) {
  try {
    const s = await fsp.statfs(dir);
    const used = s.blocks - s.bfree;
    // Like df: what is used against what a non-root user could have
    return Math.round((used / (used + s.bavail)) * 100);
  } catch {
    return null;
  }
}

async function installedCerts(config) {
  const certs = [];
  for (const name of await fsp.readdir(config.nginxCertDir).catch(() => [])) {
    if (name.startsWith('.') || name === 'none') continue;
    try {
      const pem = await fsp.readFile(path.join(config.nginxCertDir, name, 'fullchain.pem'), 'utf8');
      const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
      const cert = new X509Certificate(first);
      const validTo = cert.validToDate ?? new Date(cert.validTo);
      certs.push({ host: name, expiresAt: iso(validTo), days: Math.floor((validTo - Date.now()) / DAY) });
    } catch {
      certs.push({ host: name, expiresAt: null, days: null });
    }
  }
  return certs;
}

async function stateFiles(dir) {
  const out = [];
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const data = await readJson(path.join(dir, name));
    if (data) out.push(data);
  }
  return out;
}

// Files under the backup folder that group or others can read (find -perm /077)
async function looseBackupFiles(dir, depth = 0) {
  const found = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    const st = await fsp.lstat(file).catch(() => null);
    if (!st || st.isSymbolicLink()) continue;
    if (st.mode & 0o077) found.push(file);
    if (st.isDirectory() && depth < 3) found.push(...(await looseBackupFiles(file, depth + 1)));
  }
  return found;
}

export async function collect(config) {
  const now = config.now();
  const metrics = {};
  try {
    Object.assign(metrics, parseMeminfo(readFileSync('/proc/meminfo', 'utf8')));
  } catch {
    metrics.memAvailableMB = null;
  }
  metrics.disks = [];
  for (const dir of config.disks) metrics.disks.push({ path: dir, usedPercent: await diskUse(dir) });
  metrics.mongod = (await exec('systemctl', ['is-active', 'mongod'])).stdout.trim() || 'unknown';
  metrics.app = (await exec('systemctl', ['is-active', 'pos'])).stdout.trim() || 'unknown';
  metrics.healthz = await healthz(config.appPort);
  metrics.certs = await installedCerts(config);
  metrics.certStates = (await stateFiles(path.join(config.stateDir, 'certs'))).map((s) => ({ host: s.host, status: s.status, lastError: s.lastError ?? null }));
  const since = now - DAY;
  metrics.failedJobs = (await stateFiles(path.join(config.stateDir, 'jobs')))
    .filter((j) => j.status === 'failed' && Date.parse(j.updatedAt) > since)
    .map((j) => ({ jobId: j.jobId, type: j.type, error: j.error, updatedAt: j.updatedAt }));
  const nightly = await readJson(path.join(config.workDir, 'nightly.json'));
  metrics.lastNightlyAt = nightly?.lastSuccessAt ?? null;
  metrics.lastNightlyErrors = nightly && !nightly.ok ? nightly.errors ?? [] : [];
  const drill = await readJson(path.join(config.workDir, 'drill.json'));
  metrics.lastDrill = drill?.last ? { at: drill.last.at, dbName: drill.last.dbName, ok: drill.last.ok, error: drill.last.error ?? null } : null;
  const worker = await readJson(path.join(config.workDir, 'worker.json'));
  metrics.workerLastOkAt = worker?.lastOkAt ?? null;
  metrics.workerLastErrors = worker?.lastErrors ?? [];
  metrics.looseBackupFiles = (await looseBackupFiles(config.backupDir)).slice(0, 20);
  const journal = await exec('journalctl', ['-u', 'pos.service', '--since', '-5min', '--no-pager', '-o', 'cat', '-q']);
  metrics.errors5xx = journal.ok ? count5xx(journal.stdout) : null;
  // Shops exist once a shop database has been backed up at least once
  metrics.hasShops = (await fsp.readdir(config.backupDir).catch(() => [])).some((n) => /^pos_t_[0-9a-f]{24}$/.test(n));
  return metrics;
}

// [{ key, level: 'error' | 'warn', message (Arabic, for the panel), log (English, for the journal) }]
export function evaluate(metrics, config) {
  const t = config.thresholds;
  const now = config.now();
  const problems = [];
  const add = (key, level, message, log) => problems.push({ key, level, message, log });

  if (metrics.memAvailableMB !== null && metrics.memAvailableMB < t.memAvailableMB) {
    add('memory', 'error', `الذاكرة المتاحة ${metrics.memAvailableMB} MB، أقل من ${t.memAvailableMB} MB`, `MemAvailable ${metrics.memAvailableMB} MB < ${t.memAvailableMB} MB`);
  }
  for (const disk of metrics.disks) {
    if (disk.usedPercent !== null && disk.usedPercent > t.diskPercent) {
      add(`disk:${disk.path}`, 'error', `القرص ممتلئ بنسبة ${disk.usedPercent}% في ${disk.path}`, `disk ${disk.path} ${disk.usedPercent}% used`);
    }
  }
  if (metrics.mongod !== 'active') add('mongod', 'error', `خدمة MongoDB لا تعمل (${metrics.mongod})`, `mongod is ${metrics.mongod}`);
  if (metrics.app !== 'active') add('app', 'error', `خدمة نقطة البيع لا تعمل (${metrics.app})`, `pos.service is ${metrics.app}`);
  else if (metrics.healthz !== 200) add('healthz', 'error', `التطبيق لا يجيب على /healthz (${metrics.healthz ?? 'لا اتصال'})`, `/healthz answered ${metrics.healthz ?? 'nothing'}`);

  for (const cert of metrics.certs) {
    if (cert.days === null) add(`cert:${cert.host}`, 'error', `تعذّرت قراءة شهادة ${cert.host}`, `cannot read the certificate of ${cert.host}`);
    else if (cert.days < t.certDays) add(`cert:${cert.host}`, 'error', `شهادة ${cert.host} تنتهي خلال ${cert.days} يومًا`, `certificate of ${cert.host} ends in ${cert.days} days`);
  }
  for (const state of metrics.certStates) {
    if (state.status === 'failed') add(`certfail:${state.host}`, 'warn', `تعذّر إصدار شهادة ${state.host}: ${state.lastError ?? ''}`, `certificate of ${state.host} failed: ${state.lastError ?? ''}`);
  }

  const nightlyAge = metrics.lastNightlyAt ? (now - Date.parse(metrics.lastNightlyAt)) / HOUR : null;
  if (nightlyAge === null) add('nightly', 'warn', 'لم تكتمل أي نسخة احتياطية ليلية بعد', 'no nightly backup has completed yet');
  else if (nightlyAge > t.nightlyHours) add('nightly', 'error', `آخر نسخة احتياطية ليلية قبل ${Math.round(nightlyAge)} ساعة`, `last nightly backup ${Math.round(nightlyAge)} hours ago`);
  if (metrics.lastNightlyErrors.length) add('nightly-errors', 'error', `أخطاء في النسخ الليلي: ${metrics.lastNightlyErrors.slice(0, 3).join('؛ ')}`, `nightly errors: ${metrics.lastNightlyErrors.slice(0, 3).join('; ')}`);
  if (metrics.lastDrill && !metrics.lastDrill.ok) add('drill', 'error', `فشل تمرين الاستعادة الأسبوعي لـ ${metrics.lastDrill.dbName}: ${metrics.lastDrill.error}`, `restore drill of ${metrics.lastDrill.dbName} failed`);
  else if (metrics.hasShops && metrics.lastNightlyAt && (!metrics.lastDrill || now - Date.parse(metrics.lastDrill.at) > t.drillDays * DAY)) {
    add('drill', 'warn', 'لم يُجرَ تمرين استعادة منذ أكثر من أسبوع', 'no restore drill for over a week');
  }

  const workerAge = metrics.workerLastOkAt ? (now - Date.parse(metrics.workerLastOkAt)) / MINUTE : null;
  if (workerAge === null || workerAge > t.workerMinutes) {
    const detail = metrics.workerLastErrors.slice(0, 2).join('؛ ');
    add('worker', 'error', `عامل الشهادات والنسخ لم ينجح منذ ${workerAge === null ? 'البداية' : `${Math.round(workerAge)} دقيقة`}${detail ? `: ${detail}` : ''}`, `root worker: no good run for ${workerAge === null ? 'ever' : `${Math.round(workerAge)} minutes`}`);
  }
  if (metrics.failedJobs.length) add('jobs', 'warn', `${metrics.failedJobs.length} مهمة فشلت خلال آخر يوم`, `${metrics.failedJobs.length} jobs failed in the last day`);
  if (metrics.looseBackupFiles.length) add('backup-perms', 'error', `ملفات نسخ احتياطية يقرؤها غير root: ${metrics.looseBackupFiles.slice(0, 3).join('، ')}`, `backup files readable beyond root: ${metrics.looseBackupFiles.slice(0, 3).join(', ')}`);
  if (metrics.errors5xx !== null && metrics.errors5xx >= t.errors5xxWarn) {
    const level = metrics.errors5xx >= t.errors5xxError ? 'error' : 'warn';
    add('5xx', level, `${metrics.errors5xx} خطأ 5xx من التطبيق خلال آخر 5 دقائق`, `${metrics.errors5xx} 5xx answers in the last 5 minutes`);
  }
  return problems;
}

// Each problem logged when it starts, again each hour while it lasts, and once when it ends;
// `since` and `loggedAt` survive from the previous monitor.json
export function mergeProblems(problems, previous, now, log) {
  const before = new Map((previous?.problems ?? []).map((p) => [p.key, p]));
  const merged = problems.map((p) => {
    const old = before.get(p.key);
    const since = old?.since ?? iso(now);
    let loggedAt = old?.loggedAt ?? null;
    if (!loggedAt || now - Date.parse(loggedAt) >= HOUR || old.level !== p.level) {
      log(p.level, `pos-monitor: ${p.log}`);
      loggedAt = iso(now);
    }
    return { key: p.key, level: p.level, message: p.message, since, loggedAt };
  });
  for (const [key] of before) {
    if (!problems.some((p) => p.key === key)) log('info', `pos-monitor: resolved: ${key}`);
  }
  return merged;
}

function journalLog(level, message) {
  const priority = { error: 3, warn: 4, info: 6 }[level] ?? 6;
  process.stderr.write(process.env.JOURNAL_STREAM ? `<${priority}>${message}\n` : `${level.toUpperCase()} ${message}\n`);
}

export async function runMonitor(config, log = journalLog) {
  const now = config.now();
  const metrics = await collect(config);
  const file = path.join(config.stateDir, 'monitor.json');
  const problems = mergeProblems(evaluate(metrics, config), await readJson(file), now, log);
  const report = { checkedAt: iso(now), ok: !problems.some((p) => p.level === 'error'), problems, metrics };
  await writeJsonAtomic(file, report);
  return report;
}

const isMain = import.meta.main ?? (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url);
if (isMain) {
  runMonitor(loadConfig()).then(
    (report) => {
      if (!process.env.JOURNAL_STREAM) process.stdout.write(`${JSON.stringify({ ok: report.ok, problems: report.problems.map((p) => p.key) })}\n`);
      process.exit(0);
    },
    (err) => {
      process.stderr.write(`${err.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
