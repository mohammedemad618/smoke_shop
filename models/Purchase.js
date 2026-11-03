import { Schema } from 'mongoose';
import { money } from '../lib/util.js';

// One product received. It is bought by the piece or kilo (packSize 1), or by the box
// or sack of the product's wholesale size. `stockQty` is what went into the stock and
// `unitCost` the cost of one piece or kilo, which became the product's purchase price.
// The prices before are kept to put them back if the invoice is cancelled.
const itemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    barcode: String,
    unit: { type: String, enum: ['piece', 'kg'], default: 'piece' },
    mode: { type: String, enum: ['unit', 'pack'], default: 'unit' },
    packSize: { type: Number, default: 1 },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    total: { type: Number, required: true },
    stockQty: { type: Number, required: true },
    unitCost: { type: Number, required: true },
    // A free item (price 0) leaves the product's purchase price as it was
    priceUpdated: { type: Boolean, default: false },
    prevPurchasePrice: Number,
    // Set when the sale price was changed from this invoice
    salePrice: { type: Number, default: null },
    prevSalePrice: Number,
    // The product's quantity was not tracked before; it starts from this purchase
    startedTracking: { type: Boolean, default: false },
  },
  { _id: false },
);

const paymentSchema = new Schema({
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
});

// A supplier's invoice: the goods go into the stock when it is saved. What was not paid
// yet is owed to the supplier and is paid off later, in one go or in parts.
const purchaseSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    date: { type: Date, required: [true, 'تاريخ الفاتورة مطلوب'], index: true },
    supplier: { type: String, trim: true, maxlength: [80, 'اسم المورد طويل جدًا'], default: '' },
    reference: { type: String, trim: true, maxlength: [40, 'رقم فاتورة المورد طويل جدًا'], default: '' },
    note: { type: String, trim: true, maxlength: [200, 'الملاحظة طويلة جدًا'], default: '' },
    items: { type: [itemSchema], required: true },
    total: { type: Number, required: true },
    paid: { type: Number, default: 0 },
    payments: { type: [paymentSchema], default: [] },
    status: { type: String, enum: ['active', 'cancelled'], default: 'active', index: true },
    cancelledAt: Date,
    // The browser's id for this invoice: saved twice, it is still one (lib/idempotency.js)
    clientId: String,
  },
  { timestamps: true, optimisticConcurrency: true },
);

purchaseSchema.index({ clientId: 1 }, { unique: true, sparse: true });

// What the shop still owes its suppliers on the invoices that stand
purchaseSchema.statics.owedToSuppliers = async function owedToSuppliers() {
  const [row] = await this.aggregate([
    { $match: { status: 'active' } },
    { $group: { _id: null, owed: { $sum: { $subtract: ['$total', '$paid'] } } } },
  ]);
  return money(row?.owed ?? 0);
};

export default purchaseSchema;
