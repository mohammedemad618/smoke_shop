import { Schema, model } from 'mongoose';

// Items keep a snapshot of name and prices, so editing or deleting a product
// later never changes past invoices.
const saleItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    barcode: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true },
    unitCost: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
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
  },
  { timestamps: true },
);

saleSchema.index({ createdAt: -1 });

export default model('Sale', saleSchema);
