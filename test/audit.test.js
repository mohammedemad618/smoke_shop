// The audit log (control/models/AuditLog.js) and what services/tenants.js writes to it: the
// chain stays one line when several writers add entries at once, even when the newest entry
// by time and id is not the end of the chain (two processes in the same millisecond); a
// status change whose entry cannot be written is undone, an activation included; and a
// shop's creation is logged once, also when the run that made it stopped before logging it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createTenant, transition } from '../services/tenants.js';
import { auditHash } from '../control/models/AuditLog.js';
import { startTestEnv } from './support/harness.js';

const GENESIS = '0'.repeat(64);

let env;
let control;
before(async () => {
  env = await startTestEnv();
  control = env.db.controlModels;
});
after(async () => {
  await env?.close();
});

// Follows the chain from its start, checking each hash; every entry must be on it
async function walkChain() {
  const entries = await control.AuditLog.find().lean();
  const byPrev = new Map(entries.map((e) => [e.prevHash, e]));
  const line = [];
  for (let prev = GENESIS; byPrev.has(prev); prev = line.at(-1).hash) {
    const entry = byPrev.get(prev);
    assert.strictEqual(entry.hash, auditHash(entry.prevHash, entry));
    line.push(entry);
  }
  assert.strictEqual(line.length, entries.length, 'every entry is on one line from the start');
  return line;
}

// record() fails for the entries `when` picks until the returned function puts it back
function breakRecord(when) {
  const { AuditLog } = control;
  const record = AuditLog.record;
  AuditLog.record = function brokenRecord(entry) {
    return when(entry) ? Promise.reject(new Error('audit log unavailable')) : record.call(this, entry);
  };
  return () => {
    AuditLog.record = record;
  };
}

test('an entry goes after the true end of the chain when the newest by time and id is not it', async () => {
  const { AuditLog } = control;
  await AuditLog.record({ actor: 'test', action: 'first' });
  // What two processes writing in the same millisecond can leave: the later entry of the
  // chain has the smaller ObjectId (each process has its own random part)
  const end = (await walkChain()).at(-1);
  const at = new Date();
  const e1 = { at, actor: 'p1', ip: null, action: 'same-ms', details: {}, result: 'ok' };
  const e2 = { ...e1, actor: 'p2' };
  const h1 = auditHash(end.hash, e1);
  const h2 = auditHash(h1, e2);
  await AuditLog.collection.insertOne({ _id: new mongoose.Types.ObjectId('f'.repeat(24)), ...e1, prevHash: end.hash, hash: h1 });
  await AuditLog.collection.insertOne({ _id: new mongoose.Types.ObjectId(`${'0'.repeat(23)}1`), ...e2, prevHash: h1, hash: h2 });
  assert.strictEqual((await AuditLog.findOne().sort({ at: -1, _id: -1 }).lean()).actor, 'p1', 'the newest by time and id is p1, not the end');

  const entry = await AuditLog.record({ actor: 'test', action: 'after' });
  assert.strictEqual(entry.prevHash, h2);
  assert.deepStrictEqual((await walkChain()).slice(-3).map((e) => e.actor), ['p1', 'p2', 'test']);
  // And a shop can still be created, with its entries
  const { tenant } = await createTenant(env.ctx, { slug: 'after-same-ms', shopName: 'بعد' }, { actor: 'test' });
  assert.strictEqual(tenant.status, 'active');
  assert.strictEqual(await AuditLog.countDocuments({ tenantId: tenant._id }), 2);
});

test('three writers at once: every entry is written, all on one line', async () => {
  const { AuditLog } = control;
  const before = await AuditLog.countDocuments();
  const writer = async (actor) => {
    for (let i = 0; i < 40; i++) await AuditLog.record({ actor, action: 'race' });
  };
  await Promise.all(['w1', 'w2', 'w3'].map(writer));
  assert.strictEqual(await AuditLog.countDocuments(), before + 120);
  await walkChain();
});

