import { Router } from 'express';
import { httpError } from '../lib/errors.js';

const router = Router();

router.get('/', async (req, res) => {
  const { Category, Product } = req.models;
  const [categories, counts] = await Promise.all([
    Category.find().collation({ locale: 'ar' }).sort({ name: 1 }).lean(),
    Product.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }]),
  ]);
  const countById = new Map(counts.map((c) => [String(c._id), c.count]));
  res.json(categories.map((c) => ({ ...c, productCount: countById.get(String(c._id)) ?? 0 })));
});

router.post('/', async (req, res) => {
  const { Category } = req.models;
  const category = await Category.create({ name: req.body.name });
  res.status(201).json({ ...category.toObject(), productCount: 0 });
});

router.put('/:id', async (req, res) => {
  const { Category } = req.models;
  const category = await Category.findByIdAndUpdate(
    req.params.id,
    { name: req.body.name },
    { returnDocument: 'after', runValidators: true },
  );
  if (!category) throw httpError(404, 'القسم غير موجود');
  res.json(category);
});

router.delete('/:id', async (req, res) => {
  const { Category, Product } = req.models;
  if (await Product.exists({ category: req.params.id })) {
    throw httpError(409, 'لا يمكن حذف قسم يحتوي على منتجات. انقل منتجاته أو احذفها أولًا');
  }
  const deleted = await Category.findByIdAndDelete(req.params.id);
  if (!deleted) throw httpError(404, 'القسم غير موجود');
  res.status(204).end();
});

export default router;
