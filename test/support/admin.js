// What the admin panel's tests share: an admin made as scripts/create-admin.js makes one, a
// browser on the admin host signed in with a code computed here, and a stand-in for the root
// worker that answers the spool as ops/sbin/pos-root-worker.mjs would.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAdmin, enableTotp } from '../../services/admins.js';
import { base32Decode, counterAt, hotp, totp } from '../../lib/totp.js';
import { localWorkerFor } from '../../lib/worker.js';
import { BASE_DOMAIN } from './harness.js';

export const ADMIN_PASSWORD = 'Seven quiet harbours 42';

// An admin with its authenticator enrolled (enable false: never finished); secret is the raw key
export async function makeAdmin(env, username, { enable = true, password = ADMIN_PASSWORD } = {}) {
  const made = await createAdmin(env.ctx, { username, password }, { actor: 'test' });
  const secret = base32Decode(made.secret);
  if (enable) assert.ok(await enableTotp(env.ctx, made.admin._id, totp(secret)));
  return { ...made, id: made.admin._id, username, password, secret };
}

// A code of a step the admin has not used yet, within the one-step window. Every code works
// once, and the window holds three steps: past those, the test moves lastCounter back itself.
export async function nextCode(env, admin) {
  const { Admin } = env.db.controlModels;
  const doc = await Admin.findById(admin.id).lean();
  // Never the step before now: a step boundary passing before the server checks it would
  // take it out of the window
  const now = counterAt(Date.now());
  let counter = Math.max(now, (doc.totp.lastCounter ?? -1) + 1);
  if (counter > now + 1) {
    await Admin.updateOne({ _id: admin.id }, { $set: { 'totp.lastCounter': now - 1 } });
    counter = now;
  }
  return hotp(admin.secret, counter);
}

// A browser on the admin host, from its own address (X-Forwarded-For, trusted from loopback)
export function adminClient(env, ip = '10.0.0.1') {
  const client = env.client(`admin.${BASE_DOMAIN}:${env.app.port}`);
  const send = client.request;
  client.request = (method, url, body, headers = {}) => send(method, url, body, { 'x-forwarded-for': ip, ...headers });
  client.api = (method, url, body, headers) => client.request(method, `/api/admin${url}`, body, headers);
  return client;
}

export async function signInAdmin(env, admin, ip) {
  const client = adminClient(env, ip);
  const login = await client.api('POST', '/auth/login', { username: admin.username, password: admin.password });
  assert.strictEqual(login.status, 200, login.text);
  const code = await client.api('POST', '/auth/code', { code: await nextCode(env, admin) });
  assert.strictEqual(code.status, 200, code.text);
  assert.strictEqual(code.data.stage, 'full');
  return client;
}

// Polls a job through the API until it leaves queued/running, running the runner meanwhile
export async function waitForJob(env, client, jobId, { tick = async () => {}, timeoutMs = 20000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await tick();
    await env.runner.drain();
    const res = await client.api('GET', `/jobs/${jobId}`);
    if (!['queued', 'running'].includes(res.data.status)) return res.data;
    if (Date.now() > until) throw new Error(`Job ${jobId} still ${res.data.status}: ${JSON.stringify(res.data.steps)}`);
    await sleep(60);
  }
}

/*
 * The root worker's part, played on a spool folder: certificates for desired/<host> (issued,
 * or failed for the hosts in failHosts), retire/<host> done at once, and every request in
 * requests/ done by the local stand-in (the same backups, restores and drops, the same state
 * files). tick() runs one pass, like one run of pos-root-worker.timer.
 */
export function fakeRootWorker(env, { spoolDir, backupDir }) {
  const local = localWorkerFor({ ...env.config, localDir: spoolDir, backupDir }, env.db);
  const failHosts = new Set();
  const dir = (name) => path.join(spoolDir, name);
  const write = async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(data));
    await fs.rename(`${file}.tmp`, file);
  };
  const list = async (name) => fs.readdir(dir(name)).catch(() => []);

  async function tick() {
    for (const host of await list('retire')) {
      await write(path.join(dir('state'), 'certs', `${host}.json`), { host, status: 'retired', attempts: 0, nextAttemptAt: null, expiresAt: null, lastError: null, updatedAt: new Date().toISOString() });
      await fs.rm(path.join(dir('desired'), host), { force: true });
      await fs.rm(path.join(dir('retire'), host), { force: true });
    }
    for (const host of await list('desired')) {
      const file = path.join(dir('state'), 'certs', `${host}.json`);
      const previous = JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null'));
      const { mtimeMs } = await fs.stat(path.join(dir('desired'), host));
      // A failed host stays failed until desired/<host> is touched again, as the worker does
      if (previous?.status === 'failed' && mtimeMs <= Date.parse(previous.updatedAt)) continue;
      const updatedAt = new Date().toISOString();
      if (failHosts.delete(host)) {
        await write(file, { host, status: 'failed', attempts: 6, nextAttemptAt: null, expiresAt: null, lastError: 'DNS problem: NXDOMAIN looking up A', updatedAt });
      } else if (previous?.status !== 'issued') {
        await write(file, { host, status: 'issued', attempts: 1, nextAttemptAt: null, expiresAt: new Date(Date.now() + 90 * 864e5).toISOString(), lastError: null, updatedAt });
      }
    }
    for (const name of await list('requests')) {
      if (!/^[0-9a-f]{24}\.json$/.test(name)) continue;
      const request = JSON.parse(await fs.readFile(path.join(dir('requests'), name), 'utf8'));
      await local.submit(name.slice(0, 24), request);
      await fs.rm(path.join(dir('requests'), name), { force: true });
    }
  }

  return { tick, failHosts, local };
}
