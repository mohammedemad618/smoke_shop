import { Router } from 'express';
import { allow } from '../lib/permissions.js';
import { createStaff, listStaff, resetStaffPassword, setStaffDisabled, updateStaff } from '../services/staff.js';

/*
 * The shop's staff accounts, for its owner only (the «الموظفون» card of the settings page;
 * services/staff.js has the rules), mounted at /api/staff:
 *   GET  /                -> { staff: [...], max }
 *   POST /                { username, displayName, permissions } -> 201 { staff, password }
 *   PUT  /:id             { displayName?, permissions? } -> { staff }
 *   POST /:id/disable     -> { staff }: its sessions end now
 *   POST /:id/enable      -> { staff }
 *   POST /:id/password    -> { staff, password }: a new first password, its sessions end
 * A password is in the answer once and nowhere else. ctx is { db, registry, config }.
 */
export function createStaffRouter(ctx) {
  const router = Router();
  // The shop and who acts, for the audit log
  const shopOf = (req) => ({ tenant: req.tenant, models: req.models, by: { actor: `shop:${req.user.usernameLower}`, ip: req.ip ?? null } });

  router.get('/', allow('owner'), async (req, res) => {
    res.json(await listStaff(shopOf(req)));
  });

  router.post('/', allow('owner'), async (req, res) => {
    res.status(201).json(await createStaff(ctx, shopOf(req), req.body));
  });

  router.put('/:id', allow('owner'), async (req, res) => {
    res.json(await updateStaff(ctx, shopOf(req), req.params.id, req.body));
  });

  router.post('/:id/disable', allow('owner'), async (req, res) => {
    res.json(await setStaffDisabled(ctx, shopOf(req), req.params.id, true));
  });

  router.post('/:id/enable', allow('owner'), async (req, res) => {
    res.json(await setStaffDisabled(ctx, shopOf(req), req.params.id, false));
  });

  router.post('/:id/password', allow('owner'), async (req, res) => {
    res.json(await resetStaffPassword(ctx, shopOf(req), req.params.id));
  });

  return router;
}
