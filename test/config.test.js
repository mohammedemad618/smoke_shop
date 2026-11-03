// The settings read from the environment (lib/config.js): the defaults for development and
// production, and what makes the app refuse to start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, publicUrl } from '../lib/config.js';

// What production needs besides NODE_ENV: the TOTP key and the root worker's spool
const KEY = 'f0'.repeat(32);
const PROD = { NODE_ENV: 'production', TOTP_KEY: KEY, SPOOL_DIR: '/var/lib/pos-spool' };

test('development defaults: shops on *.pos.localhost, listening on 127.0.0.1', () => {
  const config = loadConfig({});
  const { maxNewTenantsPerDay, totpKey, spoolDir, workerMode, backupDir, localDir, publicIpv4, requestLog, ...rest } = config;
  assert.deepStrictEqual({ ...rest, tenantBaseDomains: [...config.tenantBaseDomains] }, {
    production: false,
    host: '127.0.0.1',
    port: 3000,
    mongodbUri: 'mongodb://127.0.0.1:27017',
    controlDb: 'pos_control',
    tenantDbPrefix: 'pos_t_',
    tenantBaseDomains: ['pos.localhost'],
    adminHost: 'admin.pos.localhost',
    publicScheme: 'http',
    maxTenants: 20,
  });
  // No root worker in development: certificates and backups are done in-process, under .pos-local
  assert.deepStrictEqual([maxNewTenantsPerDay, totpKey, spoolDir, workerMode, publicIpv4, requestLog], [5, null, null, 'local', null, false]);
  assert.ok(localDir.endsWith('.pos-local'), localDir);
  assert.strictEqual(backupDir, path.join(localDir, 'backups'));
  assert.strictEqual(publicUrl(config, 'amal.pos.localhost'), 'http://amal.pos.localhost:3000');
});

test('production defaults: shops on *.pos.108-61-190-4.sslip.io over https', () => {
  const config = loadConfig(PROD);
  assert.deepStrictEqual([...config.tenantBaseDomains], ['pos.108-61-190-4.sslip.io']);
  assert.strictEqual(config.adminHost, 'admin.pos.108-61-190-4.sslip.io');
  assert.strictEqual(config.publicScheme, 'https');
  assert.strictEqual(publicUrl(config, 'amal.pos.108-61-190-4.sslip.io'), 'https://amal.pos.108-61-190-4.sslip.io');
  assert.deepStrictEqual([config.workerMode, config.backupDir, config.publicIpv4, config.requestLog], ['spool', '/var/backups/pos', '108.61.190.4', true]);
  assert.deepStrictEqual(config.totpKey, Buffer.from(KEY, 'hex'));
});

test('production refuses to listen on anything but loopback', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5', '108.61.190.4', 'localhost']) {
    assert.throws(() => loadConfig({ ...PROD, HOST: host }), /loopback/, host);
  }
  for (const host of ['127.0.0.1', '127.0.0.2', '::1']) assert.strictEqual(loadConfig({ ...PROD, HOST: host }).host, host);
  // In development another address is allowed (a phone on the same network)
  assert.strictEqual(loadConfig({ HOST: '0.0.0.0' }).host, '0.0.0.0');
});

test('MONGODB_URI gives the server only, never a database', () => {
  for (const uri of ['mongodb://127.0.0.1:27017/salim_pos', 'mongodb://127.0.0.1:27017/pos_control?retryWrites=true', 'mongodb+srv://cluster.example.com/shop']) {
    assert.throws(() => loadConfig({ MONGODB_URI: uri }), /names the database/, uri);
  }
  for (const uri of ['mongodb://127.0.0.1:27017', 'mongodb://127.0.0.1:27017/', 'mongodb://a:1,b:2/?replicaSet=rs', 'mongodb://u:p%2Fx@127.0.0.1/?authSource=admin']) {
    assert.strictEqual(loadConfig({ MONGODB_URI: uri }).mongodbUri, uri);
  }
});

test('database names always start with pos_', () => {
  assert.throws(() => loadConfig({ CONTROL_DB: 'salim_pos' }), /CONTROL_DB/);
  assert.throws(() => loadConfig({ CONTROL_DB: 'pos_Control' }), /CONTROL_DB/);
  assert.throws(() => loadConfig({ TENANT_DB_PREFIX: 'salim_' }), /TENANT_DB_PREFIX/);
  assert.throws(() => loadConfig({ TENANT_DB_PREFIX: 'pos_t' }), /TENANT_DB_PREFIX/);
  assert.throws(() => loadConfig({ CONTROL_DB: 'pos_t_control' }), /must not start/);
});

test('host names and limits are checked', () => {
  assert.deepStrictEqual([...loadConfig({ TENANT_BASE_DOMAINS: 'pos.localhost, POS.Example.com' }).tenantBaseDomains], ['pos.localhost', 'pos.example.com']);
  assert.throws(() => loadConfig({ TENANT_BASE_DOMAINS: 'bad_domain.com' }), /TENANT_BASE_DOMAINS/);
  assert.throws(() => loadConfig({ ADMIN_HOST: 'pos.localhost' }), /ADMIN_HOST/);
  assert.throws(() => loadConfig({ PUBLIC_SCHEME: 'ftp' }), /PUBLIC_SCHEME/);
  // Sign-in cookies are Secure and __Host- over https; plain http is for development only
  assert.throws(() => loadConfig({ ...PROD, PUBLIC_SCHEME: 'http' }), /PUBLIC_SCHEME must be https/);
  assert.strictEqual(loadConfig({ PUBLIC_SCHEME: 'https' }).publicScheme, 'https');
  for (const value of ['0', '-1', '2.5', 'many']) assert.throws(() => loadConfig({ MAX_TENANTS: value }), /MAX_TENANTS/, value);
  for (const value of ['0', '-3', '1.5', 'x']) assert.throws(() => loadConfig({ MAX_NEW_TENANTS_PER_DAY: value }), /MAX_NEW_TENANTS_PER_DAY/, value);
  assert.strictEqual(loadConfig({ MAX_NEW_TENANTS_PER_DAY: '2' }).maxNewTenantsPerDay, 2);
  assert.throws(() => loadConfig({ PUBLIC_IPV4: '1.2.3' }), /PUBLIC_IPV4/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
});

test('the admin panel and the root worker: what production refuses', () => {
  // Without the key no admin can sign in; without the spool no certificate is ever issued
  assert.throws(() => loadConfig({ ...PROD, TOTP_KEY: undefined }), /TOTP_KEY is not set/);
  assert.throws(() => loadConfig({ ...PROD, SPOOL_DIR: undefined }), /SPOOL_DIR must be set/);
  assert.throws(() => loadConfig({ ...PROD, DEV_FAKE_CERTS: '1' }), /DEV_FAKE_CERTS/);
  for (const key of ['abc', 'g'.repeat(64), 'a'.repeat(63)]) assert.throws(() => loadConfig({ TOTP_KEY: key }), /64 hex/, key);
  // Development: the spool when asked for, the local stand-in when DEV_FAKE_CERTS=1
  assert.strictEqual(loadConfig({ SPOOL_DIR: '/tmp/spool' }).workerMode, 'spool');
  assert.strictEqual(loadConfig({ SPOOL_DIR: '/tmp/spool', DEV_FAKE_CERTS: '1' }).workerMode, 'local');
  assert.strictEqual(loadConfig({ SPOOL_DIR: '/tmp/spool', POS_BACKUP_DIR: '/tmp/b' }).backupDir, '/tmp/b');
  assert.strictEqual(loadConfig({ REQUEST_LOG: '1' }).requestLog, true);
});
