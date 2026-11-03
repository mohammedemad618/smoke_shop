import { Router } from 'express';

const router = Router();

// The shop's name and receipt note, for the header, the tab title and the receipt. Public
// within the shop's own address: it shows on the sign-in page too (a later phase).
router.get('/', async (req, res) => {
  const settings = await req.models.Setting.findById('shop').lean();
  res.json({ shopName: settings?.shopName ?? '', receiptNote: settings?.receiptNote ?? '' });
});

export default router;
