import { Router } from 'express';
import { allow } from '../lib/permissions.js';
import { sendCsv } from '../lib/csv.js';
import { DAY_MS, requestedRange, timeZoneParam } from '../lib/range.js';
import { runReport } from '../lib/limits.js';
import { productsCsv, salesCsv, debtsCsv } from '../services/exports.js';

const router = Router();
const MAX_RANGE_MS = 3 * 366 * DAY_MS;
const today = () => new Date().toISOString().slice(0, 10);

// The shop's data as CSV files for its owner (the settings page): opened by a plain link,
// so a GET with the session's cookie, never changing anything. The sales come as one line a
// day of the browser's own month (?from=&to=&tz=, like the sales report) and a total line.
// Each file is a report: one at a time per shop (lib/limits.js).
router.get('/products.csv', allow('owner'), async (req, res) => {
  sendCsv(res, `products-${req.tenant.slug}-${today()}.csv`, await runReport(req.tenant._id, () => productsCsv(req.models)));
});

router.get('/sales.csv', allow('owner'), async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_RANGE_MS);
  const timeZone = timeZoneParam(req.query.tz);
  const label = String(req.query.label ?? '').replace(/[^0-9-]/g, '').slice(0, 10) || start.toISOString().slice(0, 10);
  sendCsv(res, `sales-${req.tenant.slug}-${label}.csv`, await runReport(req.tenant._id, () => salesCsv(req.models, { start, end, timeZone })));
});

router.get('/debts.csv', allow('owner'), async (req, res) => {
  sendCsv(res, `debts-${req.tenant.slug}-${today()}.csv`, await runReport(req.tenant._id, () => debtsCsv(req.models)));
});

export default router;
