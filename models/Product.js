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
  },
  { timestamps: true },
);

productSchema.index({ name: 1 });

export default model('Product', productSchema);
