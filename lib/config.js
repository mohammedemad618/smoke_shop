// Settings from the environment (.env in development, /etc/pos/pos.env on the server).
// loadConfig() reads them once and refuses anything unsafe, so the app never starts half
// configured; it is a plain function so the tests can build their own (test/support/harness.js).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCTION_DOMAIN = 'pos.108-61-190-4.sslip.io';
const DEVELOPMENT_DOMAIN = 'pos.localhost';
// The server's address: a shop's name must resolve to it before a certificate is asked for
const PRODUCTION_IPV4 = '108.61.190.4';
// Where development keeps what the root worker keeps on the server (certificates count as
// issued at once; backups are made in-process): .pos-local/ next to app.js, out of git
const LOCAL_DIR = fileURLToPath(new URL('../.pos-local', import.meta.url));

// A whole host name: two labels or more, each of letters, digits and inner hyphens, 253
// characters at most
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// Every database this app creates starts with pos_, so it can never reach the shop's old
// database (salim_pos) or another site's on the shared server
const CONTROL_DB = /^pos_[a-z0-9_]{1,40}$/;
const TENANT_DB_PREFIX = /^pos_[a-z0-9_]{0,32}_$/;

const isLoopback = (host) => /^127(\.\d{1,3}){3}$/.test(host) || host === '::1';
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function wholeNumber(value, fallback, label, min = 1) {
  const n = Number(value === undefined || value === '' ? fallback : value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${label}=${value} must be a whole number of ${min} or more`);
  return n;
}

function hostNames(value, label) {
  const names = String(value).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) throw new Error(`${label} is empty`);
  for (const name of names) if (!HOST_NAME.test(name)) throw new Error(`${label}: "${name}" is not a host name`);
  return names;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';

  // Behind nginx the app must be reachable only through it: never listen on every interface
  const host = env.HOST || '127.0.0.1';
  if (production && !isLoopback(host)) {
    throw new Error(`HOST=${host} is not a loopback address: in production the app listens on 127.0.0.1 behind nginx`);
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT=${env.PORT} is not a port`);

  // The server only: each shop's database is chosen by the app, never by the address
  const mongodbUri = env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbInUri = mongodbUri.replace(/^mongodb(\+srv)?:\/\/[^/]*/, '').split('?')[0].replace(/^\//, '');
  if (dbInUri) {
    throw new Error(`MONGODB_URI names the database "${dbInUri}": give the server only (mongodb://127.0.0.1:27017); each shop has its own database`);
  }

  const controlDb = env.CONTROL_DB || 'pos_control';
  if (!CONTROL_DB.test(controlDb)) throw new Error(`CONTROL_DB=${controlDb} must look like pos_control`);
  const tenantDbPrefix = env.TENANT_DB_PREFIX || 'pos_t_';
  if (!TENANT_DB_PREFIX.test(tenantDbPrefix)) throw new Error(`TENANT_DB_PREFIX=${tenantDbPrefix} must start with pos_ and end with _`);
  if (controlDb.startsWith(tenantDbPrefix)) throw new Error('CONTROL_DB must not start with TENANT_DB_PREFIX');

  // Shops are <slug>.<domain>. A list, so a real domain can be added later next to sslip.io
  const tenantBaseDomains = hostNames(env.TENANT_BASE_DOMAINS || (production ? PRODUCTION_DOMAIN : DEVELOPMENT_DOMAIN), 'TENANT_BASE_DOMAINS');
  const [adminHost] = hostNames(env.ADMIN_HOST || `admin.${production ? PRODUCTION_DOMAIN : DEVELOPMENT_DOMAIN}`, 'ADMIN_HOST');
  if (tenantBaseDomains.includes(adminHost)) throw new Error('ADMIN_HOST must not be one of TENANT_BASE_DOMAINS');

  const publicScheme = env.PUBLIC_SCHEME || (production ? 'https' : 'http');
  if (!['http', 'https'].includes(publicScheme)) throw new Error(`PUBLIC_SCHEME=${publicScheme} must be http or https`);
  // Over http the sign-in cookie can be neither Secure nor __Host- (lib/sessions.js): development only
  if (production && publicScheme !== 'https') throw new Error('PUBLIC_SCHEME must be https in production: the sign-in cookie needs it');

  const maxTenants = Number(env.MAX_TENANTS || 20);
  if (!Number.isInteger(maxTenants) || maxTenants < 1) throw new Error(`MAX_TENANTS=${env.MAX_TENANTS} must be a whole number above 0`);
  // New shops in any 24 hours, deleted ones included: a stolen admin session cannot fill the server
  const maxNewTenantsPerDay = wholeNumber(env.MAX_NEW_TENANTS_PER_DAY, 5, 'MAX_NEW_TENANTS_PER_DAY');
  // Sign-in requests (password, password change, admin code) per address per minute, counted
  // in the app whatever path variant brought them, behind nginx's own limits of 10 and 5
  const signInPerMinute = wholeNumber(env.SIGN_IN_PER_MINUTE, 10, 'SIGN_IN_PER_MINUTE');
  const adminSignInPerMinute = wholeNumber(env.ADMIN_SIGN_IN_PER_MINUTE, 5, 'ADMIN_SIGN_IN_PER_MINUTE');

  // The key that encrypts the admin's authenticator secret (AES-256-GCM): 64 hex characters.
  // The admin panel cannot sign anyone in without it, so production refuses to start.
  let totpKey = null;
  if (env.TOTP_KEY) {
    if (!/^[0-9a-fA-F]{64}$/.test(env.TOTP_KEY)) throw new Error('TOTP_KEY must be 64 hex characters (openssl rand -hex 32)');
    totpKey = Buffer.from(env.TOTP_KEY, 'hex');
  } else if (production) {
    throw new Error('TOTP_KEY is not set: the admin panel needs it (openssl rand -hex 32)');
  }

  // The root worker's spool (certificates, backups, restores, drops; ops/sbin/pos-root-worker.mjs).
  // Without it, or with DEV_FAKE_CERTS=1, the app does that work itself: certificates count
  // as issued at once and backups are files under .pos-local. Development only.
  const spoolDir = env.SPOOL_DIR || null;
  const devFakeCerts = env.DEV_FAKE_CERTS === '1';
  if (production && !spoolDir) throw new Error('SPOOL_DIR must be set in production: the root worker issues the certificates');
  if (production && devFakeCerts) throw new Error('DEV_FAKE_CERTS is for development only');
  const workerMode = spoolDir && !devFakeCerts ? 'spool' : 'local';
  const localDir = env.POS_LOCAL_DIR || LOCAL_DIR;
  // The worker keeps every archive under /var/backups/pos/<database>/ and the app checks the
  // paths it is given against it; in development the archives are under .pos-local/backups
  const backupDir = env.POS_BACKUP_DIR || (workerMode === 'spool' ? '/var/backups/pos' : path.join(localDir, 'backups'));
  // A shop's name must resolve to this address, and to no IPv6 one, before its certificate
  // is asked for. Unset in development (.localhost names never leave the machine).
  const publicIpv4 = env.PUBLIC_IPV4 || (production ? PRODUCTION_IPV4 : null);
  if (publicIpv4 && !IPV4.test(publicIpv4)) throw new Error(`PUBLIC_IPV4=${publicIpv4} is not an IPv4 address`);

  return Object.freeze({
    production,
    host,
    port,
    mongodbUri,
    controlDb,
    tenantDbPrefix,
    tenantBaseDomains: Object.freeze(tenantBaseDomains),
    adminHost,
    publicScheme,
    maxTenants,
    maxNewTenantsPerDay,
    signInPerMinute,
    adminSignInPerMinute,
    totpKey,
    spoolDir,
    workerMode,
    backupDir,
    localDir,
    publicIpv4,
    // One JSON line per request (pos-monitor counts the 5xx in it): on the server, or REQUEST_LOG=1
    requestLog: production || env.REQUEST_LOG === '1',
  });
}

// The address people open: https behind nginx in production, the app's own port in development
export function publicUrl(config, host) {
  return `${config.publicScheme}://${host}${config.production ? '' : `:${config.port}`}`;
}
