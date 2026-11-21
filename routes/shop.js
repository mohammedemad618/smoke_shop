import { createHash } from 'node:crypto';
import { Router } from 'express';
import { allow } from '../lib/permissions.js';
import { settingsOf, SETTING_DEFAULTS } from '../lib/shop-settings.js';

const router = Router();

// Which logo the shop has now, as a short tag that changes with the image ('' for none), so
// a page that keeps the logo asks for it again only when it changed
export const logoVersion = (logo) => (logo ? createHash('sha256').update(logo).digest('base64url').slice(0, 16) : '');

// What every signed-in account reads of the shop's settings: the header and tab title, the
// receipt and how it prints, the currency shown next to totals, and what a new product
// starts with in the product form, and the step sale lines are rounded up to (roundingStep)
// when the owner turned that on: left out while it is off, so a shop that does not round
// reads exactly as before (the pages read a missing one as 0). The logo itself is left out
// (up to 64 KB, and every page loads this): GET /logo below has it. Reports use the shop's time zone.
export function shopView(doc) {
  const shop = settingsOf(doc);
  const version = logoVersion(shop.receiptLogo);
  delete shop.receiptLogo;
  if (shop.timeZone === SETTING_DEFAULTS.timeZone) delete shop.timeZone;
  delete shop.openingCashBalance;
  if (!shop.roundingStep) delete shop.roundingStep;
  return { ...shop, logoVersion: version };
}

// Signed in only; the sign-in page gets the name alone (GET /api/auth/shop)
router.get('/', allow('selling'), async (req, res) => {
  res.json(shopView(await req.models.Setting.findById('shop').lean()));
});

// The receipt's logo, for the cashier page: { receiptLogo } as a data: URL, or '' for none
router.get('/logo', allow('selling'), async (req, res) => {
  const settings = await req.models.Setting.findById('shop').select('receiptLogo').lean();
  res.json({ receiptLogo: settings?.receiptLogo ?? '' });
});

export default router;
