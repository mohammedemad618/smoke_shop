import { Schema } from 'mongoose';

// Items keep a snapshot of name and prices, so editing or deleting a product
// later never changes past invoices.
const saleItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    barcode: { type: String, required: true },
    // How this line was sold: retail by the piece or kg, or wholesale packs of `packSize`
    // pieces/kg. quantity, unitPrice and unitCost are all per sold unit (piece, kg or pack).
    unit: { type: String, enum: ['piece', 'kg'], default: 'piece' },
    mode: { type: String, enum: ['retail', 'wholesale'], default: 'retail' },
    packSize: { type: Number, default: 1 },
    quantity: { type: Number, required: true, min: 0.001 },
    unitPrice: { type: Number, required: true },
    unitCost: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    returnedQuantity: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

// One return (refund) against the invoice: what came back and the money paid out
const returnSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    items: [
      {
        _id: false,
        product: { type: Schema.Types.ObjectId, ref: 'Product' },
        name: String,
        unit: String,
        mode: String,
        packSize: Number,
        quantity: Number,
        amount: Number,
      },
    ],
    amount: { type: Number, required: true },
    cost: { type: Number, required: true },
    // Part of amount taken off the customer's debt instead of paid back in cash
    toAccount: { type: Number, default: 0 },
  },
  { _id: false },
);

const saleSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    items: {
      type: [saleItemSchema],
      validate: [(items) => items.length > 0, 'الفاتورة فارغة'],
    },
    total: { type: Number, required: true },
    cost: { type: Number, required: true },
    profit: { type: Number, required: true },
    paid: { type: Number, required: true },
    change: { type: Number, required: true },
    // Credit: `paid` is what was paid now and `debt` (total - paid) went on the customer's account
    paymentType: { type: String, enum: ['cash', 'credit'], default: 'cash' },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: String,
    debt: { type: Number, default: 0 },
    // Totals above are as sold; reports subtract these to get net figures
    returns: { type: [returnSchema], default: [] },
    returnedTotal: { type: Number, default: 0 },
    returnedCost: { type: Number, default: 0 },
    returnStatus: { type: String, enum: ['partial', 'full'] },
  },
  // Two people returning from the same invoice at once: the second save fails instead of double-counting
  { timestamps: true, optimisticConcurrency: true },
);

saleSchema.index({ createdAt: -1 });
// Reports book a return on the day it was made
saleSchema.index({ 'returns.at': 1 });

export default saleSchema;
