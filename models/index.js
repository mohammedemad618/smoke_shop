// Every shop's collections. The files export schemas, never models: models are bound to one
// shop's database at a time by bindModels(), and routes get them as req.models. Nothing is
// ever registered on mongoose's default connection.
import categorySchema from './Category.js';
import productSchema from './Product.js';
import saleSchema from './Sale.js';
import counterSchema from './Counter.js';
import expenseSchema from './Expense.js';
import customerSchema from './Customer.js';
import debtEntrySchema from './DebtEntry.js';
import stockCountSchema from './StockCount.js';
import purchaseSchema from './Purchase.js';
import settingSchema from './Setting.js';
import userSchema from './User.js';
import { QUERY_MS } from '../lib/limits.js';

// Every read gets QUERY_MS unless it set its own limit (the reports, see lib/limits.js)
const READS = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'countDocuments', 'distinct'];

export function limitQueryTime(schema) {
  schema.pre(READS, function limitQuery() {
    if (this.getOptions().maxTimeMS == null) this.maxTimeMS(QUERY_MS);
  });
  schema.pre('aggregate', function limitAggregate() {
    this.options.maxTimeMS ??= QUERY_MS;
  });
}

// Model name -> schema; refs between models name these keys
export const SCHEMAS = Object.freeze({
  Category: categorySchema,
  Product: productSchema,
  Sale: saleSchema,
  Counter: counterSchema,
  Expense: expenseSchema,
  Customer: customerSchema,
  DebtEntry: debtEntrySchema,
  StockCount: stockCountSchema,
  Purchase: purchaseSchema,
  Setting: settingSchema,
  User: userSchema,
});
for (const schema of Object.values(SCHEMAS)) limitQueryTime(schema);

// The models of SCHEMAS on one connection (a shop's database). Binding touches nothing in the
// database: the connection is opened with autoCreate and autoIndex off, and initModels()
// builds the indexes when the shop is first used (lib/db.js).
export function bindModels(conn, schemas = SCHEMAS) {
  return Object.freeze(Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, conn.model(name, schema)])));
}

// Builds the indexes (unique barcode, category name, invoice numbers...). Safe to repeat.
export async function initModels(models) {
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
}
