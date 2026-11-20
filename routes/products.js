import { Router } from 'express';
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { escapeRegex, money, roundQty } from '../lib/util.js';
import { allow, productFor } from '../lib/permissions.js';
import { SETTING_DEFAULTS } from '../lib/shop-settings.js';
import { addStock, inventoryOf, inventoryWrite, takeStock } from '../lib/inventory.js';
import { cashAfter, refundCash, saleCash } from '../services/cash.js';

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

// Start from the opening balance and include the shop's recorded cash movements. A refund only
// takes cash out for the part the shop paid back to the customer.
async function shopFinances({ DebtEntry, Purchase, Sale, Expense, Setting }) {
  const [customers, suppliers, [sales], [expenses], settings] = await Promise.all([
    DebtEntry.totals(),
    Purchase.totals(),
    Sale.aggregate([
      {
        $group: {
          _id: null,
          received: { $sum: saleCash },
          refunded: { $sum: refundCash({ $sum: '$returns.amount' }, { $sum: '$returns.toAccount' }) },
        },
      },
    ]),
    Expense.aggregate([{ $group: { _id: null, paid: { $sum: '$amount' } } }]),
    Setting.findById('shop').select('openingCashBalance').lean(),
  ]);
  const { owedToShop, owedByShop, receivedFromCustomers } = customers;
  const { owedToSuppliers, paidToSuppliers } = suppliers;
  const openingCashBalance = settings?.openingCashBalance ?? SETTING_DEFAULTS.openingCashBalance;
  const cashBalance = cashAfter(openingCashBalance, {
    salesReceived: sales?.received ?? 0,
    customerPayments: receivedFromCustomers,
    refunds: sales?.refunded ?? 0,
    supplierPayments: paidToSuppliers,
    expenses: expenses?.paid ?? 0,
  });
  return { cashBalance, debts: { owedToShop, owedByShop, owedToSuppliers } };
}

// Value of the stock. The shop-wide summary also includes its cash, debts and capital.
router.get('/valuation', allow('reports'), async (req, res) => {
  const { Product, StockCount } = req.models;
  const category = String(req.query.category ?? '');
  if (category && !mongoose.isObjectIdOrHexString(category)) throw httpError(400, 'اختر القسم');
  const [stock, finances, lastCount] = await Promise.all([
    Product.valuation(category ? { category: new mongoose.Types.ObjectId(category) } : {}),
    category ? null : shopFinances(req.models),
    StockCount.findOne({ status: 'applied' }).sort({ appliedAt: -1 }).select('appliedAt').lean(),
  ]);
  const result = { ...stock, debts: finances?.debts ?? null, lastCountAt: lastCount?.appliedAt ?? null };
  if (finances) {
    const { cashBalance, debts: { owedToShop, owedByShop, owedToSuppliers } } = finances;
    result.cashBalance = cashBalance;
    result.shopCapital = money(stock.capital + cashBalance + owedToShop - owedByShop - owedToSuppliers);
  }
  res.json(result);
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

router.put('/:id', allow('products'), inventoryWrite(async (req, res) => {
  const { Product, Category } = req.models;
  const data = pickEditable(req.body);
  const existing = await Product.findById(req.params.id).lean();
  if (!existing) throw httpError(404, 'المنتج غير موجود');
  checkUnits(data, existing);
  await assertCategoryExists(Category, data.category);
  if ('stock' in data || 'trackStock' in data || 'purchasePrice' in data) {
    const track = 'trackStock' in data ? Product.schema.path('trackStock').cast(data.trackStock) : existing.trackStock;
    if (track) {
      const inventory = inventoryOf(existing);
      if (!existing.trackStock) inventory.stock = 0;
      const stock = Number('stock' in data ? data.stock : existing.stock ?? 0);
      if (Number.isFinite(stock)) {
        const difference = roundQty(stock - inventory.stock);
        const unitCost = Number(data.purchasePrice ?? existing.purchasePrice);
        if (difference < 0) takeStock(inventory, -difference, unitCost);
        if (difference > 0) addStock(inventory, difference, unitCost);
        Object.assign(data, inventory);
      }
    } else if (existing.trackStock) {
      data.stockLots = [];
    }
  }
  const product = await Product.findByIdAndUpdate(req.params.id, data, {
    returnDocument: 'after',
    runValidators: true,
  }).populate('category', 'name');
  if (!product) throw httpError(404, 'المنتج غير موجود');
  res.json(productFor(req.user, product));
}));

router.delete('/:id', allow('owner'), inventoryWrite(async (req, res) => {
  const { Product } = req.models;
  const deleted = await Product.findByIdAndDelete(req.params.id);
  if (!deleted) throw httpError(404, 'المنتج غير موجود');
  res.status(204).end();
}));

export default router;
