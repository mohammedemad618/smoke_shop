import { Schema } from 'mongoose';
import { madeBySchema } from './Sale.js';

// Money spent outside buying stock (food, rent, electricity...). Reports subtract it
// from the profit on sales to give the net profit.
const expenseSchema = new Schema(
  {
    date: { type: Date, required: [true, 'تاريخ المصروف مطلوب'], index: true },
    amount: {
      type: Number,
      required: [true, 'مبلغ المصروف مطلوب'],
      validate: { validator: (v) => Number.isFinite(v) && v > 0, message: 'مبلغ المصروف يجب أن يكون أكبر من صفر' },
    },
    category: {
      type: String,
      required: [true, 'نوع المصروف مطلوب'],
      trim: true,
      maxlength: [40, 'نوع المصروف طويل جدًا'],
    },
    note: { type: String, trim: true, maxlength: [200, 'الملاحظة طويلة جدًا'], default: '' },
    // Who recorded it and who changed it last (lib/auth.js madeByOf); expenses from before
    // accounts were recorded have neither
    madeBy: { type: madeBySchema, default: undefined },
    editedBy: { type: madeBySchema, default: undefined },
  },
  { timestamps: true },
);

export default expenseSchema;
