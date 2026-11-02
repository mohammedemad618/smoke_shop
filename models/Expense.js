import { Schema, model } from 'mongoose';

// Money spent outside buying stock (food, rent, electricity...). Reports subtract it
// from the profit on sales to give the net profit.
const expenseSchema = new Schema(
  {
    date: { type: Date, required: [true, 'تاريخ المصروف مطلوب'], index: true },
    amount: {
      type: Number,
      required: [true, 'مبلغ المصروف مطلوب'],
      validate: { validator: (v) => v > 0, message: 'مبلغ المصروف يجب أن يكون أكبر من صفر' },
    },
    category: {
      type: String,
      required: [true, 'نوع المصروف مطلوب'],
      trim: true,
      maxlength: [40, 'نوع المصروف طويل جدًا'],
    },
    note: { type: String, trim: true, maxlength: [200, 'الملاحظة طويلة جدًا'], default: '' },
  },
  { timestamps: true },
);

expenseSchema.statics.totalBetween = async function totalBetween(start, end) {
  const [row] = await this.aggregate([
    { $match: { date: { $gte: start, $lt: end } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row?.total ?? 0;
};

export default model('Expense', expenseSchema);
