import { Router } from 'express';

const router = Router();

// The shop's name, receipt note, phone and address, for the header, the tab title and the
// receipt. Signed in only; the sign-in page gets the name alone (GET /api/auth/shop).
router.get('/', async (req, res) => {
  const settings = await req.models.Setting.findById('shop').lean();
  res.json({
    shopName: settings?.shopName ?? '',
    receiptNote: settings?.receiptNote ?? '',
    phone: settings?.phone ?? '',
    address: settings?.address ?? '',
  });
});

export default router;
