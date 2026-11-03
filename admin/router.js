import { Router } from 'express';

// The admin panel on ADMIN_HOST: signing in with a password and an authenticator code,
// the shops list, creating, suspending and resetting shops (a later phase, built on
// services/tenants.js and lib/registry.js). Until then the host answers 404 to everything.
// eslint-disable-next-line no-unused-vars
export function createAdminRouter({ db, registry, config }) {
  const router = Router();
  router.use((req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(404).json({ error: 'لوحة الإدارة غير متاحة بعد' });
  });
  return router;
}
