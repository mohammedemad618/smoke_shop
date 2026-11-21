import { Router } from 'express';
import { DAY_MS, requestedRange } from '../lib/range.js';
import { runReport } from '../lib/limits.js';
import { allow } from '../lib/permissions.js';
import { cashMovement } from '../services/cash.js';
import { debtMovement } from '../lib/debt-ledger.js';

const router = Router();

router.get('/cash', allow('reports'), async (req, res) => {
  const { start, end } = requestedRange(req.query, 32 * DAY_MS);
  res.json(await runReport(req.tenant._id, () => cashMovement(req.models, start, end)));
});

router.get('/debts', allow('reports'), async (req, res) => {
  const { start, end } = requestedRange(req.query, 32 * DAY_MS);
  res.json(await runReport(req.tenant._id, () => debtMovement(req.models.DebtEntry, start, end)));
});

export default router;
