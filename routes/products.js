import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Category from '../models/Category.js';
import { httpError } from '../lib/errors.js';
import { escapeRegex } from '../lib/util.js';

const router = Router();
const EDITABLE = [
  'name',
  'barcode',
  'purchasePrice',
  'salePrice',
  'category',
  'trackStock',
  'stock',
  'lowStockAlert',
  'blockWhenOut',
];

const pickEditable = (body) =>
  Object.fromEntries(EDITABLE.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

async function assertCategoryExists(id) {
  if (id === undefined) return;
  if (!mongoose.isObjectIdOrHexString(id) || !(await Category.exists({ _id: id }))) {
    throw httpError(400, 'اختر القسم');
  }
}

router.get('/', async (req, res) => {
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
  res.json(products);
});

router.get('/barcode/:code', async (req, res) => {
  const product = await Product.findOne({ barcode: req.params.code.trim() }).populate('category', 'name').lean();
  if (!product) throw httpError(404, 'لا يوجد منتج بهذا الباركود');
  res.json(product);
});

router.post('/', async (req, res) => {
  const data = pickEditable(req.body);
  await assertCategoryExists(data.category);
  const product = await Product.create(data);
  await product.populate('category', 'name');
  res.status(201).json(product);
});

router.put('/:id', async (req, res) => {
  const data = pickEditable(req.body);
  await assertCategoryExists(data.category);
  const product = await Product.findByIdAndUpdate(req.params.id, data, {
    returnDocument: 'after',
    runValidators: true,
  }).populate('category', 'name');
  if (!product) throw httpError(404, 'المنتج غير موجود');
  res.json(product);
});

router.delete('/:id', async (req, res) => {
  const deleted = await Product.findByIdAndDelete(req.params.id);
  if (!deleted) throw httpError(404, 'المنتج غير موجود');
  res.status(204).end();
});

export default router;
