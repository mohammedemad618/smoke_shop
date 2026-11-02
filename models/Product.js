import { Schema, model } from 'mongoose';

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

export default model('Product', productSchema);
