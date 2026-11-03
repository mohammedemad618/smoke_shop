import { fileURLToPath } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import { PORT, HOST, MONGODB_URI } from './lib/config.js';
import { errorHandler } from './lib/errors.js';
import categoriesRouter from './routes/categories.js';
import productsRouter from './routes/products.js';
import salesRouter from './routes/sales.js';
import expensesRouter from './routes/expenses.js';
import customersRouter from './routes/customers.js';

const app = express();

app.use(express.json({ limit: '200kb' }));
// Express 5 leaves req.body undefined when the request had no JSON body
app.use((req, res, next) => {
  req.body ??= {};
  next();
});
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
// Camera barcode decoder, loaded on demand by public/js/scanner.js (works offline)
app.use('/vendor/zxing-wasm', express.static(fileURLToPath(new URL('./node_modules/zxing-wasm/dist', import.meta.url))));

app.use('/api/categories', categoriesRouter);
app.use('/api/products', productsRouter);
app.use('/api/sales', salesRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/customers', customersRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
app.use(errorHandler);

try {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  // Make sure unique indexes (barcode, category name, invoice number) exist before serving
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
} catch (err) {
  console.error(`Could not connect to MongoDB at ${MONGODB_URI}`);
  console.error('Make sure the MongoDB service is running, or set MONGODB_URI in .env');
  console.error(err.message);
  process.exit(1);
}

app.listen(PORT, HOST, () => {
  console.log(`POS running at http://${HOST ?? 'localhost'}:${PORT}`);
});
