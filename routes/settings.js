import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { allow } from '../lib/permissions.js';
import { setShopNameCache } from '../services/tenants.js';

// What the owner may change from the settings page. The currency is a display label set
// when the shop is made, and stays out of it for now.
const FIELDS = ['shopName', 'receiptNote', 'timeZone', 'phone', 'address'];
const view = (s) => ({
  shopName: s?.shopName ?? '',
  receiptNote: s?.receiptNote ?? '',
  timeZone: s?.timeZone ?? 'Asia/Baghdad',
  currency: s?.currency ?? 'د.ع',
  phone: s?.phone ?? '',
  address: s?.address ?? '',
});

// The shop's own settings (the one document 'shop'), for its owner. A new name is copied to
// the shop's record in the control database too, for the admin's list. ctx is
// { db, registry, config } for services/tenants.js.
export function createSettingsRouter(ctx) {
  const router = Router();

  router.get('/', allow('settings'), async (req, res) => {
    res.json(view(await req.models.Setting.findById('shop').lean()));
  });

  router.put('/', allow('settings'), async (req, res) => {
    const changes = {};
    for (const key of FIELDS) {
      const value = req.body[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw httpError(400, 'البيانات المرسلة غير صالحة');
      changes[key] = value.trim();
    }
    if ('shopName' in changes && !changes.shopName) throw httpError(400, 'اكتب اسم المتجر');
    if ('timeZone' in changes && !changes.timeZone) delete changes.timeZone;
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

  return router;
}
