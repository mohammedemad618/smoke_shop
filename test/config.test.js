// The settings read from the environment (lib/config.js): the defaults for development and
// production, and what makes the app refuse to start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicUrl } from '../lib/config.js';

test('development defaults: shops on *.pos.localhost, listening on 127.0.0.1', () => {
  const config = loadConfig({});
  assert.deepStrictEqual({ ...config, tenantBaseDomains: [...config.tenantBaseDomains] }, {
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
  assert.strictEqual(publicUrl(config, 'amal.pos.localhost'), 'http://amal.pos.localhost:3000');
});

test('production defaults: shops on *.pos.108-61-190-4.sslip.io over https', () => {
  const config = loadConfig({ NODE_ENV: 'production' });
  assert.deepStrictEqual([...config.tenantBaseDomains], ['pos.108-61-190-4.sslip.io']);
  assert.strictEqual(config.adminHost, 'admin.pos.108-61-190-4.sslip.io');
  assert.strictEqual(config.publicScheme, 'https');
  assert.strictEqual(publicUrl(config, 'amal.pos.108-61-190-4.sslip.io'), 'https://amal.pos.108-61-190-4.sslip.io');
});

test('production refuses to listen on anything but loopback', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5', '108.61.190.4', 'localhost']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', HOST: host }), /loopback/, host);
  }
  for (const host of ['127.0.0.1', '127.0.0.2', '::1']) assert.strictEqual(loadConfig({ NODE_ENV: 'production', HOST: host }).host, host);
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
  for (const value of ['0', '-1', '2.5', 'many']) assert.throws(() => loadConfig({ MAX_TENANTS: value }), /MAX_TENANTS/, value);
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
});
