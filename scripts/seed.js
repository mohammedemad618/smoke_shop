// Adds a few sample categories and products to a shop that has no products yet:
//   npm run seed -- --tenant <slug>
import { parseArgs } from 'node:util';
import { loadConfig } from '../lib/config.js';
import { openDatabases } from '../lib/db.js';
import { ean13 } from '../public/js/barcode.js';

const SAMPLE = {
  'مشروبات': [
    ['مياه معدنية 500 مل', 150, 250],
    ['عصير برتقال 1 لتر', 900, 1250],
    ['مشروب غازي علبة', 350, 500],
    ['شاي أسود 100 كيس', 2750, 3500],
  ],
  'معلبات': [
    ['تونة قطع 160 غ', 1100, 1500],
    ['فول مدمس 400 غ', 600, 850],
    ['معجون طماطم 400 غ', 700, 1000],
  ],
  'منظفات': [
    ['سائل جلي 750 مل', 1600, 2250],
    ['مسحوق غسيل 1 كغ', 3200, 4000],
    ['مناديل ورقية 200 منديل', 900, 1250],
  ],
};

const { values: args } = parseArgs({ options: { tenant: { type: 'string' } } });
if (!args.tenant) {
  console.log('Usage: npm run seed -- --tenant <slug>');
  process.exit(1);
}

const db = await openDatabases(loadConfig());
try {
  const tenant = await db.controlModels.Tenant.findOne({ slug: args.tenant }).lean();
  if (!tenant) throw new Error(`No shop with the address "${args.tenant}" (npm run tenant:create first)`);
  const { Category, Product } = await db.tenantModels(tenant);
  // Every shop starts with the category «عام», so only products tell it is in use
  if ((await Product.countDocuments()) > 0) {
    console.log('This shop already has products, sample data was not added.');
  } else {
    let serial = 1;
    let productCount = 0;
    for (const [name, items] of Object.entries(SAMPLE)) {
      const category = (await Category.findOne({ name })) ?? (await Category.create({ name }));
      await Product.insertMany(
        items.map(([productName, purchasePrice, salePrice]) => ({
          name: productName,
          barcode: ean13(`200000000${String(serial++).padStart(3, '0')}`),
          purchasePrice,
          salePrice,
          category: category._id,
        })),
      );
      productCount += items.length;
    }
    console.log(`Added ${Object.keys(SAMPLE).length} categories and ${productCount} products to ${tenant.slug}.`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
