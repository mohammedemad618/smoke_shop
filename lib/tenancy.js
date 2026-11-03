// Which shop a request is for, from its Host header and nothing else (never a proxy header
// or Express's own idea of the host): ADMIN_HOST goes to the admin router, <slug>.<base
// domain> to its shop once the registry knows it and its status allows, and anything else
// is refused here, before any database is opened. Unknown hosts never reach attachModels,
// so they can never create a database.
import { checkSlug } from './slug.js';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// "Shop-A.pos.localhost:3000" -> "shop-a.pos.localhost". Lower-cased, the port and one
// trailing dot taken off; null for anything odd (IP literals in brackets, user info, empty
// labels, characters a host name cannot have).
export function normalizeHost(raw) {
  if (typeof raw !== 'string' || raw.length > 260) return null;
  let host = raw.toLowerCase();
  const port = host.match(/:(\d{1,5})$/);
  if (port) {
    if (Number(port[1]) > 65535) return null;
    host = host.slice(0, -port[0].length);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.length > 253) return null;
  return host.split('.').every((label) => LABEL.test(label)) ? host : null;
}

// What a shop's address answers when it cannot be used: JSON for /api, a short page otherwise
const REFUSALS = {
  badHost: { status: 400, code: 'BAD_HOST', title: 'طلب غير صالح', message: 'عنوان الطلب غير صالح.' },
  unknown: { status: 404, code: 'TENANT_NOT_FOUND', title: 'المتجر غير موجود', message: 'لا يوجد متجر بهذا العنوان. تأكد من العنوان.' },
  provisioning: { status: 503, code: 'TENANT_PROVISIONING', title: 'جارٍ تجهيز المتجر', message: 'جارٍ تجهيز المتجر. أعد المحاولة بعد قليل.' },
  suspended: { status: 423, code: 'TENANT_SUSPENDED', title: 'المتجر موقوف', message: 'هذا المتجر موقوف مؤقتًا، تواصل مع الإدارة.' },
  deleted: { status: 410, code: 'TENANT_DELETED', title: 'المتجر غير موجود', message: 'هذا المتجر لم يعد موجودًا.' },
};
const REFUSAL_BY_STATUS = { provisioning: 'provisioning', suspended: 'suspended', pending_deletion: 'suspended', deleted: 'deleted' };

// Same colours as public/css/style.css; inline because a refused host serves no files
const page = ({ title, message }) => `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | نقطة البيع</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font-family: "Readex Pro", "Segoe UI", Tahoma, system-ui, sans-serif; font-size: 15px; line-height: 1.55;
    color: #1C2530; background: #E2E6EA; }
  main { max-width: 440px; width: 100%; padding: 28px 24px; text-align: center;
    background: #FFFFFF; border: 1px solid #CBD2D9; border-radius: 8px; }
  h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
  p { margin: 0; color: #44505D; }
</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>
`;

export function refuse(req, res, kind) {
  const refusal = REFUSALS[kind];
  // A suspended shop that is resumed must not stay refused in a cache
  res.set('Cache-Control', 'no-store');
  if (refusal.status === 503) res.set('Retry-After', '30');
  res.status(refusal.status);
  if (req.path === '/api' || req.path.startsWith('/api/')) return res.json({ error: refusal.message, code: refusal.code });
  res.type('html').send(page(refusal));
}

// The shop for a normalized host name: only <one label>.<base domain>, a label that could be
// a shop's address, and a host the registry knows
function findShop(registry, host, baseDomains) {
  const base = baseDomains.find((domain) => host.endsWith(`.${domain}`));
  if (!base) return null;
  const slug = host.slice(0, -base.length - 1);
  if (slug.includes('.') || !checkSlug(slug).ok) return null;
  return registry.resolve(host);
}

export function tenancy({ registry, adminHost, baseDomains, adminRouter, tenantRouter }) {
  return function dispatch(req, res, next) {
    const host = normalizeHost(req.headers.host);
    if (!host) return refuse(req, res, 'badHost');
    if (host === adminHost) return adminRouter(req, res, next);

    const found = findShop(registry, host, baseDomains);
    if (!found) return refuse(req, res, 'unknown');
    // A retired address stays out of use for ever. Redirects to a new address come with
    // renaming (a later phase); until then nothing makes them.
    if (found.host.kind === 'retired') return refuse(req, res, 'deleted');
    if (found.host.kind !== 'primary') return refuse(req, res, 'unknown');
    // The shop's status is checked before anything else, sessions included (a later phase)
    const refusal = REFUSAL_BY_STATUS[found.tenant.status];
    if (refusal) return refuse(req, res, refusal);
    if (found.tenant.status !== 'active') return refuse(req, res, 'unknown');

    req.tenant = found.tenant;
    return tenantRouter(req, res, next);
  };
}

// Puts the shop's models on req.models, its indexes built on first use (lib/db.js). Routes
// take every model from there and never import one.
export function attachModels(db) {
  return async function attach(req, res, next) {
    req.models ??= await db.tenantModels(req.tenant);
    next();
  };
}
