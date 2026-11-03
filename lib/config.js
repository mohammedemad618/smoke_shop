// Settings from the environment (.env in development, /etc/pos/pos.env on the server).
// loadConfig() reads them once and refuses anything unsafe, so the app never starts half
// configured; it is a plain function so the tests can build their own (test/support/harness.js).

const PRODUCTION_DOMAIN = 'pos.108-61-190-4.sslip.io';
const DEVELOPMENT_DOMAIN = 'pos.localhost';

// One label of a host name: letters, digits and inner hyphens
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// Every database this app creates starts with pos_, so it can never reach the shop's old
// database (salim_pos) or another site's on the shared server
const CONTROL_DB = /^pos_[a-z0-9_]{1,40}$/;
const TENANT_DB_PREFIX = /^pos_[a-z0-9_]{0,32}_$/;

const isLoopback = (host) => /^127(\.\d{1,3}){3}$/.test(host) || host === '::1';

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

  const maxTenants = Number(env.MAX_TENANTS || 20);
  if (!Number.isInteger(maxTenants) || maxTenants < 1) throw new Error(`MAX_TENANTS=${env.MAX_TENANTS} must be a whole number above 0`);

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
  });
}

// The address people open: https behind nginx in production, the app's own port in development
export function publicUrl(config, host) {
  return `${config.publicScheme}://${host}${config.production ? '' : `:${config.port}`}`;
}
