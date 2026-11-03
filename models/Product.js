import { Schema, model } from 'mongoose';
import { money } from '../lib/util.js';

const productSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'اسم المنتج مطلوب'],
      trim: true,
      maxlength: [120, 'اسم المنتج طويل جدًا'],
    },
    barcode: {
      type: String,
      required: [true, 'رمز الباركود مطلوب'],
      trim: true,
      maxlength: [64, 'رمز الباركود طويل جدًا'],
      unique: true,
    },
    purchasePrice: {
      type: Number,
      required: [true, 'سعر الشراء مطلوب'],
      min: [0, 'سعر الشراء لا يمكن أن يكون سالبًا'],
    },
    salePrice: {
      type: Number,
      required: [true, 'سعر البيع مطلوب'],
      min: [0, 'سعر البيع لا يمكن أن يكون سالبًا'],
    },
    category: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      required: [true, 'اختر القسم'],
      index: true,
    },
    // Retail unit: by the piece, or by weight with prices and stock per kilogram
    unit: { type: String, enum: ['piece', 'kg'], default: 'piece' },
    // Optional wholesale price: for a box of `wholesaleQty` pieces, or for `wholesaleQty` kg
    hasWholesale: { type: Boolean, default: false },
    wholesaleQty: { type: Number, min: [0, 'كمية الجملة لا يمكن أن تكون سالبة'] },
    wholesalePrice: { type: Number, min: [0, 'سعر الجملة لا يمكن أن يكون سالبًا'] },
    // Inventory is opt-in per product: only tracked products have their stock counted,
    // in pieces or kilograms (whole pieces are enforced by the route, which knows the unit)
    trackStock: { type: Boolean, default: false },
    stock: { type: Number, default: 0 },
    lowStockAlert: { type: Number, default: 5, min: [0, 'حد التنبيه لا يمكن أن يكون سالبًا'] },
    // On: the cashier cannot sell more than what is in stock. Off: stock may go below zero.
    blockWhenOut: { type: Boolean, default: false },
  },
  { timestamps: true },
);

productSchema.index({ name: 1 });

// What the goods on the shelves are worth: at cost (the shop's money tied up in them) and
// at retail. Only tracked products have a quantity; stock below zero counts as none.
productSchema.statics.valuation = async function valuation(match = {}) {
  const inStock = { $and: ['$trackStock', { $gt: ['$stock', 0] }] };
  const [row] = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        products: { $sum: 1 },
        tracked: { $sum: { $cond: ['$trackStock', 1, 0] } },
        belowZero: { $sum: { $cond: [{ $and: ['$trackStock', { $lt: ['$stock', 0] }] }, 1, 0] } },
        capital: { $sum: { $cond: [inStock, { $multiply: ['$stock', '$purchasePrice'] }, 0] } },
        saleValue: { $sum: { $cond: [inStock, { $multiply: ['$stock', '$salePrice'] }, 0] } },
      },
    },
  ]);
  return {
    products: row?.products ?? 0,
    tracked: row?.tracked ?? 0,
    belowZero: row?.belowZero ?? 0,
    capital: money(row?.capital ?? 0),
    saleValue: money(row?.saleValue ?? 0),
  };
};

export default model('Product', productSchema);
