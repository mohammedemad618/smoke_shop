// Adds a few sample categories and products to an empty database:  npm run seed
import mongoose from 'mongoose';
import { MONGODB_URI } from '../lib/config.js';
import Category from '../models/Category.js';
import Product from '../models/Product.js';
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

await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

if ((await Category.countDocuments()) > 0 || (await Product.countDocuments()) > 0) {
  console.log('Database already has data, sample data was not added.');
} else {
  let serial = 1;
  let productCount = 0;
  for (const [name, items] of Object.entries(SAMPLE)) {
    const category = await Category.create({ name });
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
  console.log(`Added ${Object.keys(SAMPLE).length} categories and ${productCount} products.`);
}

await mongoose.disconnect();
