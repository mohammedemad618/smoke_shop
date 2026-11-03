import { fileURLToPath } from 'node:url';
import express from 'express';
import { errorHandler } from './lib/errors.js';
import { tenancy, attachModels } from './lib/tenancy.js';
import { createAdminRouter } from './admin/router.js';
import shopRouter from './routes/shop.js';
import categoriesRouter from './routes/categories.js';
import productsRouter from './routes/products.js';
import salesRouter from './routes/sales.js';
import expensesRouter from './routes/expenses.js';
import customersRouter from './routes/customers.js';
import stockCountsRouter from './routes/stockcounts.js';
import purchasesRouter from './routes/purchases.js';

// One shop's app, on its own address: the same pages and API as before, with the shop's
// models on req.models
function createTenantRouter({ db }) {
  const router = express.Router();

  // Files first: a page, a script or the camera decoder never opens the shop's database
  router.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
  // Camera barcode decoder, loaded on demand by public/js/scanner.js (works offline)
  router.use('/vendor/zxing-wasm', express.static(fileURLToPath(new URL('./node_modules/zxing-wasm/dist', import.meta.url))));

  router.use(express.json({ limit: '200kb' }));
  // Express 5 leaves req.body undefined when the request had no JSON body
  router.use((req, res, next) => {
    req.body ??= {};
    next();
  });

  const models = attachModels(db);
  router.use('/api/shop', models, shopRouter);
  // A later phase checks the shop session here, before anything below reads the shop's data
  router.use('/api', models);
  router.use('/api/categories', categoriesRouter);
  router.use('/api/products', productsRouter);
  router.use('/api/sales', salesRouter);
  router.use('/api/expenses', expensesRouter);
  router.use('/api/customers', customersRouter);
  router.use('/api/stockcounts', stockCountsRouter);
  router.use('/api/purchases', purchasesRouter);
  router.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
  return router;
}

// The Express app, without the connection or the port (server.js does those), so the tests
// can run it in-process. The Host header picks the admin panel or a shop (lib/tenancy.js).
export function createApp({ db, registry, config }) {
  const app = express();
  app.use(
    tenancy({
      registry,
      adminHost: config.adminHost,
      baseDomains: config.tenantBaseDomains,
      adminRouter: createAdminRouter({ db, registry, config }),
      tenantRouter: createTenantRouter({ db }),
    }),
  );
  app.use(errorHandler);
  return app;
}
