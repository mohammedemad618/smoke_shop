import { Schema } from 'mongoose';

// Who made a sale or a return (and a customer's payment, an expense): the signed-in account
// (from its session, never from the request) and its name at that moment, so the record
// still names them if the name changes. Records made before accounts were recorded have none.
export const madeBySchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    name: String,
  },
  { _id: false },
);

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
    // What the line was sold for, after its discount if it had one
    lineTotal: { type: Number, required: true },
    // Money taken off the whole line at the cashier (the «الخصم» permission), kept only when
    // there was some: lineTotal is its amount before (price x quantity, rounded up to the
    // sale's roundingStep) less this, never below what its goods cost (routes/sales.js). Who
    // gave it is who made the sale (madeBy): only that account's session can send it.
    discount: { type: Number, default: undefined },
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
    // The browser's id for this return: sent again, it is not made twice (lib/idempotency.js)
    clientId: String,
    madeBy: { type: madeBySchema, default: undefined },
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
    // The shop's «أصغر فئة نقدية» when this sale was made, kept only when it was on: each
    // line's lineTotal is its price x quantity rounded up to a multiple of it, and a return
    // gives back the difference between the rounded amounts of what was left before and
    // after (routes/sales.js). Without it, lines are as priced and returns proportional.
    roundingStep: { type: Number, default: undefined },
    // Totals above are as sold; reports subtract these to get net figures
    returns: { type: [returnSchema], default: [] },
    returnedTotal: { type: Number, default: 0 },
    returnedCost: { type: Number, default: 0 },
    returnStatus: { type: String, enum: ['partial', 'full'] },
    // The browser's id for this sale (one per cart): sent again after a lost answer, it
    // finds this invoice instead of making a second one (lib/idempotency.js)
    clientId: String,
    madeBy: { type: madeBySchema, default: undefined },
  },
  // Two people returning from the same invoice at once: the second save fails instead of double-counting
  { timestamps: true, optimisticConcurrency: true },
);

saleSchema.index({ createdAt: -1 });
// Reports book a return on the day it was made
saleSchema.index({ 'returns.at': 1 });
// Sparse: invoices and returns made without an id are not in these indexes
saleSchema.index({ clientId: 1 }, { unique: true, sparse: true });
saleSchema.index({ 'returns.clientId': 1 }, { unique: true, sparse: true });

export default saleSchema;
