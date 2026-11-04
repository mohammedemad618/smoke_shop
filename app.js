import { fileURLToPath } from 'node:url';
import express from 'express';
import { errorHandler } from './lib/errors.js';
import { tenancy, attachModels } from './lib/tenancy.js';
import { requireTenantSession, requirePasswordChanged } from './lib/auth.js';
import { requireCsrf } from './lib/csrf.js';
import { requirePage } from './lib/permissions.js';
import { createSessionStore } from './lib/sessions.js';
import { createLoginGuard } from './lib/login-guard.js';
import { SHOP_CSP, contentSecurityPolicy, noStore, securityHeaders } from './lib/security.js';
import { publicUrl } from './lib/config.js';
import { health } from './lib/health.js';
import { requestLog } from './lib/requestlog.js';
import { shopRequests } from './lib/limits.js';
import { EXACT } from './lib/routing.js';
import { createAdminRouter } from './admin/router.js';
import { createAuthRouters } from './routes/auth.js';
import { createSettingsRouter } from './routes/settings.js';
import { createStaffRouter } from './routes/staff.js';
import cspReportRouter from './routes/csp-report.js';
import shopRouter from './routes/shop.js';
import categoriesRouter from './routes/categories.js';
import productsRouter from './routes/products.js';
import salesRouter from './routes/sales.js';
import expensesRouter from './routes/expenses.js';
import customersRouter from './routes/customers.js';
import stockCountsRouter from './routes/stockcounts.js';
import purchasesRouter from './routes/purchases.js';
import exportRouter from './routes/export.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

// Mounts a router and notes where, so the tests can list every route of a shop with its
// full path (test/auth.test.js checks each one answers 401 without a session)
function mount(parent, path, ...handlers) {
  parent.use(path, ...handlers);
  (parent.mounts ??= []).push({ path, router: handlers.at(-1) });
}

/*
 * One shop's app, on its own address, in this order:
 *   1. the files anyone may load: styles, scripts, the camera decoder and the sign-in page
 *   2. the public endpoints: the shop's name, signing in, CSP reports
 *   3. the session check (lib/auth.js): /api answers 401, a page goes to the sign-in page
 *   4. the account's own routes, then the first-password gate
 *   5. the pages (a page the account may not open answers 403), then the shop's models on
 *      req.models and the API (4 requests of the shop at a time, lib/limits.js), then 404
 *      for /api
 * Every state-changing /api request past 3 carries the session's CSRF token (lib/csrf.js).
 * Every /api route declares what an account needs to use it (lib/permissions.js allow()),
 * the public ones included.
 * Paths match exactly, letter case and final slash included (lib/routing.js).
 */
export function createTenantRouter({ db, registry, config }) {
  const router = express.Router(EXACT);
  const store = createSessionStore({ Session: db.controlModels.Session, config, kind: 'tenant' });
  const guard = createLoginGuard(db.controlModels.LoginAttempt);
  const auth = createAuthRouters({ config, store, guard });
  const limitShop = shopRequests();
  const models = attachModels(db);

  // Report-only for now: browsers send what it would block to /api/csp-report
  router.use(contentSecurityPolicy({ directives: SHOP_CSP, reportOnly: true, reportUri: '/api/csp-report' }));
  router.use('/api', noStore);

  // 1. Files first: a style, a script or the camera decoder never opens the shop's database
  router.use('/css', express.static(`${PUBLIC_DIR}/css`, { index: false }));
  router.use('/js', express.static(`${PUBLIC_DIR}/js`, { index: false }));
  // Camera barcode decoder, loaded on demand by public/js/scanner.js (works offline)
  router.use('/vendor/zxing-wasm', express.static(fileURLToPath(new URL('./node_modules/zxing-wasm/dist', import.meta.url)), { index: false }));
  router.get('/login.html', (req, res) => res.sendFile('login.html', { root: PUBLIC_DIR }));
  router.get('/favicon.ico', (req, res) => res.status(204).end());

  // 2. Public endpoints. CSP reports read their own body type, so they come before the JSON parser.
  mount(router, '/api/csp-report', cspReportRouter);
  const publicApi = express.Router(EXACT);
  router.use(express.json({ limit: '200kb' }));
  // Express 5 leaves req.body undefined when the request had no JSON body
  router.use((req, res, next) => {
    req.body ??= {};
    next();
  });
  mount(publicApi, '/auth', models, auth.publicRouter);
  mount(router, '/api', publicApi);

  // 3. Everything below needs a session of this shop's own
  router.use(requireTenantSession({ db, store }));
  router.use('/api', requireCsrf(config));

  // 4. Signing out and changing the password work while the first password is unchanged
  const sessionApi = express.Router(EXACT);
  mount(sessionApi, '/auth', auth.sessionRouter);
  mount(router, '/api', sessionApi);
  router.use(requirePasswordChanged());

  // 5. The pages, then the shop's data
  router.use(requirePage());
  router.use(express.static(PUBLIC_DIR));
  const api = express.Router(EXACT);
  mount(api, '/shop', shopRouter);
  mount(api, '/settings', createSettingsRouter({ db, registry, config }));
  mount(api, '/staff', createStaffRouter({ db, registry, config }));
  mount(api, '/categories', categoriesRouter);
  mount(api, '/products', productsRouter);
  mount(api, '/sales', salesRouter);
  mount(api, '/expenses', expensesRouter);
  mount(api, '/customers', customersRouter);
  mount(api, '/stockcounts', stockCountsRouter);
  mount(api, '/purchases', purchasesRouter);
  mount(api, '/export', exportRouter);
  mount(router, '/api', limitShop, models, api);
  router.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
  return router;
}

// The Express app, without the connection or the port (server.js does those), so the tests
// can run it in-process. The Host header picks the admin panel or a shop (lib/tenancy.js);
// /healthz and /readyz answer only for Host localhost (lib/health.js). worker and runner
// are the root worker's client and the job runner (lib/worker.js, services/jobs.js): the
// admin panel queues jobs and the runner carries them out.
export function createApp({ db, registry, config, worker, runner }) {
  const ctx = { db, registry, config, worker, runner };
  const app = express();
  app.disable('x-powered-by');
  // nginx on this machine is the only client: the address it passes on is the visitor's
  // (req.ip, for the failed sign-ins). Nothing else is taken from proxy headers.
  app.set('trust proxy', 'loopback');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  if (config.requestLog) app.use(requestLog());
  app.use(securityHeaders());
  app.use(health({ db }));
  app.use(
    tenancy({
      registry,
      adminHost: config.adminHost,
      baseDomains: config.tenantBaseDomains,
      adminRouter: createAdminRouter(ctx),
      tenantRouter: createTenantRouter(ctx),
      urlOf: (host) => publicUrl(config, host),
    }),
  );
  app.use(errorHandler);
  return app;
}
