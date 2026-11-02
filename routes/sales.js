import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import { nextSequence } from '../models/Counter.js';
import { httpError } from '../lib/errors.js';
import { money } from '../lib/util.js';

const router = Router();
const MAX_QUANTITY = 10000;

// Day boundaries in the server's local time (the shop's clock)
function dayRange(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  const now = new Date();
  const start = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

router.get('/', async (req, res) => {
  const { start, end } = dayRange(req.query.date);
  const sales = await Sale.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 }).lean();
  const summary = sales.reduce(
    (acc, sale) => ({
      count: acc.count + 1,
      total: money(acc.total + sale.total),
      profit: money(acc.profit + sale.profit),
    }),
    { count: 0, total: 0, profit: 0 },
  );
  res.json({ summary, sales });
});

router.post('/', async (req, res) => {
  const lines = Array.isArray(req.body.items) ? req.body.items : [];
  if (lines.length === 0) throw httpError(400, 'أضف منتجًا واحدًا على الأقل إلى الفاتورة');

  // Merge repeated lines of the same product, keeping cart order
  const quantities = new Map();
  for (const line of lines) {
    const id = String(line?.productId ?? '');
    const quantity = Number(line?.quantity);
    if (!mongoose.isObjectIdOrHexString(id)) throw httpError(400, 'الفاتورة تحتوي على منتج غير صالح');
    if (!Number.isInteger(quantity) || quantity < 1) throw httpError(400, 'الكمية يجب أن تكون عددًا صحيحًا موجبًا');
    quantities.set(id, (quantities.get(id) ?? 0) + quantity);
  }
  if ([...quantities.values()].some((q) => q > MAX_QUANTITY)) {
    throw httpError(400, `أقصى كمية للصنف الواحد ${MAX_QUANTITY}`);
  }

  // Prices always come from the database, never from the client
  const products = await Product.find({ _id: { $in: [...quantities.keys()] } }).lean();
  if (products.length !== quantities.size) {
    throw httpError(400, 'بعض منتجات الفاتورة لم تعد موجودة. حدّث الصفحة وأعد المحاولة');
  }
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [...quantities].map(([id, quantity]) => {
    const p = byId.get(id);
    return {
      product: p._id,
      name: p.name,
      barcode: p.barcode,
      quantity,
      unitPrice: p.salePrice,
      unitCost: p.purchasePrice,
      lineTotal: money(p.salePrice * quantity),
    };
  });

  const total = money(items.reduce((sum, i) => sum + i.lineTotal, 0));
  const cost = money(items.reduce((sum, i) => sum + i.unitCost * i.quantity, 0));
  const paidInput = req.body.paid;
  const paid = paidInput === undefined || paidInput === null || paidInput === '' ? total : money(paidInput);
  if (!Number.isFinite(paid) || paid < total) throw httpError(400, 'المبلغ المدفوع أقل من إجمالي الفاتورة');

  const sale = await Sale.create({
    number: await nextSequence('sale'),
    items,
    total,
    cost,
    profit: money(total - cost),
    paid,
    change: money(paid - total),
  });
  res.status(201).json(sale);
});

export default router;
