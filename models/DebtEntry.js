import mongoose, { Schema, model } from 'mongoose';
import { money } from '../lib/util.js';

// One line of a customer's account. amount is signed: + adds to what they owe,
// - takes it off. Their balance is the sum of all their entries.
const debtEntrySchema = new Schema(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    // sale: bought on credit; manual: debt added by hand (e.g. from before this system);
    // payment: the customer paid; return: goods returned from a credit sale
    kind: { type: String, enum: ['sale', 'manual', 'payment', 'return'], required: true },
    amount: { type: Number, required: true },
    sale: { type: Schema.Types.ObjectId, ref: 'Sale' },
    saleNumber: Number,
    note: { type: String, trim: true, maxlength: [200, 'الملاحظة طويلة جدًا'], default: '' },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

debtEntrySchema.statics.balanceOf = async function balanceOf(customerId) {
  const [row] = await this.aggregate([
    { $match: { customer: new mongoose.Types.ObjectId(String(customerId)) } },
    { $group: { _id: null, balance: { $sum: '$amount' } } },
  ]);
  return money(row?.balance ?? 0);
};

export default model('DebtEntry', debtEntrySchema);
