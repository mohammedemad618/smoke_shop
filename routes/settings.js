import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { logoProblem } from '../lib/logo.js';
import { allow } from '../lib/permissions.js';
import { LOW_STOCK_MAX, RECEIPT_PAPERS, settingsOf } from '../lib/shop-settings.js';
import { setShopNameCache } from '../services/tenants.js';
import { logoVersion } from './shop.js';

// What the owner may change from the settings page, by kind. Each card sends its own
// fields; a field left out keeps its value.
const TEXTS = ['shopName', 'receiptNote', 'timeZone', 'phone', 'address', 'currency'];
const FLAGS = ['receiptShowPhone', 'receiptShowAddress', 'receiptShowCashier', 'autoPrint', 'defaultTrackStock', 'defaultBlockWhenOut'];
const BAD_INPUT = 'البيانات المرسلة غير صالحة';

// Everything, the logo itself included, for the owner's settings page
const view = (doc) => {
  const settings = settingsOf(doc);
  return { ...settings, logoVersion: logoVersion(settings.receiptLogo) };
};

// The request's changes, checked: 400 in Arabic for the first thing wrong
function changesFrom(body) {
  const changes = {};
  for (const key of TEXTS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw httpError(400, BAD_INPUT);
    changes[key] = value.trim();
  }
  if ('shopName' in changes && !changes.shopName) throw httpError(400, 'اكتب اسم المتجر');
  if ('timeZone' in changes && !changes.timeZone) delete changes.timeZone;
  if ('currency' in changes && !changes.currency) throw httpError(400, 'اكتب العملة، مثل: د.ع');
  for (const key of FLAGS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw httpError(400, BAD_INPUT);
    changes[key] = value;
  }
  if (body.receiptPaper !== undefined) {
    if (!RECEIPT_PAPERS.includes(body.receiptPaper)) throw httpError(400, 'مقاس الورق غير صالح');
    changes.receiptPaper = body.receiptPaper;
  }
  if (body.defaultLowStockAlert !== undefined) {
    const value = body.defaultLowStockAlert;
    if (!Number.isInteger(value) || value < 0 || value > LOW_STOCK_MAX) {
      throw httpError(400, `حد التنبيه يجب أن يكون عددًا صحيحًا من 0 إلى ${LOW_STOCK_MAX}`);
    }
    changes.defaultLowStockAlert = value;
  }
  // '' takes the logo away
  if (body.receiptLogo !== undefined) {
    const problem = body.receiptLogo === '' ? null : logoProblem(body.receiptLogo);
    if (problem) throw httpError(400, problem);
    changes.receiptLogo = body.receiptLogo;
  }
  return changes;
}

/*
 * A default for new products applied to the products already there, from the «البيع
 * والمخزون» card: only tracked products, only that one field, in one update; their stock,
 * prices and everything else stay as they are. The value applied is the one saved in the
 * settings; the page sends it too, and a value changed meanwhile (another tab) is refused
 * rather than applied unseen.
 */
const APPLIES = {
  lowStockAlert: { setting: 'defaultLowStockAlert', label: 'حد التنبيه' },
  blockWhenOut: { setting: 'defaultBlockWhenOut', label: 'منع البيع عند نفاد الكمية' },
};
// What a product without the field reads as (models/Product.js): such a product already has
// the default when it is that value
const PRODUCT_DEFAULTS = { lowStockAlert: 5, blockWhenOut: false };
const differs = (field, value) =>
  value === PRODUCT_DEFAULTS[field] ? { [field]: { $exists: true, $ne: value } } : { [field]: { $ne: value } };
const toChange = (field, value) => ({ trackStock: true, ...differs(field, value) });

// The shop's own settings (the one document 'shop'), for its owner. A new name is copied to
// the shop's record in the control database too, for the admin's list. ctx is
// { db, registry, config } for services/tenants.js.
export function createSettingsRouter(ctx) {
  const router = Router();

  router.get('/', allow('owner'), async (req, res) => {
    res.json(view(await req.models.Setting.findById('shop').lean()));
  });

  router.put('/', allow('owner'), async (req, res) => {
    const changes = changesFrom(req.body);
    const settings = await req.models.Setting.findOneAndUpdate(
      { _id: 'shop' },
      { $set: changes },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    if ('shopName' in changes) {
      // The shop's own copy is what counts; the admin's list catching up later is no reason to fail
      await setShopNameCache(ctx, req.tenant._id, settings.shopName).catch((err) => console.error(`Could not copy the name of ${req.tenant.slug}: ${err.message}`));
    }
    res.json(view(settings));
  });

  // How many tracked products each default would change: { tracked, lowStockAlert: { value,
  // toChange }, blockWhenOut: { value, toChange } }, for the confirmation before applying
  router.get('/product-defaults', allow('owner'), async (req, res) => {
    const { Product, Setting } = req.models;
    const settings = settingsOf(await Setting.findById('shop').lean());
    const counts = await Promise.all([
      Product.countDocuments({ trackStock: true }),
      ...Object.entries(APPLIES).map(([field, { setting }]) => Product.countDocuments(toChange(field, settings[setting]))),
    ]);
    const out = { tracked: counts[0] };
    Object.entries(APPLIES).forEach(([field, { setting }], i) => {
      out[field] = { value: settings[setting], toChange: counts[i + 1] };
    });
    res.json(out);
  });

  // Body { field: 'lowStockAlert' | 'blockWhenOut', value: the saved default } ->
  // { field, value, changed }
  router.post('/product-defaults/apply', allow('owner'), async (req, res) => {
    const { Product, Setting } = req.models;
    const field = req.body.field;
    if (!Object.hasOwn(APPLIES, field)) throw httpError(400, 'اختر ما يُطبَّق على المنتجات');
    const { setting, label } = APPLIES[field];
    const value = settingsOf(await Setting.findById('shop').lean())[setting];
    if (req.body.value !== value) {
      throw httpError(409, `تغيّرت قيمة «${label}» المحفوظة من مكان آخر. حدّث الصفحة ثم أعد المحاولة`, 'SETTING_CHANGED');
    }
    const { modifiedCount } = await Product.updateMany(toChange(field, value), { $set: { [field]: value } });
    res.json({ field, value, changed: modifiedCount });
  });

  return router;
}
