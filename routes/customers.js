import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { money } from '../lib/util.js';
import { madeByOf } from '../lib/auth.js';
import { allow, forbidden, isOwner } from '../lib/permissions.js';

const router = Router();
const EDITABLE = ['name', 'phone', 'note'];
// Entries added from the debts page; sale and return entries belong to invoices
const MANUAL_KINDS = { payment: -1, manual: 1 };

const pickEditable = (body) =>
  Object.fromEntries(EDITABLE.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

async function findCustomer(Customer, id) {
  const customer = await Customer.findById(id).lean();
  if (!customer) throw httpError(404, 'الزبون غير موجود');
  return customer;
}

// All customers with what each owes
router.get('/', allow('credit'), async (req, res) => {
  const { Customer, DebtEntry } = req.models;
  const [customers, balances] = await Promise.all([
    Customer.find().collation({ locale: 'ar' }).sort({ name: 1 }).lean(),
    DebtEntry.aggregate([
      { $group: { _id: '$customer', balance: { $sum: '$amount' }, lastActivity: { $max: '$date' } } },
    ]),
  ]);
  const byId = new Map(balances.map((b) => [String(b._id), b]));
  res.json(
    customers.map((c) => {
      const b = byId.get(String(c._id));
      return { ...c, balance: money(b?.balance ?? 0), lastActivity: b?.lastActivity ?? null };
    }),
  );
});

// One customer with their account, oldest entry first
router.get('/:id', allow('credit'), async (req, res) => {
  const { Customer, DebtEntry } = req.models;
  const customer = await findCustomer(Customer, req.params.id);
  const entries = await DebtEntry.find({ customer: customer._id }).sort({ date: 1, createdAt: 1 }).lean();
  const balance = money(entries.reduce((sum, e) => sum + e.amount, 0));
  res.json({ ...customer, balance, entries });
});

router.post('/', allow('credit'), async (req, res) => {
  const { Customer } = req.models;
  const customer = await Customer.create(pickEditable(req.body));
  res.status(201).json({ ...customer.toObject(), balance: 0 });
});

router.put('/:id', allow('credit'), async (req, res) => {
  const { Customer } = req.models;
  const customer = await Customer.findByIdAndUpdate(req.params.id, pickEditable(req.body), {
    returnDocument: 'after',
    runValidators: true,
  });
  if (!customer) throw httpError(404, 'الزبون غير موجود');
  res.json(customer);
});

router.delete('/:id', allow('owner'), async (req, res) => {
  const { Customer, DebtEntry } = req.models;
  if (await DebtEntry.exists({ customer: req.params.id })) {
    throw httpError(409, 'لا يمكن حذف زبون له سجلات دين');
  }
  const deleted = await Customer.findByIdAndDelete(req.params.id);
  if (!deleted) throw httpError(404, 'الزبون غير موجود');
  res.status(204).end();
});

// A payment (takes off the debt) or a debt added by hand. Taking a payment is part of selling
// on credit; a debt added by hand (money lent, or owed from before) is the owner's. The entry
// records who made it, from the session. Only the owner dates it: a payment counts as money
// collected on its day (the net profit), so a staff account's is dated now, never on a day
// already closed.
router.post('/:id/entries', allow('credit'), async (req, res) => {
  const { Customer, DebtEntry } = req.models;
  const sign = MANUAL_KINDS[req.body.kind];
  if (!sign) throw httpError(400, 'نوع السجل غير صالح');
  if (req.body.kind === 'manual' && !isOwner(req.user)) throw forbidden('owner');
  const customer = await findCustomer(Customer, req.params.id);
  const amount = money(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'المبلغ يجب أن يكون أكبر من صفر');
  const entry = await DebtEntry.create({
    customer: customer._id,
    kind: req.body.kind,
    amount: sign * amount,
    note: req.body.note ?? '',
    date: isOwner(req.user) ? (req.body.date ?? new Date()) : new Date(),
    madeBy: madeByOf(req.user),
  });
  res.status(201).json({ entry, balance: await DebtEntry.balanceOf(customer._id) });
});

// Only payments and hand-added debts can be deleted; invoice entries follow their invoice
router.delete('/:id/entries/:entryId', allow('owner'), async (req, res) => {
  const { DebtEntry } = req.models;
  const entry = await DebtEntry.findOne({ _id: req.params.entryId, customer: req.params.id });
  if (!entry) throw httpError(404, 'السجل غير موجود');
  if (!MANUAL_KINDS[entry.kind]) throw httpError(409, 'هذا السجل مرتبط بفاتورة، ويُعدَّل بإرجاع الفاتورة من صفحة المبيعات');
  await entry.deleteOne();
  res.json({ balance: await DebtEntry.balanceOf(req.params.id) });
});

export default router;
