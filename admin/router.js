import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import { createSessionStore } from '../lib/sessions.js';
import { createLoginGuard } from '../lib/login-guard.js';
import { ADMIN_CSP, contentSecurityPolicy, noStore } from '../lib/security.js';
import { createAdminAuth } from './auth.js';
import { createAdminApi } from './api.js';

const ADMIN_PUBLIC = fileURLToPath(new URL('../admin-public', import.meta.url));
const SHARED_CSS = fileURLToPath(new URL('../public/css', import.meta.url));

/*
 * The admin panel on ADMIN_HOST, in this order:
 *   1. a strict Content-Security-Policy, enforced (no inline script or style, Trusted Types)
 *   2. its files: the one page, its scripts, its styles and the shops' shared style.css
 *   3. /api/admin: signing in (admin/auth.js), then a full session for everything else,
 *      every write CSRF checked (admin/api.js), 404 JSON for anything unknown
 * ctx is { db, registry, config, worker?, runner? } (services/).
 */
export function createAdminRouter(ctx) {
  const { db, config } = ctx;
  const router = Router();
  const store = createSessionStore({ Session: db.controlModels.Session, config, kind: 'admin' });
  const guard = createLoginGuard(db.controlModels.LoginAttempt);
  const auth = createAdminAuth({ db, config, store, guard });

  router.use(contentSecurityPolicy({ directives: ADMIN_CSP }));

  // 2. The page and its files; a session is checked by the API, not here
  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: ADMIN_PUBLIC });
  });
  router.use('/js', express.static(`${ADMIN_PUBLIC}/js`, { index: false }));
  router.get('/admin.css', (req, res) => res.sendFile('admin.css', { root: `${ADMIN_PUBLIC}/css` }));
  router.use('/css', express.static(SHARED_CSS, { index: false }));
  router.get('/favicon.ico', (req, res) => res.status(204).end());

  // 3. The API
  const api = Router();
  api.use(noStore);
  api.use(express.json({ limit: '64kb' }));
  api.use((req, res, next) => {
    req.body ??= {};
    next();
  });
  api.use(auth.publicRouter);
  api.use(auth.session, auth.csrf);
  api.use(auth.codeRouter);
  api.use(auth.requireFull);
  api.use(auth.router);
  api.use(createAdminApi(ctx, { requireStepUp: auth.requireStepUp }));
  api.use((req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
  router.use('/api/admin', api);
  router.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));

  router.use((req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(404).type('text/plain; charset=utf-8').send('غير موجود');
  });
  return router;
}
