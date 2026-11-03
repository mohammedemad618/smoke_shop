import { Schema, model } from 'mongoose';

// Someone who can buy on credit. What they owe is the sum of their DebtEntry records.
const customerSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'اسم الزبون مطلوب'],
      trim: true,
      maxlength: [80, 'اسم الزبون طويل جدًا'],
    },
    phone: { type: String, trim: true, maxlength: [30, 'رقم الهاتف طويل جدًا'], default: '' },
    note: { type: String, trim: true, maxlength: [200, 'الملاحظة طويلة جدًا'], default: '' },
  },
  { timestamps: true },
);

export default model('Customer', customerSchema);