test('a status change whose audit entry cannot be written is undone', async () => {
  const { Tenant, AuditLog } = control;
  const { tenant, client } = await env.createShop('undone');
  const restore = breakRecord((entry) => entry.action === 'tenant.status');
  try {
    await assert.rejects(transition(env.ctx, tenant._id, 'active', 'suspended', { actor: 'admin', reason: 'تجربة' }), /audit log unavailable/);
  } finally {
    restore();
  }
  const now = await Tenant.findById(tenant._id).lean();
  assert.deepStrictEqual([now.status, now.statusReason, now.statusChangedBy], ['active', '', 'test']);
  assert.ok(now.rev > tenant.rev, 'put back with a new rev, so the registries that poll see it');
  await env.registry.poll();
  assert.strictEqual((await client.request('GET', '/api/shop')).status, 200);
  const suspensions = { tenantId: tenant._id, action: 'tenant.status', 'details.to': 'suspended' };
  assert.strictEqual(await AuditLog.countDocuments(suspensions), 0);

  // Once the log works, the same change is made and logged
  await transition(env.ctx, tenant._id, 'active', 'suspended', { actor: 'admin' });
  assert.strictEqual((await client.request('GET', '/api/shop')).status, 423);
  assert.strictEqual(await AuditLog.countDocuments(suspensions), 1);
});

test('an activation that cannot be logged fails the creation; running it again finishes it, logged', async () => {
  const { Tenant, Job, AuditLog } = control;
  const input = { slug: 'unlogged', shopName: 'بلا سجل' };
  const restore = breakRecord((entry) => entry.action === 'tenant.status');
  try {
    await assert.rejects(createTenant(env.ctx, input, { actor: 'test' }), /audit log unavailable/);
  } finally {
    restore();
  }
  const left = await Tenant.findOne({ slug: 'unlogged' }).lean();
  assert.strictEqual(left.status, 'provisioning');
  const job = await Job.findOne({ tenantId: left._id }).lean();
  assert.deepStrictEqual([job.status, job.steps.at(-1).key, job.steps.at(-1).status], ['failed', 'activate', 'failed']);

  const { tenant } = await createTenant(env.ctx, input, { actor: 'test' });
  assert.strictEqual(tenant.status, 'active');
  const entries = await AuditLog.find({ tenantId: tenant._id }).sort({ at: 1, _id: 1 }).lean();
  assert.deepStrictEqual(entries.map((e) => [e.action, e.result, e.details.step ?? e.details.to ?? null]), [
    ['tenant.create', 'ok', null],
    ['tenant.create', 'failed', 'activate'],
    ['tenant.status', 'ok', 'active'],
  ]);
});

test("a shop's creation is logged once, also when the run that made it stopped before logging it", async () => {
  const { Tenant, AuditLog } = control;
  const input = { slug: 'relogged', shopName: 'سجل لاحق' };
  const restore = breakRecord((entry) => entry.action === 'tenant.create' && (entry.result ?? 'ok') === 'ok');
  try {
    await assert.rejects(createTenant(env.ctx, input, { actor: 'cli' }), /audit log unavailable/);
  } finally {
    restore();
  }
  const left = await Tenant.findOne({ slug: 'relogged' }).lean();
  assert.strictEqual(left.status, 'provisioning');
  assert.strictEqual(await AuditLog.countDocuments({ tenantId: left._id }), 0);

  // Two runs at the same moment finish it: one entry for its creation, one for its activation
  const runs = await Promise.all([createTenant(env.ctx, input, { actor: 'cli' }), createTenant(env.ctx, input, { actor: 'cli' })]);
  assert.deepStrictEqual(runs.map((r) => r.tenant.status), ['active', 'active']);
  const entries = await AuditLog.find({ tenantId: left._id }).lean();
  assert.deepStrictEqual(entries.map((e) => `${e.action} ${e.result}`).sort(), ['tenant.create ok', 'tenant.status ok']);
  const created = entries.find((e) => e.action === 'tenant.create');
  assert.deepStrictEqual([created.actor, created.details], ['cli', { label: 'سجل لاحق', dbName: left.dbName }]);
  await walkChain();
});
