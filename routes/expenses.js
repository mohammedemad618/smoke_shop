import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { allow } from '../lib/permissions.js';
import { money } from '../lib/util.js';
import { madeByOf } from '../lib/auth.js';
import { DAY_MS, requestedRange } from '../lib/range.js';

const router = Router();
const EDITABLE = ['date', 'amount', 'category', 'note'];
const MAX_RANGE_MS = 3 * 366 * DAY_MS;

// Amounts are kept to the cent, like every other sum
const pickEditable = (body) => {
  const data = Object.fromEntries(EDITABLE.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
  if (data.amount !== undefined && data.amount !== null && data.amount !== '') data.amount = money(data.amount);
  return data;
};

// Expenses of a period (?from=&to=), newest first, with totals per type
router.get('/', allow('purchases'), async (req, res) => {
  const { Expense } = req.models;
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
router.get('/categories', allow('purchases'), async (req, res) => {
  const { Expense } = req.models;
  const rows = await Expense.aggregate([
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ]);
  res.json(rows.map((r) => r._id));
});

// Who recorded an expense and who changed it last come from the session (madeBy, editedBy)
router.post('/', allow('purchases'), async (req, res) => {
  const { Expense } = req.models;
  const expense = await Expense.create({ ...pickEditable(req.body), madeBy: madeByOf(req.user) });
  res.status(201).json(expense);
});

router.put('/:id', allow('purchases'), async (req, res) => {
  const { Expense } = req.models;
  const expense = await Expense.findByIdAndUpdate(req.params.id, { ...pickEditable(req.body), editedBy: madeByOf(req.user) }, {
    returnDocument: 'after',
    runValidators: true,
  });
  if (!expense) throw httpError(404, 'المصروف غير موجود');
  res.json(expense);
});

router.delete('/:id', allow('owner'), async (req, res) => {
  const { Expense } = req.models;
  const deleted = await Expense.findByIdAndDelete(req.params.id);
  if (!deleted) throw httpError(404, 'المصروف غير موجود');
  res.status(204).end();
});

export default router;
