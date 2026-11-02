import { Router } from 'express';
import Expense from '../models/Expense.js';
import { httpError } from '../lib/errors.js';
import { money } from '../lib/util.js';
import { DAY_MS, requestedRange } from '../lib/range.js';

const router = Router();
const EDITABLE = ['date', 'amount', 'category', 'note'];
const MAX_RANGE_MS = 3 * 366 * DAY_MS;

const pickEditable = (body) =>
  Object.fromEntries(EDITABLE.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

// Expenses of a period (?from=&to=), newest first, with totals per type
router.get('/', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_RANGE_MS);
  const expenses = await Expense.find({ date: { $gte: start, $lt: end } }).sort({ date: -1, createdAt: -1 }).lean();
  const byCategory = new Map();
  for (const e of expenses) {
    const row = byCategory.get(e.category) ?? { category: e.category, total: 0, count: 0 };
    row.total = money(row.total + e.amount);
    row.count += 1;
    byCategory.set(e.category, row);
  }
  res.json({
    total: money(expenses.reduce((sum, e) => sum + e.amount, 0)),
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
    expenses,
  });
});

// Types used before, most used first, to suggest in the form
router.get('/categories', async (req, res) => {
  const rows = await Expense.aggregate([
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ]);
  res.json(rows.map((r) => r._id));
});

router.post('/', async (req, res) => {
  const expense = await Expense.create(pickEditable(req.body));
  res.status(201).json(expense);
});

router.put('/:id', async (req, res) => {
  const expense = await Expense.findByIdAndUpdate(req.params.id, pickEditable(req.body), {
    returnDocument: 'after',
    runValidators: true,
  });
  if (!expense) throw httpError(404, 'المصروف غير موجود');
  res.json(expense);
});

router.delete('/:id', async (req, res) => {
  const deleted = await Expense.findByIdAndDelete(req.params.id);
  if (!deleted) throw httpError(404, 'المصروف غير موجود');
  res.status(204).end();
});

export default router;
