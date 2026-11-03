import { Schema, model } from 'mongoose';

// One product as found on the shelf. `expected` is what the system had when it was
// counted (null: its quantity was not tracked yet). Applying adds the difference rather
// than overwriting, so sales made between counting and applying are not lost.
const lineSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: String,
    barcode: String,
    unit: { type: String, enum: ['piece', 'kg'], default: 'piece' },
    category: { type: Schema.Types.ObjectId, ref: 'Category' },
    expected: { type: Number, default: null },
    counted: { type: Number, required: true, min: 0 },
    purchasePrice: Number,
    salePrice: Number,
    countedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// A stocktake: counted over as many sittings as needed while open, then applied once
const stockCountSchema = new Schema(
  {
    status: { type: String, enum: ['open', 'applied'], default: 'open' },
    lines: { type: [lineSchema], default: [] },
    appliedAt: Date,
    // Filled in when applied; values are at purchase price
    summary: {
      counted: Number,
      shortItems: Number,
      shortValue: Number,
      overItems: Number,
      overValue: Number,
      newlyTracked: Number,
      // The whole shop's goods right after applying
      capital: Number,
      saleValue: Number,
    },
  },
  { timestamps: true },
);

// Only one stocktake can be open at a time
stockCountSchema.index({ status: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
stockCountSchema.index({ appliedAt: -1 });

export default model('StockCount', stockCountSchema);
