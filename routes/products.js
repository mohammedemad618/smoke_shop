import { Router } from 'express';
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { escapeRegex, roundQty } from '../lib/util.js';
import { allow, productFor } from '../lib/permissions.js';

const router = Router();
const EDITABLE = [
  'name',
  'barcode',
  'purchasePrice',
  'salePrice',
  'category',
  'unit',
  'hasWholesale',
  'wholesaleQty',
  'wholesalePrice',
  'trackStock',
  'stock',
  'lowStockAlert',
  'blockWhenOut',
];

const pickEditable = (body) =>
  Object.fromEntries(EDITABLE.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

// Rules that span fields: products sold by the piece count in whole pieces; a wholesale
// price needs its box size (pieces) or weight (kg). An edit is checked together with what
// the product already has, so changing one field cannot break another.
function checkUnits(data, existing = {}) {
  const merged = { ...existing, ...data };
  const byPiece = (merged.unit ?? 'piece') === 'piece';
  const wholePieces = (value, message) => {
    if (byPiece && value !== undefined && !Number.isInteger(Number(value))) throw httpError(400, message);
  };
  wholePieces(merged.stock, 'كمية المخزن يجب أن تكون عددًا صحيحًا من القطع');
  wholePieces(merged.lowStockAlert, 'حد التنبيه يجب أن يكون عددًا صحيحًا من القطع');
  // Weights are kept to the gram, like every stock change
  if (data.stock !== undefined && data.stock !== null && data.stock !== '') data.stock = roundQty(data.stock);
  if (merged.hasWholesale) {
    const size = Number(merged.wholesaleQty);
    const price = Number(merged.wholesalePrice);
    if (byPiece && !(Number.isInteger(size) && size >= 2)) throw httpError(400, 'عدد القطع في العلبة يجب أن يكون 2 أو أكثر');
    if (!byPiece && !(size > 0)) throw httpError(400, 'أدخل وزن الجملة بالكيلوغرام');
    if (!Number.isFinite(price) || price < 0) throw httpError(400, 'أدخل سعر بيع الجملة');
  }
}

async function assertCategoryExists(Category, id) {
  if (id === undefined) return;
  if (!mongoose.isObjectIdOrHexString(id) || !(await Category.exists({ _id: id }))) {
    throw httpError(400, 'اختر القسم');
  }
}

// Every account sells, so every account reads the products: without `reports`, without
// their purchase price (lib/permissions.js)
router.get('/', allow('selling'), async (req, res) => {
  const { Product } = req.models;
  const filter = {};
  if (req.query.category) filter.category = String(req.query.category);
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: pattern }, { barcode: pattern }];
  }
  const products = await Product.find(filter)
    .collation({ locale: 'ar' })
    .sort({ name: 1 })
    .populate('category', 'name')
    .lean();
  res.json(products.map((p) => productFor(req.user, p)));
});

// What the whole shop is owed and owes: customers' debts, and unpaid supplier invoices
async function debtTotals({ DebtEntry, Purchase }) {
  const [customers, owedToSuppliers] = await Promise.all([DebtEntry.totals(), Purchase.owedToSuppliers()]);
  return { ...customers, owedToSuppliers };
}

// What the stock is worth, for the products page. For the whole shop it also brings the
// debts both ways, which are part of the shop's capital.
router.get('/valuation', allow('reports'), async (req, res) => {
  const { Product, StockCount } = req.models;
  const category = String(req.query.category ?? '');
  if (category && !mongoose.isObjectIdOrHexString(category)) throw httpError(400, 'اختر القسم');
  const [stock, debts, lastCount] = await Promise.all([
    Product.valuation(category ? { category: new mongoose.Types.ObjectId(category) } : {}),
    category ? null : debtTotals(req.models),
    StockCount.findOne({ status: 'applied' }).sort({ appliedAt: -1 }).select('appliedAt').lean(),
  ]);
  res.json({ ...stock, debts, lastCountAt: lastCount?.appliedAt ?? null });
});

router.get('/barcode/:code', allow('selling'), async (req, res) => {
  const { Product } = req.models;
  const product = await Product.findOne({ barcode: req.params.code.trim() }).populate('category', 'name').lean();
  if (!product) throw httpError(404, 'لا يوجد منتج بهذا الباركود');
  res.json(productFor(req.user, product));
});

// The purchase price can be given without `reports` (a new product needs one); it is just
// never sent back
router.post('/', allow('products'), async (req, res) => {
  const { Product, Category } = req.models;
  const data = pickEditable(req.body);
  checkUnits(data);
  await assertCategoryExists(Category, data.category);
  const product = await Product.create(data);
  await product.populate('category', 'name');
  res.status(201).json(productFor(req.user, product));
});

router.put('/:id', allow('products'), async (req, res) => {
  const { Product, Category } = req.models;
  const data = pickEditable(req.body);
  const existing = await Product.findById(req.params.id).lean();
  if (!existing) throw httpError(404, 'المنتج غير موجود');
  checkUnits(data, existing);
  await assertCategoryExists(Category, data.category);
  const product = await Product.findByIdAndUpdate(req.params.id, data, {
    returnDocument: 'after',
    runValidators: true,
  }).populate('category', 'name');
  if (!product) throw httpError(404, 'المنتج غير موجود');
  res.json(productFor(req.user, product));
});

router.delete('/:id', allow('owner'), async (req, res) => {
  const { Product } = req.models;
  const deleted = await Product.findByIdAndDelete(req.params.id);
  if (!deleted) throw httpError(404, 'المنتج غير موجود');
  res.status(204).end();
});

export default router;
